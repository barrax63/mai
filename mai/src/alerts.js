/**
 * Error alerts into a Discord channel (`ALERT_CHANNEL_ID`).
 *
 * Wired into pino as a hook (see logger.js), so every `logger.error` and
 * `logger.fatal` is forwarded without each call site having to remember. A
 * revoked API key or a wedged enforcer is then visible without shelling into the
 * host for `docker compose logs`.
 *
 * This module deliberately imports almost nothing at the top: logger.js loads it,
 * so a static import of the logger or the gateway would be a cycle. Everything
 * it needs at send time is pulled in dynamically.
 */
import { config } from './config.js';

/** Only these keys are forwarded — the rest of a log record may carry content. */
const SAFE_KEYS = [
  'messageId',
  'guildId',
  'channelId',
  'userId',
  'authorId',
  'command',
  'component',
  'modal',
  'tool',
  'path',
  'status',
  'migration',
  'attempts',
];

// A failing subsystem logs on every tick; the channel must not become the
// failure. Beyond the burst, alerts are counted and reported once it calms down.
const MAX_PER_WINDOW = 5;
const WINDOW_MS = 5 * 60_000;
const MAX_FIELD_CHARS = 300;

let windowStartedAt = 0;
let sentInWindow = 0;
let suppressed = 0;

const truncate = (value) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > MAX_FIELD_CHARS ? `${text.slice(0, MAX_FIELD_CHARS - 1)}…` : text;
};

/**
 * @param {object} record First argument of the log call, when it was an object.
 * @returns {string}
 */
function describeContext(record) {
  if (!record || typeof record !== 'object') return '';

  const parts = SAFE_KEYS.filter((key) => record[key] !== undefined && record[key] !== null).map(
    (key) => `${key}=${truncate(record[key])}`,
  );

  const error = record.err ?? record.error;
  if (error) {
    const name = error.name ?? error.constructor?.name ?? 'Error';
    parts.push(`err=${truncate(`${name}: ${error.message ?? error}`)}`);
  }

  return parts.join(' ');
}

/**
 * True while the burst allowance holds; counts the rest.
 *
 * @returns {boolean}
 */
function takeSlot() {
  const now = Date.now();
  if (now - windowStartedAt > WINDOW_MS) {
    windowStartedAt = now;
    sentInWindow = 0;
  }

  if (sentInWindow >= MAX_PER_WINDOW) {
    // Counted, and reported by the next alert that gets through.
    suppressed += 1;
    return false;
  }

  sentInWindow += 1;
  return true;
}

/**
 * Forwards one log record. Never throws, never awaits the caller.
 *
 * @param {'error' | 'fatal'} level
 * @param {object|undefined} record
 * @param {string} message
 */
export function alert(level, record, message) {
  // Nothing in this module may log: that would feed itself. The `catch` below
  // is silent for the same reason, which is also why no re-entrancy guard is
  // needed — and a guard here would drop concurrent alerts, not recursive ones.
  if (!config.alerts.channelId) return;
  if (!takeSlot()) return;

  const missed = suppressed;

  void (async () => {
    try {
      const { getGatewayClient } = await import('./gateway/client.js');
      const client = getGatewayClient();
      if (!client) return;

      const channel = await client.channels.fetch(config.alerts.channelId);
      if (!channel?.isTextBased?.()) return;

      const context = describeContext(record);
      const lines = [
        `${level === 'fatal' ? '💀' : '⚠️'} **${level}** — ${truncate(message) || '(no message)'}`,
        context ? `\`\`\`${context}\`\`\`` : '',
        missed > 0 ? `_(+${missed} weitere unterdrückt)_` : '',
      ].filter(Boolean);

      await channel.send({
        content: lines.join('\n').slice(0, 1900),
        allowedMentions: { parse: [] },
      });

      // Only now: a send that never arrived must not clear the backlog it was
      // supposed to report.
      suppressed = Math.max(0, suppressed - missed);
    } catch {
      // A failed alert is not worth a crash, and logging it would feed itself.
    }
  })();
}
