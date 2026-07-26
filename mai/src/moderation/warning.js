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
 * @param {string} value
 * @returns {string}
 */
const sanitize = (value) =>
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
  // `new Date(null)` is the epoch, not an invalid date — reject empties first.
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
 * Groups enforced records by author. Each group becomes one DM.
 *
 * @param {{ userId: string, guildId: string, content: string, timestamp: Date | string | null,
 *   categories: string[] }[]} records
 * @returns {{ userId: string, guildId: string, violations: object[], categories: string[] }[]}
 */
export function groupByUser(records) {
  const byUser = new Map();

  for (const record of records) {
    if (!byUser.has(record.userId)) {
      byUser.set(record.userId, {
        userId: record.userId,
        guildId: record.guildId,
        violations: [],
        categories: new Set(),
      });
    }
    const group = byUser.get(record.userId);
    group.violations.push(record);
    for (const category of record.categories ?? []) {
      if (category) group.categories.add(category);
    }
  }

  return [...byUser.values()].map((group) => ({
    ...group,
    categories: [...group.categories],
  }));
}

/**
 * @param {{ violations: { content: string, timestamp: Date | string | null }[], categories: string[] }} group
 * @returns {string} DM body, at most `warningDm.maxLength` characters.
 */
export function buildWarning(group) {
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
  const footer = `\n\n${dm.footer}`;

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
