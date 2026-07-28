/**
 * The two flows that run entirely on components and modals: reporting a message
 * and appealing a warning.
 */
import { interaction, openTestDatabase, stubFetch, TEST_GUILD, TEST_USER } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { InteractionResponseType, InteractionType } from 'discord-interactions';
import { content } from '../src/content.js';
import { effectiveSettings, updateSettings } from '../src/db/settings.js';
import { ACTION_DELETED, recordViolation } from '../src/db/violations.js';
import { setGatewayClient } from '../src/gateway/client.js';
import { routeInteraction } from '../src/interactions/router.js';
import { appealComponents } from '../src/moderation/appeal.js';

await openTestDatabase();

const LOG_CHANNEL = '820000000000000001';
const CHANNEL = '830000000000000001';
const MESSAGE = '840000000000000001';
const AUTHOR = '850000000000000001';
const STAFF_PERMISSIONS = String(1n << 13n);

updateSettings(TEST_GUILD, { 'log-channel': LOG_CHANNEL });

/**
 * Captures what Mai posts to Discord, and lets a test drive the gateway client
 * the handlers reach for.
 */
function stubGateway({ deleteFails = false, channelGuildId = TEST_GUILD } = {}) {
  const sent = [];
  const deleted = [];

  setGatewayClient({
    channels: {
      fetch: async (id) => ({
        id,
        // Which guild the channel is in: `report-approve` proves the target
        // sits in the clicker's guild before deleting through it.
        guildId: channelGuildId,
        isTextBased: () => true,
        send: async (payload) => sent.push({ channelId: id, ...payload }),
        messages: {
          delete: async (messageId) => {
            if (deleteFails) throw new Error('Missing Permissions');
            deleted.push(messageId);
          },
        },
      }),
    },
  });

  return { sent, deleted };
}

const member = (id, permissions = '0') => ({ user: { id, username: 'tester' }, permissions });

const contextMenu = (reporterId = TEST_USER) =>
  interaction({
    type: InteractionType.APPLICATION_COMMAND,
    channel_id: CHANNEL,
    member: member(reporterId),
    data: {
      name: 'Nachricht melden',
      type: 3,
      target_id: MESSAGE,
      resolved: { messages: { [MESSAGE]: { id: MESSAGE, author: { id: AUTHOR } } } },
    },
  });

const modalSubmit = (customId, value, reporterId = TEST_USER) =>
  interaction({
    type: InteractionType.MODAL_SUBMIT,
    member: member(reporterId),
    data: {
      custom_id: customId,
      components: [{ type: 1, components: [{ type: 4, custom_id: 'reason', value }] }],
    },
  });

const route = async (payload) => {
  let body;
  await routeInteraction(payload, (sent) => {
    body = sent;
  });
  return body;
};

test('the context menu opens a modal carrying the message coordinates', async () => {
  const body = await route(contextMenu());

  assert.equal(body.type, InteractionResponseType.MODAL);
  assert.equal(body.data.custom_id, `report:${CHANNEL}:${MESSAGE}:${AUTHOR}`);
  assert.equal(body.data.title, content.commands.report.modalTitle);
  assert.ok(body.data.custom_id.length <= 100, 'custom_id fits Discord\'s limit');

  const input = body.data.components[0].components[0];
  assert.equal(input.required, false, 'a reason is optional');
  assert.equal(input.style, 2, 'paragraph');
});

test('reporting is refused where no moderation log is configured', async () => {
  // The allowlist gate runs first, so this has to be the test guild itself,
  // temporarily without a log channel.
  updateSettings(TEST_GUILD, { 'log-channel': null });
  try {
    const body = await route(contextMenu('890000000000000001'));
    assert.equal(body.data.content, content.commands.report.unavailable);
  } finally {
    updateSettings(TEST_GUILD, { 'log-channel': LOG_CHANNEL });
  }
});

test('reporting is refused in a DM', async () => {
  const payload = contextMenu();
  const body = await route({ ...payload, guild_id: undefined, member: undefined, user: { id: TEST_USER } });

  assert.equal(body.data.content, content.commands.report.guildOnly);
});

test('a submitted report reaches the log channel with review buttons', async () => {
  const { sent } = stubGateway();
  const { body, edits } = await routeDeferred(
    modalSubmit(`report:${CHANNEL}:${MESSAGE}:${AUTHOR}`, 'Werbung'),
  );

  // Deferred, then confirmed by editing the placeholder: publishing the report
  // is two Discord round trips and must not race the 3 s budget.
  assert.equal(body.type, InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE);
  assert.equal(edits.at(-1).body.content, content.commands.report.thanks);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channelId, LOG_CHANNEL);

  const embed = sent[0].embeds[0];
  assert.equal(embed.title, content.moderation.log.titles.reported);
  const value = (label) => embed.fields.find((field) => field.name === label)?.value;
  assert.equal(value(content.moderation.log.fields.reporter), `<@${TEST_USER}>`);
  assert.equal(value(content.moderation.log.fields.user), `<@${AUTHOR}> \`${AUTHOR}\``);
  assert.equal(value(content.moderation.log.fields.reason), 'Werbung');
  assert.match(value(content.moderation.log.fields.message), /discord\.com\/channels/);

  const buttons = sent[0].components[0].components;
  assert.deepEqual(
    buttons.map((button) => button.custom_id),
    [`report-approve:${CHANNEL}:${MESSAGE}`, `report-dismiss:${CHANNEL}:${MESSAGE}`],
  );
});

test('a report without a reason omits the field instead of showing an empty one', async () => {
  const { sent } = stubGateway();
  await routeDeferred(modalSubmit(`report:${CHANNEL}:${MESSAGE}:${AUTHOR}`, '   '));

  const embed = sent[0].embeds[0];
  assert.equal(
    embed.fields.some((field) => field.name === content.moderation.log.fields.reason),
    false,
  );
});

/**
 * Drives an interaction whose handler is deferred: the HTTP response is only a
 * placeholder, and what the member (or the log channel) actually ends up with
 * arrives afterwards as an edit through the interaction webhook.
 *
 * Both flows in this file have one: a staff click on "Löschen" needs a Discord
 * round trip to delete, and both modal submits need two to publish.
 */
async function routeDeferred(payload) {
  const edits = [];
  const restore = stubFetch((url, options) => {
    edits.push({ url, body: JSON.parse(options.body) });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });

  try {
    return { body: await route(payload), edits };
  } finally {
    restore();
  }
}

test('approving deletes the message and edits the entry for everyone', async () => {
  const { deleted } = stubGateway();
  const { body, edits } = await routeDeferred(
    interaction({
      type: InteractionType.MESSAGE_COMPONENT,
      member: member(TEST_USER, STAFF_PERMISSIONS),
      message: { embeds: [{ title: 'x', fields: [{ name: 'a', value: 'b' }] }] },
      data: { custom_id: `report-approve:${CHANNEL}:${MESSAGE}`, component_type: 2 },
    }),
  );

  assert.deepEqual(deleted, [MESSAGE]);
  // Deferred first, so a slow delete cannot blow the 3 s budget…
  assert.equal(body.type, InteractionResponseType.DEFERRED_UPDATE_MESSAGE);

  // …then the entry itself is edited, which is what the other moderators see.
  assert.equal(edits.length, 1);
  assert.match(edits[0].url, /\/messages\/@original$/);
  const edited = edits[0].body;
  assert.deepEqual(edited.components, [], 'buttons are gone once handled');
  assert.equal(edited.embeds[0].title, content.commands.report.titleApproved);
  assert.ok(edited.embeds[0].color > 0, 'the colour changes too');

  const resolution = edited.embeds[0].fields.at(-1);
  assert.equal(resolution.name, content.moderation.log.fields.resolution);
  assert.match(resolution.value, new RegExp(`Gelöscht von <@${TEST_USER}>`));
  assert.equal(edited.embeds[0].fields[0].value, 'b', 'the original fields survive');
});

test('approval refuses a target channel outside the clicking guild', async () => {
  // The channel id rides in the custom_id, but Manage Messages was only checked
  // against the guild the click came from, so a target elsewhere must not be
  // deleted through the bot's client, which can reach every guild Mai is in.
  const { deleted } = stubGateway({ channelGuildId: '999999999999999999' });
  const { edits } = await routeDeferred(
    interaction({
      type: InteractionType.MESSAGE_COMPONENT,
      member: member(TEST_USER, STAFF_PERMISSIONS),
      message: { embeds: [{ title: 'x', fields: [] }] },
      data: { custom_id: `report-approve:${CHANNEL}:${MESSAGE}`, component_type: 2 },
    }),
  );

  assert.deepEqual(deleted, [], 'nothing was deleted in the other guild');

  // Recorded in the entry rather than answered with a refusal: this handler is
  // deferred for staff, so an ephemeral reply would overwrite the log entry.
  const resolution = edits[0].body.embeds[0].fields.at(-1);
  assert.equal(resolution.name, content.moderation.log.fields.resolution);
  assert.equal(
    resolution.value,
    content.commands.report.approvedFailed.replace('{userId}', TEST_USER),
  );
});

test('an undeletable message is recorded as such, not as a failure', async () => {
  stubGateway({ deleteFails: true });
  const { edits } = await routeDeferred(
    interaction({
      type: InteractionType.MESSAGE_COMPONENT,
      member: member(TEST_USER, STAFF_PERMISSIONS),
      message: { embeds: [{ fields: [] }] },
      data: { custom_id: `report-approve:${CHANNEL}:${MESSAGE}`, component_type: 2 },
    }),
  );

  assert.match(edits[0].body.embeds[0].fields.at(-1).value, /nicht mehr löschbar/);
});

test('a second decision replaces the first instead of stacking', async () => {
  stubGateway();
  const alreadyResolved = {
    embeds: [
      {
        fields: [
          { name: content.moderation.log.fields.reporter, value: '<@1>' },
          { name: content.moderation.log.fields.resolution, value: 'Verworfen von <@2>' },
        ],
      },
    ],
  };

  const body = await route(
    interaction({
      type: InteractionType.MESSAGE_COMPONENT,
      member: member(TEST_USER, STAFF_PERMISSIONS),
      message: alreadyResolved,
      data: { custom_id: `report-dismiss:${CHANNEL}:${MESSAGE}`, component_type: 2 },
    }),
  );

  const resolutions = body.data.embeds[0].fields.filter(
    (field) => field.name === content.moderation.log.fields.resolution,
  );
  assert.equal(resolutions.length, 1, 'one decision field, not two');
  assert.match(resolutions[0].value, new RegExp(`<@${TEST_USER}>`));
});

test('dismissing keeps the message and closes the entry', async () => {
  const { deleted } = stubGateway();
  const body = await route(
    interaction({
      type: InteractionType.MESSAGE_COMPONENT,
      member: member(TEST_USER, STAFF_PERMISSIONS),
      message: { embeds: [{ fields: [] }] },
      data: { custom_id: `report-dismiss:${CHANNEL}:${MESSAGE}`, component_type: 2 },
    }),
  );

  assert.deepEqual(deleted, []);
  assert.match(body.data.embeds[0].fields.at(-1).value, /Verworfen/);
});

test('review buttons are staff-only', async () => {
  const { deleted } = stubGateway();

  for (const action of ['report-approve', 'report-dismiss']) {
    const body = await route(
      interaction({
        type: InteractionType.MESSAGE_COMPONENT,
        member: member(TEST_USER, '0'),
        message: { embeds: [{ fields: [] }] },
        data: { custom_id: `${action}:${CHANNEL}:${MESSAGE}`, component_type: 2 },
      }),
    );
    assert.equal(body.data.content, content.commands.forbidden, action);
  }
  assert.deepEqual(deleted, [], 'nothing was deleted by a non-staff click');
});

test('the warning DM only carries an appeal button where appeals can land', () => {
  const since = '2026-07-27T10:00:00.000Z';
  const components = appealComponents(TEST_GUILD, since);

  assert.equal(components.length, 1);
  // The guild *and* the enforcement pass being appealed: a DM has no guild
  // context, and granting later has to know which strikes it overturns.
  assert.equal(
    components[0].components[0].custom_id,
    `appeal:${TEST_GUILD}:${Math.floor(new Date(since).getTime() / 1000)}`,
  );
  assert.ok(components[0].components[0].custom_id.length <= 100, 'Discord caps custom_id at 100');

  assert.deepEqual(appealComponents('870000000000000001', since), [], 'no log channel, no button');
});

test('the appeal button opens a modal carrying the incident forward', async () => {
  const body = await route(
    interaction({
      type: InteractionType.MESSAGE_COMPONENT,
      guild_id: undefined, // the warning arrives as a DM
      member: undefined,
      user: { id: AUTHOR, username: 'author' },
      data: { custom_id: `appeal:${TEST_GUILD}:1785067200`, component_type: 2 },
    }),
  );

  assert.equal(body.type, InteractionResponseType.MODAL);
  assert.equal(body.data.custom_id, `appeal-submit:${TEST_GUILD}:1785067200`);
  assert.equal(body.data.components[0].components[0].required, true);
});

test('a submitted appeal is forwarded to the guild it belongs to', async () => {
  const { sent } = stubGateway();
  const { body, edits } = await routeDeferred(
    interaction({
      type: InteractionType.MODAL_SUBMIT,
      guild_id: undefined,
      member: undefined,
      user: { id: AUTHOR, username: 'author' },
      data: {
        custom_id: `appeal-submit:${TEST_GUILD}`,
        components: [
          { type: 1, components: [{ type: 4, custom_id: 'text', value: 'Das war ein Zitat!' }] },
        ],
      },
    }),
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0].channelId, LOG_CHANNEL);
  const embed = sent[0].embeds[0];
  assert.equal(embed.title, content.moderation.log.titles.appealed);
  assert.equal(
    embed.fields.find((field) => field.name === content.moderation.log.fields.appeal).value,
    'Das war ein Zitat!',
  );

  // Deferred: a member who loses their statement to a timed-out interaction
  // has no way to get it back, and the appeal never reaches staff at all.
  assert.equal(body.type, InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE);
  assert.equal(edits.at(-1).body.content, content.moderation.appeal.submitted);
});

test('an empty appeal is rejected before it reaches staff', async () => {
  const { sent } = stubGateway();
  const { edits } = await routeDeferred(
    interaction({
      type: InteractionType.MODAL_SUBMIT,
      guild_id: undefined,
      member: undefined,
      user: { id: AUTHOR, username: 'author' },
      data: {
        custom_id: `appeal-submit:${TEST_GUILD}`,
        components: [{ type: 1, components: [{ type: 4, custom_id: 'text', value: '  ' }] }],
      },
    }),
  );

  assert.equal(sent.length, 0);
  assert.equal(edits.at(-1).body.content, content.moderation.appeal.empty);
});

/**
 * `/mai appeal`: the same appeal, for a member whose warning DM bounced.
 *
 * Everything the button carries in its `custom_id` has to be reconstructed
 * from the strike record here, and the scope is the whole point: an appeal
 * against one incident must not overturn the strikes before it.
 */
const appealCommand = (userId) =>
  interaction({
    type: InteractionType.APPLICATION_COMMAND,
    member: member(userId),
    data: { name: 'mai', type: 1, options: [{ name: 'appeal', type: 1, options: [] }] },
  });

const strikeAt = (userId, iso, messageId) =>
  recordViolation({
    guildId: TEST_GUILD,
    userId,
    messageId,
    categories: ['harassment'],
    action: ACTION_DELETED,
    createdAt: iso,
  });

test('/mai appeal has nothing to open for a member with a clean record', async () => {
  const body = await route(appealCommand('860000000000000001'));

  assert.equal(body.type, InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
  assert.equal(body.data.content, content.commands.appeal.nothing);
});

test('/mai appeal opens the same modal, scoped to the last enforcement pass', async () => {
  const userId = '860000000000000002';
  const now = Date.now();
  // Two passes: one a week ago, one a moment ago (two messages, seconds apart,
  // the way a single tick writes them).
  strikeAt(userId, new Date(now - 7 * 86_400_000).toISOString(), '861000000000000001');
  strikeAt(userId, new Date(now - 4000).toISOString(), '861000000000000002');
  strikeAt(userId, new Date(now - 2000).toISOString(), '861000000000000003');

  const body = await route(appealCommand(userId));

  assert.equal(body.type, InteractionResponseType.MODAL);
  const [, guildId, since] = body.data.custom_id.split(':');
  assert.equal(guildId, TEST_GUILD);
  assert.ok(body.data.custom_id.length <= 100, 'Discord caps custom_id at 100');

  // The pass, not the record: the older strike is a different incident and this
  // appeal says nothing about it.
  const scoped = Number(since) * 1000;
  assert.ok(scoped <= now - 4000, 'the oldest strike of the pass is included');
  assert.ok(scoped > now - 86_400_000, 'last week is not');
});

test('/mai appeal is refused where an appeal would land nowhere', async () => {
  updateSettings(TEST_GUILD, { 'log-channel': null });
  try {
    const userId = '860000000000000003';
    strikeAt(userId, new Date().toISOString(), '861000000000000004');

    const body = await route(appealCommand(userId));
    assert.equal(body.data.content, content.commands.appeal.unavailable);
  } finally {
    updateSettings(TEST_GUILD, { 'log-channel': LOG_CHANNEL });
  }
});

test('/mai appeal is refused in a DM: an appeal names a guild', async () => {
  const payload = appealCommand('860000000000000004');
  const body = await route({ ...payload, guild_id: undefined, member: undefined, user: { id: '860000000000000004' } });

  assert.equal(body.data.content, content.commands.appeal.guildOnly);
});

test('a strike that no longer counts has nothing left to appeal', async () => {
  const userId = '860000000000000005';
  const settings = effectiveSettings(TEST_GUILD);
  strikeAt(
    userId,
    new Date(Date.now() - (settings.strikeWindowDays + 1) * 86_400_000).toISOString(),
    '861000000000000005',
  );

  const body = await route(appealCommand(userId));
  assert.equal(body.data.content, content.commands.appeal.nothing);
});

test('reports are rate limited per member', async () => {
  const spammer = '880000000000000001';
  const answers = [];
  for (let i = 0; i < 7; i++) {
    answers.push(await route(contextMenu(spammer)));
  }

  const modals = answers.filter((body) => body.type === InteractionResponseType.MODAL);
  assert.equal(modals.length, 5, 'five reports, then the cat gets bored');
  assert.equal(answers.at(-1).data.content, content.commands.report.busy);
});
