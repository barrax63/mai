/**
 * The per-guild kill switch (`/mod off`) and the escalation toggle.
 */
import { interaction, openTestDatabase, TEST_GUILD, TEST_USER } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { InteractionResponseType, InteractionType } from 'discord-interactions';
import { content } from '../src/content.js';
import { effectiveSettings, isGuildActive, resetSettings, updateSettings } from '../src/db/settings.js';
import { ACTION_DELETED, recordViolation } from '../src/db/violations.js';
import { routeInteraction } from '../src/interactions/router.js';
import { decideEscalation } from '../src/moderation/escalation.js';

await openTestDatabase();

// The allowlist gate runs before the kill switch, so this has to be a guild
// DISCORD_GUILD_IDS actually contains.
const GUILD = TEST_GUILD;
const MEMBER = '670000000000000001';
const STAFF = { user: { id: TEST_USER, username: 'staff' }, permissions: String(1n << 13n) };
const PLAIN = { user: { id: TEST_USER, username: 'member' }, permissions: '0' };

const route = async (payload) => {
  let body;
  await routeInteraction(payload, (sent) => {
    body = sent;
  });
  return body;
};

const command = (options, member = STAFF, name = 'mod') =>
  interaction({ type: InteractionType.APPLICATION_COMMAND, guild_id: GUILD, member, data: { name, options } });

test('a guild is active until someone switches it off', () => {
  assert.equal(isGuildActive(GUILD), true);
  assert.equal(isGuildActive(null), true, 'a DM has no guild to pause');

  updateSettings(GUILD, { enabled: false });
  assert.equal(isGuildActive(GUILD), false);

  updateSettings(GUILD, { enabled: true });
  assert.equal(isGuildActive(GUILD), true);
});

test('the flag is stored as 1/0, because SQLite has no booleans', () => {
  updateSettings(GUILD, { enabled: false });
  assert.equal(effectiveSettings(GUILD).enabled, false);
  assert.equal(effectiveSettings(GUILD).inherited.enabled, false, 'explicitly set');

  resetSettings(GUILD, 'enabled');
  assert.equal(effectiveSettings(GUILD).enabled, true);
  assert.equal(effectiveSettings(GUILD).inherited.enabled, true, 'back to the default');
});

test('a non-boolean value is refused', () => {
  for (const bad of ['vielleicht', 2, {}]) {
    assert.throws(() => updateSettings(GUILD, { enabled: bad }), RangeError, `accepted ${bad}`);
  }
});

test('/mod off pauses, /mod on resumes, and repeats say so', async () => {
  const off = await route(command([{ name: 'off', type: 1 }]));
  assert.equal(off.data.content, content.commands.power.off);
  assert.equal(isGuildActive(GUILD), false);

  const offAgain = await route(command([{ name: 'off', type: 1 }]));
  assert.equal(offAgain.data.content, content.commands.power.offAlready);

  const on = await route(command([{ name: 'on', type: 1 }]));
  assert.equal(on.data.content, content.commands.power.on);
  assert.equal(isGuildActive(GUILD), true);

  const onAgain = await route(command([{ name: 'on', type: 1 }]));
  assert.equal(onAgain.data.content, content.commands.power.onAlready);
});

test('the kill switch is staff-only', async () => {
  const body = await route(command([{ name: 'off', type: 1 }], PLAIN));

  assert.equal(body.data.content, content.commands.forbidden);
  assert.equal(isGuildActive(GUILD), true, 'nothing was switched off');
});

test('while paused, other commands are refused but /mod still answers', async () => {
  updateSettings(GUILD, { enabled: false });
  try {
    const ping = await route(command([], PLAIN, 'ping'));
    assert.equal(ping.data.content, content.commands.paused);

    const ask = await route(
      command([{ name: 'ask', type: 1, options: [{ name: 'frage', value: 'hallo?' }] }], PLAIN, 'mai'),
    );
    assert.equal(ask.data.content, content.commands.paused);
    assert.notEqual(
      ask.type,
      InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      'refused before the model call',
    );

    // Otherwise the only way back would be editing the database.
    const status = await route(command([{ name: 'status', type: 1 }]));
    assert.match(status.data.content, /Offene Verstöße/);
  } finally {
    updateSettings(GUILD, { enabled: true });
  }
});

test('while paused, buttons and modals are refused too', async () => {
  updateSettings(GUILD, { enabled: false });
  try {
    const click = await route(
      interaction({
        type: InteractionType.MESSAGE_COMPONENT,
        guild_id: GUILD,
        member: STAFF,
        data: { custom_id: `report-dismiss:1:2`, component_type: 2 },
      }),
    );
    assert.equal(click.data.content, content.commands.paused);

    const submit = await route(
      interaction({
        type: InteractionType.MODAL_SUBMIT,
        guild_id: GUILD,
        member: STAFF,
        data: { custom_id: 'report:1:2:3', components: [] },
      }),
    );
    assert.equal(submit.data.content, content.commands.paused);
  } finally {
    updateSettings(GUILD, { enabled: true });
  }
});

test('escalation can be switched off without losing the record', () => {
  const guild = '660000000000000002';
  recordViolation({
    guildId: guild,
    userId: MEMBER,
    messageId: 'm1',
    categories: ['spam'],
    action: ACTION_DELETED,
  });
  recordViolation({
    guildId: guild,
    userId: MEMBER,
    messageId: 'm2',
    categories: ['spam'],
    action: ACTION_DELETED,
  });

  assert.deepEqual(decideEscalation(guild, MEMBER), { strikes: 2, minutes: 5 });

  updateSettings(guild, { escalation: false });
  const paused = decideEscalation(guild, MEMBER);
  assert.equal(paused.strikes, 2, 'strikes still counted');
  assert.equal(paused.minutes, 0, 'but they cost nothing');

  updateSettings(guild, { escalation: true });
  assert.equal(decideEscalation(guild, MEMBER).minutes, 5, 'and it comes back');
});

test('/mod config shows both switches and can set them', async () => {
  const view = await route(command([{ name: 'config', type: 2, options: [{ name: 'view', type: 1 }] }]));
  assert.match(view.data.content, /Mai aktiv:/);
  assert.match(view.data.content, /Eskalation:/);

  const set = await route(
    command([
      {
        name: 'config',
        type: 2,
        options: [{ name: 'set', type: 1, options: [{ name: 'escalation', value: false }] }],
      },
    ]),
  );
  assert.match(set.data.content, new RegExp(`Eskalation:\\*\\* ${content.commands.config.off}`));
  assert.equal(effectiveSettings(GUILD).escalationEnabled, false);

  resetSettings(GUILD);
});

test('/mod history says so when escalation is off', async () => {
  updateSettings(GUILD, { escalation: false });
  try {
    const body = await route(
      command([{ name: 'history', type: 1, options: [{ name: 'user', value: MEMBER }] }]),
    );
    assert.ok(body.data.content.includes(content.commands.history.nextDisabled), body.data.content);
  } finally {
    resetSettings(GUILD);
  }
});
