/**
 * Composes the warning DM sent after messages were deleted.
 *
 * Pure functions: no Discord calls, no database access. One DM per user per
 * enforcer tick, listing every message removed in that tick, trimmed to
 * Discord's message length limit.
 */
import { content, fill } from '../content.js';

const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);

/**
 * Message content is rendered as plain text in the DM: neutralize mentions,
 * collapse newlines so one message stays one quoted line.
 *
 * Exported because the appeal evidence view quotes the same messages back to
 * staff and has to neutralize them the same way; two copies of this would be
 * two chances to forget the zero-width space.
 *
 * @param {string} value
 * @returns {string}
 */
export const sanitize = (value) =>
  String(value ?? '')
    .replaceAll('@', `@${ZERO_WIDTH_SPACE}`)
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * @param {string | Date | null} value
 * @returns {string}
 */
function formatTimestamp(value) {
  const { locale, unknownTimestamp } = content.moderation.warningDm;
  // `new Date(null)` is the epoch, not an invalid date: reject empties first.
  if (value === null || value === undefined || value === '') return unknownTimestamp;

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return unknownTimestamp;

  return new Intl.DateTimeFormat(locale, {
    timeZone: content.moderation.timezone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/**
 * The key everything about an incident is scoped by: a member is a user *in a
 * guild*, never a user on their own. Shared with the enforcer so the grouping
 * here and its timeout map cannot drift apart.
 *
 * @param {string} guildId
 * @param {string} userId
 * @returns {string}
 */
export const memberKey = (guildId, userId) => `${guildId}:${userId}`;

/**
 * Groups enforced records by member. Each group becomes one DM.
 *
 * By guild *and* user, not by user alone: Mai serves several guilds from one
 * process, so the same person can be enforced in two of them in the same tick.
 * Grouping on the user id produced a single DM that quoted one guild's deleted
 * messages next to another guild's, carried an appeal button scoped to
 * whichever guild happened to be seen first (so granting it overturned the
 * wrong strikes), and silently lost the timeout note for the second guild,
 * because the enforcer keys those by guild and user.
 *
 * @param {{ userId: string, guildId: string, content: string, timestamp: Date | string | null,
 *   categories: string[] }[]} records
 * @returns {{ userId: string, guildId: string, violations: object[], categories: string[] }[]}
 */
export function groupByMember(records) {
  const members = new Map();

  for (const record of records) {
    const key = memberKey(record.guildId, record.userId);
    if (!members.has(key)) {
      members.set(key, {
        userId: record.userId,
        guildId: record.guildId,
        violations: [],
        categories: new Set(),
      });
    }
    const group = members.get(key);
    group.violations.push(record);
    for (const category of record.categories ?? []) {
      if (category) group.categories.add(category);
    }
  }

  return [...members.values()].map((group) => ({
    ...group,
    categories: [...group.categories],
  }));
}

/**
 * The DM behind `/mod warn`: a human decided to have a word, in Mai's voice.
 *
 * Its own template rather than `buildWarning`'s, because it is about a
 * different thing: no messages were removed, so there is nothing to quote back,
 * and the reason is staff's own words rather than a category slug. There is
 * also no appeal button, deliberately: an appeal overturns *strikes*, a manual
 * warning is not one, so granting it would have nothing to do. The footer says
 * to talk to staff instead.
 *
 * @param {{ reason?: string, guildName?: string }} warning
 * @returns {string}
 */
export function buildManualWarning({ reason, guildName } = {}) {
  const manual = content.moderation.manualWarning;
  const body = [
    manual.title,
    '',
    fill(manual.intro, { guild: sanitize(guildName) || manual.unknownGuild }),
  ];

  // Staff-written, and the only free text in here.
  if (reason) body.push('', `${manual.reasonLabel} ${sanitize(reason)}`);
  body.push('', manual.footer);

  return body.join('\n').slice(0, content.moderation.warningDm.maxLength);
}

/**
 * @param {{ violations: { content: string, timestamp: Date | string | null }[], categories: string[] }} group
 * @param {{ applied?: boolean, until?: Date | null, strikes?: number } | undefined} [timeout]
 *   Escalation outcome, when this sweep also timed the member out.
 * @returns {string} DM body, at most `warningDm.maxLength` characters.
 */
export function buildWarning(group, timeout) {
  const dm = content.moderation.warningDm;
  const categoryText = group.categories.length
    ? group.categories.join(', ')
    : dm.unknownCategory;

  const header = [
    dm.title,
    '',
    dm.intro,
    '',
    `${dm.categoryLabel} ${categoryText}`,
    '',
    dm.messagesLabel,
  ].join('\n');

  // Discord renders the timestamp in the reader's own locale and timezone, so
  // the note needs no formatting of its own.
  const timeoutNote = timeout?.applied && timeout.until
    ? `\n\n${fill(dm.timeoutNote, {
        strikes: timeout.strikes ?? 0,
        until: `<t:${Math.floor(new Date(timeout.until).getTime() / 1000)}:f>`,
        relative: `<t:${Math.floor(new Date(timeout.until).getTime() / 1000)}:R>`,
      })}`
    : '';
  const footer = `${timeoutNote}\n\n${dm.footer}`;

  const lines = [];
  let omitted = 0;

  for (const [index, violation] of group.violations.entries()) {
    const text = sanitize(violation.content).slice(0, dm.maxContentChars);
    // An image-only message has no text to quote back, but "empty" would be a
    // lie about what was removed.
    const empty = violation.attachments > 0 ? dm.attachmentMessage : dm.emptyMessage;
    const line = `> [${formatTimestamp(violation.timestamp)}] ${text || empty}`;

    if (`${header}\n${[...lines, line].join('\n')}${footer}`.length > dm.maxLength) {
      omitted = group.violations.length - index;
      break;
    }
    lines.push(line);
  }

  if (omitted > 0) {
    const omittedLine = fill(dm.omittedLine, { count: omitted, plural: omitted === 1 ? '' : 'en' });
    if (`${header}\n${[...lines, omittedLine].join('\n')}${footer}`.length <= dm.maxLength) {
      lines.push(omittedLine);
    }
  }

  return `${header}\n${lines.join('\n')}${footer}`.slice(0, dm.maxLength);
}
