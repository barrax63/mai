/**
 * The two flows that run entirely on components and modals: reporting a message
 * and appealing a warning.
 */
import { interaction, openTestDatabase, TEST_GUILD, TEST_USER } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { InteractionResponseType, InteractionType } from 'discord-interactions';
import { content } from '../src/content.js';
import { updateSettings } from '../src/db/settings.js';
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
function stubGateway({ deleteFails = false } = {}) {
  const sent = [];
  const deleted = [];

  setGatewayClient({
    channels: {
      fetch: async (id) => ({
        id,
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
      name: 'Mai: melden',
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
  const body = await route(modalSubmit(`report:${CHANNEL}:${MESSAGE}:${AUTHOR}`, 'Werbung'));

  assert.equal(body.data.content, content.commands.report.thanks);
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
  await route(modalSubmit(`report:${CHANNEL}:${MESSAGE}:${AUTHOR}`, '   '));

  const embed = sent[0].embeds[0];
  assert.equal(
    embed.fields.some((field) => field.name === content.moderation.log.fields.reason),
    false,
  );
});

test('approving deletes the message and closes the entry', async () => {
  const { deleted } = stubGateway();
  const body = await route(
    interaction({
      type: InteractionType.MESSAGE_COMPONENT,
      member: member(TEST_USER, STAFF_PERMISSIONS),
      message: { embeds: [{ title: 'x', fields: [{ name: 'a', value: 'b' }] }] },
      data: { custom_id: `report-approve:${CHANNEL}:${MESSAGE}`, component_type: 2 },
    }),
  );

  assert.deepEqual(deleted, [MESSAGE]);
  assert.equal(body.type, InteractionResponseType.UPDATE_MESSAGE);
  assert.deepEqual(body.data.components, [], 'buttons are gone once handled');

  const resolution = body.data.embeds[0].fields.at(-1);
  assert.equal(resolution.name, content.moderation.log.fields.resolution);
  assert.match(resolution.value, new RegExp(`Gelöscht von <@${TEST_USER}>`));
  assert.equal(body.data.embeds[0].fields[0].value, 'b', 'the original fields survive');
});

test('an undeletable message is recorded as such, not as a failure', async () => {
  stubGateway({ deleteFails: true });
  const body = await route(
    interaction({
      type: InteractionType.MESSAGE_COMPONENT,
      member: member(TEST_USER, STAFF_PERMISSIONS),
      message: { embeds: [{ fields: [] }] },
      data: { custom_id: `report-approve:${CHANNEL}:${MESSAGE}`, component_type: 2 },
    }),
  );

  assert.match(body.data.embeds[0].fields.at(-1).value, /nicht mehr löschbar/);
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
  assert.equal(appealComponents(TEST_GUILD).length, 1);
  assert.equal(
    appealComponents(TEST_GUILD)[0].components[0].custom_id,
    `appeal:${TEST_GUILD}`,
  );
  assert.deepEqual(appealComponents('870000000000000001'), [], 'no log channel, no button');
});

test('the appeal button opens a modal for that guild', async () => {
  const body = await route(
    interaction({
      type: InteractionType.MESSAGE_COMPONENT,
      guild_id: undefined, // the warning arrives as a DM
      member: undefined,
      user: { id: AUTHOR, username: 'author' },
      data: { custom_id: `appeal:${TEST_GUILD}`, component_type: 2 },
    }),
  );

  assert.equal(body.type, InteractionResponseType.MODAL);
  assert.equal(body.data.custom_id, `appeal-submit:${TEST_GUILD}`);
  assert.equal(body.data.components[0].components[0].required, true);
});

test('a submitted appeal is forwarded to the guild it belongs to', async () => {
  const { sent } = stubGateway();
  const body = await route(
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
  assert.equal(body.data.content, content.moderation.appeal.submitted);
});

test('an empty appeal is rejected before it reaches staff', async () => {
  const { sent } = stubGateway();
  const body = await route(
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
  assert.equal(body.data.content, content.moderation.appeal.empty);
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
