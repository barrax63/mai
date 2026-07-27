import './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { content } from '../src/content.js';
import { buildWarning, groupByMember } from '../src/moderation/warning.js';

const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
const timestamp = new Date('2026-07-26T12:34:00Z');

const record = (overrides = {}) => ({
  userId: 'user-1',
  guildId: 'guild-1',
  content: 'boese nachricht',
  timestamp,
  categories: ['harassment'],
  ...overrides,
});

test('groups records per author and unions their categories', () => {
  const groups = groupByMember([
    record(),
    record({ categories: ['hate'] }),
    record({ userId: 'user-2', categories: ['spam'] }),
  ]);

  assert.equal(groups.length, 2);
  const [first, second] = groups;
  assert.equal(first.violations.length, 2);
  assert.deepEqual(first.categories, ['harassment', 'hate']);
  assert.deepEqual(second.categories, ['spam']);
});

test('the same member in two guilds is two incidents, not one merged DM', () => {
  const groups = groupByMember([
    record({ guildId: 'guild-1', content: 'in guild one' }),
    record({ guildId: 'guild-2', content: 'in guild two', categories: ['spam'] }),
  ]);

  assert.equal(groups.length, 2, 'one group per guild, not one per user');

  const first = groups.find((group) => group.guildId === 'guild-1');
  const second = groups.find((group) => group.guildId === 'guild-2');

  // Each DM may only quote the messages of its own guild: merging them would
  // show one server's staff decision to the member alongside another's.
  assert.deepEqual(first.violations.map((entry) => entry.content), ['in guild one']);
  assert.deepEqual(second.violations.map((entry) => entry.content), ['in guild two']);
  assert.deepEqual(first.categories, ['harassment']);
  assert.deepEqual(second.categories, ['spam']);

  const bodies = groups.map((group) => buildWarning(group));
  assert.ok(bodies[0].includes('in guild one') && !bodies[0].includes('in guild two'));
  assert.ok(bodies[1].includes('in guild two') && !bodies[1].includes('in guild one'));
});

test('renders one quoted line per message with a localized timestamp', () => {
  const [group] = groupByMember([record()]);
  const dm = buildWarning(group);

  assert.ok(dm.startsWith(content.moderation.warningDm.title));
  assert.ok(dm.includes('**Kategorie:** harassment'));
  assert.ok(dm.includes('> [26.07.2026, 14:34] boese nachricht'), dm);
  assert.ok(dm.endsWith(content.moderation.warningDm.footer));
});

test('neutralizes mentions and collapses newlines', () => {
  const [group] = groupByMember([record({ content: '@everyone\nzweite  zeile' })]);
  const dm = buildWarning(group);

  assert.ok(dm.includes(`@${ZERO_WIDTH_SPACE}everyone zweite zeile`), dm);
  assert.equal(dm.includes('@everyone'), false, 'raw mention must not survive');
});

test('falls back when a message has no content or no category', () => {
  const [group] = groupByMember([record({ content: '', categories: [] })]);
  const dm = buildWarning(group);

  assert.ok(dm.includes(content.moderation.warningDm.emptyMessage));
  assert.ok(dm.includes(content.moderation.warningDm.unknownCategory));
});

test('an image-only message is named as such, not called empty', () => {
  const [group] = groupByMember([record({ content: '', attachments: 1 })]);
  const dm = buildWarning(group);

  assert.ok(dm.includes(content.moderation.warningDm.attachmentMessage), dm);
  assert.equal(dm.includes(content.moderation.warningDm.emptyMessage), false);
});

test('marks an unparseable timestamp instead of printing Invalid Date', () => {
  const [group] = groupByMember([record({ timestamp: null })]);
  assert.ok(buildWarning(group).includes(content.moderation.warningDm.unknownTimestamp));
});

test('stays within the length limit and reports what did not fit', () => {
  const many = Array.from({ length: 40 }, (_, index) =>
    record({ content: `${'x'.repeat(400)} nr${index}` }),
  );
  const [group] = groupByMember(many);
  const dm = buildWarning(group);

  assert.ok(dm.length <= content.moderation.warningDm.maxLength, `length ${dm.length}`);
  assert.match(dm, /und \d+ weitere Nachrichten\./);
});

test('caps a single long message at maxContentChars', () => {
  const [group] = groupByMember([record({ content: 'y'.repeat(900) })]);
  const line = buildWarning(group)
    .split('\n')
    .find((entry) => entry.startsWith('> ['));

  const quoted = line.slice(line.indexOf('] ') + 2);
  assert.equal(quoted.length, content.moderation.warningDm.maxContentChars);
});
