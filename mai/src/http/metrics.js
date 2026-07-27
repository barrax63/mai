/**
 * Prometheus text-format metrics.
 *
 * Everything here is already in the database — queue depth, the strike record,
 * token spend, the enforcer's heartbeat — but only reachable through `/mod` one
 * guild at a time, which is no use for a graph.
 *
 * **This endpoint is process-wide and therefore operator-only.** The HTTP server
 * is exposed to the public internet through the tunnel, so `/metrics` is off
 * unless `METRICS_TOKEN` is set, and then requires it as a bearer token. Without
 * that gate it would hand every guild's counts to anyone who found the URL —
 * the same cross-guild leak that `/mod status` was fixed for.
 *
 * Labels stay low-cardinality on purpose: `purpose`, `model` and `action` are
 * small fixed sets. Never label by guild, user or channel — that turns a metrics
 * series into a per-member activity record, and it is unbounded besides.
 */
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { monthKey } from '../db/usage.js';

/** Prometheus wants an escaped label value. */
const escape = (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');

/**
 * @param {string} name
 * @param {string} help
 * @param {'counter' | 'gauge'} type
 * @param {{ labels?: Record<string, string|number>, value: number }[]} samples
 * @returns {string[]}
 */
function metric(name, help, type, samples) {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`];
  for (const { labels, value } of samples) {
    const rendered = labels && Object.keys(labels).length > 0
      ? `{${Object.entries(labels).map(([key, val]) => `${key}="${escape(val)}"`).join(',')}}`
      : '';
    lines.push(`${name}${rendered} ${value}`);
  }
  return lines;
}

/**
 * @param {{ lastTickAt: string | null, running: boolean }} enforcer
 * @returns {string} Prometheus exposition text.
 */
export function renderMetrics(enforcer) {
  const db = getDb();
  const one = (sql, ...params) => db.prepare(sql).get(...params) ?? {};
  const all = (sql, ...params) => db.prepare(sql).all(...params);

  const tickAgeSeconds = enforcer.lastTickAt
    ? (Date.now() - new Date(enforcer.lastTickAt).getTime()) / 1000
    : -1;

  const lines = [
    ...metric('mai_up', 'Always 1 while the process serves requests.', 'gauge', [{ value: 1 }]),
    ...metric(
      'mai_queue_depth',
      'Flagged messages waiting out their grace period.',
      'gauge',
      [{ value: one('SELECT COUNT(*) AS c FROM moderation_queue').c ?? 0 }],
    ),
    ...metric(
      'mai_queue_overdue',
      'Queue rows already past due_at — sustained non-zero means enforcement is behind.',
      'gauge',
      [{ value: one('SELECT COUNT(*) AS c FROM moderation_queue WHERE due_at <= ?', new Date().toISOString()).c ?? 0 }],
    ),
    ...metric(
      'mai_queue_attempts_max',
      'Highest failed-enforcement attempt count on any row. Rising means a stuck row.',
      'gauge',
      [{ value: one('SELECT COALESCE(MAX(attempts), 0) AS c FROM moderation_queue').c ?? 0 }],
    ),
    ...metric(
      'mai_violations',
      'Strike records currently retained, by outcome.',
      'gauge',
      all('SELECT action, COUNT(*) AS c FROM violations GROUP BY action').map((row) => ({
        labels: { action: row.action },
        value: row.c,
      })),
    ),
    ...metric(
      'mai_chat_history_rows',
      'Stored chat turns (encrypted at rest, pruned by retention).',
      'gauge',
      [{ value: one('SELECT COUNT(*) AS c FROM chat_history').c ?? 0 }],
    ),
    ...metric(
      'mai_tokens_month',
      'OpenAI tokens used this calendar month (UTC), by purpose and model.',
      'gauge',
      all(
        `SELECT purpose, model, SUM(total_tokens) AS tokens FROM usage_daily
         WHERE day LIKE ? GROUP BY purpose, model`,
        `${monthKey()}%`,
      ).map((row) => ({
        labels: { purpose: row.purpose, model: row.model },
        value: row.tokens ?? 0,
      })),
    ),
    ...metric(
      'mai_calls_month',
      'OpenAI calls this calendar month (UTC), by purpose and model.',
      'gauge',
      all(
        `SELECT purpose, model, SUM(calls) AS calls FROM usage_daily
         WHERE day LIKE ? GROUP BY purpose, model`,
        `${monthKey()}%`,
      ).map((row) => ({
        labels: { purpose: row.purpose, model: row.model },
        value: row.calls ?? 0,
      })),
    ),
    ...metric(
      'mai_token_budget',
      'Monthly token budget. 0 means no limit is configured.',
      'gauge',
      [{ value: config.openai.monthlyTokenBudget }],
    ),
    ...metric(
      'mai_enforcer_last_tick_age_seconds',
      'Seconds since the moderation tick last finished. -1 before the first one.',
      'gauge',
      [{ value: Number(tickAgeSeconds.toFixed(1)) }],
    ),
    ...metric(
      'mai_enforcer_running',
      '1 while a tick is in flight.',
      'gauge',
      [{ value: enforcer.running ? 1 : 0 }],
    ),
    ...metric(
      'mai_guilds_configured',
      'Guilds that have changed at least one setting from the default.',
      'gauge',
      [{ value: one('SELECT COUNT(*) AS c FROM guild_settings').c ?? 0 }],
    ),
  ];

  return `${lines.join('\n')}\n`;
}
