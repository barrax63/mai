/**
 * Appeal evidence: the second deliberate exception to the no-content rule.
 *
 * What is worth testing is every limit around it, because the limits are the
 * reason it is allowed to exist at all: opt-in per guild, encrypted at rest,
 * scoped to one incident, staff-only, ephemeral, and gone again in hours.
 */
import './setup-evidence.js';
import { interaction, openTestDatabase, TEST_GUILD, TEST_USER } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { InteractionResponseType, InteractionType } from 'discord-interactions';
import { config } from '../src/config.js';
import { content } from '../src/content.js';
import { getDb } from '../src/db/index.js';
import { clearForUser, count, evidenceFor, pruneOlderThan, recordEvidence } from '../src/db/evidence.js';
import { enqueue } from '../src/db/queue.js';
import { resetSettings, updateSettings } from '../src/db/settings.js';
import { setGatewayClient } from '../src/gateway/client.js';
import { routeInteraction } from '../src/interactions/router.js';
import { appealModals } from '../src/moderation/appeal.js';
import { clearOwnDeletions } from '../src/moderation/cleanup.js';
import { runTick } from '../src/moderation/enforcer.js';

await openTestDatabase();

const CHANNEL = '990000000000000001';
const LOG_CHANNEL = '990000000000000002';
const STAFF_PERMISSIONS = String(1n << 13n);

// Timeouts are not what this file is about.
updateSettings(TEST_GUILD, { escalation: false, 'log-channel': LOG_CHANNEL });

const wipe = () => {
  getDb().exec('DELETE FROM moderation_queue');
  getDb().exec('DELETE FROM evidence');
  getDb().exec('DELETE FROM violations');
  clearOwnDeletions();
};

/** The enforcer's Discord side, plus what Mai posted and deleted. */
function fakeClient() {
  const record = { deleted: [], dms: [], posted: [] };

  const client = {
    channels: {
      fetch: async (channelId) => ({
        id: channelId,
        guildId: TEST_GUILD,
        parentId: null,
        isTextBased: () => true,
        send: async (payload) => record.posted.push({ channelId, ...payload }),
        messages: {
          fetch: async (messageId) => ({
            id: messageId,
            cleanContent: `du bist ein ${messageId}`,
            content: `du bist ein ${messageId}`,
            attachments: { size: 0 },
            createdAt: new Date(),
            delete: async () => record.deleted.push(messageId),
          }),
          delete: async () => {},
        },
      }),
    },
    users: {
      fetch: async (userId) => ({
        send: async (payload) => record.dms.push({ userId, ...payload }),
      }),
    },
  };

  return { client, record };
}

const seed = (messageId) =>
  enqueue({
    messageId,
    guildId: TEST_GUILD,
    channelId: CHANNEL,
    userId: TEST_USER,
    categories: ['harassment'],
    warnedAt: new Date(Date.now() - 900_000).toISOString(),
    dueAt: new Date(Date.now() - 60_000).toISOString(),
    scoldMessageId: null,
  });

const route = async (payload) => {
  let body;
  await routeInteraction(payload, (sent) => {
    body = sent;
  });
  return body;
};

const evidenceClick = (userId, since, permissions = STAFF_PERMISSIONS) =>
  interaction({
    type: InteractionType.MESSAGE_COMPONENT,
    member: { user: { id: '991000000000000001', username: 'staff' }, permissions },
    message: { embeds: [{ fields: [] }] },
    data: { custom_id: `appeal-evidence:${userId}:${since}`, component_type: 2 },
  });

test('nothing is kept unless the guild asked for it', async () => {
  wipe();
  const { client } = fakeClient();
  seed('992000000000000001');

  await runTick(client);
  assert.equal(count(TEST_GUILD), 0, 'evidence is opt-in, per guild');
});

test('an enforced message is kept, encrypted, and read back for the review', async () => {
  wipe();
  updateSettings(TEST_GUILD, { evidence: true });

  try {
    const { client } = fakeClient();
    seed('992000000000000002');
    await runTick(client);

    const kept = evidenceFor(TEST_GUILD, TEST_USER, new Date(Date.now() - 60_000).toISOString());
    assert.equal(kept.length, 1);
    assert.equal(kept[0].content, 'du bist ein 992000000000000002');
    assert.deepEqual(kept[0].categories, ['harassment']);

    // On disk it is ciphertext: the point of the table is that a database dump
    // is not a transcript.
    const raw = getDb().prepare('SELECT content FROM evidence').get().content;
    assert.match(raw, /^v1:/);
    assert.equal(raw.includes('du bist ein'), false);
  } finally {
    resetSettings(TEST_GUILD, 'evidence');
  }
});

test('the button shows one incident, not the member\'s back catalogue', async () => {
  wipe();
  const now = Date.now();
  const older = new Date(now - 7 * 86_400_000).toISOString();
  const incident = new Date(now - 5000).toISOString();

  recordEvidence({
    messageId: '993000000000000001',
    guildId: TEST_GUILD,
    userId: TEST_USER,
    channelId: CHANNEL,
    content: 'die alte sache',
    categories: ['harassment'],
    createdAt: older,
  });
  recordEvidence({
    messageId: '993000000000000002',
    guildId: TEST_GUILD,
    userId: TEST_USER,
    channelId: CHANNEL,
    content: 'worum es hier geht',
    categories: ['harassment'],
    createdAt: incident,
  });

  const body = await route(evidenceClick(TEST_USER, Math.floor(new Date(incident).getTime() / 1000)));

  assert.equal(body.type, InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
  assert.equal(body.data.flags, 64, 'ephemeral: one moderator reads it, not the channel');
  assert.match(body.data.content, /worum es hier geht/);
  assert.equal(
    body.data.content.includes('die alte sache'),
    false,
    'an appeal names one incident, and the review sees exactly that',
  );
});

test('a member without Manage Messages gets nothing', async () => {
  wipe();
  recordEvidence({
    messageId: '993000000000000003',
    guildId: TEST_GUILD,
    userId: TEST_USER,
    channelId: CHANNEL,
    content: 'geheim',
    categories: [],
  });

  const body = await route(evidenceClick(TEST_USER, 0, '0'));
  assert.equal(body.data.content, content.commands.forbidden);
  assert.equal(body.data.content.includes('geheim'), false);
});

test('another guild\'s evidence is not reachable by naming its member', async () => {
  wipe();
  // The clicker controls the custom_id, so the guild must come from the
  // interaction and never from the id: a button is a target, not an authority.
  recordEvidence({
    messageId: '993000000000000004',
    guildId: '994000000000000001',
    userId: TEST_USER,
    channelId: CHANNEL,
    content: 'anderer server',
    categories: [],
  });

  const body = await route(evidenceClick(TEST_USER, 0));
  assert.equal(body.data.content, content.moderation.appeal.evidenceEmpty);
});

test('an expired window leaves the review with an honest answer', async () => {
  wipe();
  recordEvidence({
    messageId: '993000000000000005',
    guildId: TEST_GUILD,
    userId: TEST_USER,
    channelId: CHANNEL,
    content: 'zu alt',
    categories: [],
    createdAt: new Date(Date.now() - 100 * 3_600_000).toISOString(),
  });

  const cutoff = new Date(Date.now() - config.moderation.evidenceHours * 3_600_000).toISOString();
  assert.equal(pruneOlderThan(cutoff), 1);

  const body = await route(evidenceClick(TEST_USER, 0));
  assert.equal(body.data.content, content.moderation.appeal.evidenceEmpty);
});

test('the tick prunes on the retention window', async () => {
  wipe();
  updateSettings(TEST_GUILD, { evidence: true });

  try {
    recordEvidence({
      messageId: '993000000000000006',
      guildId: TEST_GUILD,
      userId: TEST_USER,
      channelId: CHANNEL,
      content: 'alt',
      categories: [],
      createdAt: new Date(Date.now() - (config.moderation.evidenceHours + 1) * 3_600_000).toISOString(),
    });
    recordEvidence({
      messageId: '993000000000000007',
      guildId: TEST_GUILD,
      userId: TEST_USER,
      channelId: CHANNEL,
      content: 'frisch',
      categories: [],
    });

    const { client } = fakeClient();
    await runTick(client);

    assert.equal(count(TEST_GUILD), 1, 'the tick that prunes everything else prunes this too');
  } finally {
    resetSettings(TEST_GUILD, 'evidence');
  }
});

test('a pardon takes the quotes with it', async () => {
  wipe();
  recordEvidence({
    messageId: '993000000000000008',
    guildId: TEST_GUILD,
    userId: TEST_USER,
    channelId: CHANNEL,
    content: 'vergeben',
    categories: [],
  });

  setGatewayClient(null);
  const body = await route(
    interaction({
      type: InteractionType.APPLICATION_COMMAND,
      member: { user: { id: '991000000000000001', username: 'staff' }, permissions: STAFF_PERMISSIONS },
      data: {
        name: 'mod',
        options: [
          {
            name: 'forgive',
            type: 1,
            options: [
              { name: 'user', value: TEST_USER },
              { name: 'strikes', value: true },
            ],
          },
        ],
      },
    }),
  );

  assert.ok(body.data.content, 'the command answered');
  assert.equal(count(TEST_GUILD), 0, 'a pardon that leaves the quotes behind is not a pardon');
});

test('the button is only offered where there is something to show', async () => {
  wipe();
  const posted = [];
  setGatewayClient({
    channels: {
      fetch: async (id) => ({
        id,
        guildId: TEST_GUILD,
        isTextBased: () => true,
        send: async (payload) => posted.push(payload),
      }),
    },
  });

  const submit = (guildId) => ({
    ...interaction({ member: { user: { id: TEST_USER, username: 'tester' }, permissions: '0' } }),
    data: {
      custom_id: `appeal-submit:${guildId}:0`,
      components: [{ type: 1, components: [{ type: 4, custom_id: 'text', value: 'war ein Zitat' }] }],
    },
  });

  const labels = () =>
    (posted.at(-1).components?.[0]?.components ?? []).map((button) => button.label);

  await appealModals['appeal-submit'](submit(TEST_GUILD), [TEST_GUILD, 0]);
  assert.equal(
    labels().includes(content.moderation.appeal.evidenceButton),
    false,
    'evidence is off for this guild, so the button would only ever say "nothing stored"',
  );

  updateSettings(TEST_GUILD, { evidence: true });
  try {
    await appealModals['appeal-submit'](submit(TEST_GUILD), [TEST_GUILD, 0]);
    assert.deepEqual(labels(), [
      content.moderation.appeal.grantButton,
      content.moderation.appeal.denyButton,
      content.moderation.appeal.evidenceButton,
    ]);
  } finally {
    resetSettings(TEST_GUILD, 'evidence');
  }
});

test('clearForUser stays inside the guild it was asked about', () => {
  wipe();
  for (const guildId of [TEST_GUILD, '994000000000000002']) {
    recordEvidence({
      messageId: `99500000000000000${guildId === TEST_GUILD ? 1 : 2}`,
      guildId,
      userId: TEST_USER,
      channelId: CHANNEL,
      content: 'x',
      categories: [],
    });
  }

  assert.equal(clearForUser(TEST_GUILD, TEST_USER), 1);
  assert.equal(count(), 1, 'the other guild is not this guild\'s to clear');
});
