/**
 * Prometheus text-format metrics.
 *
 * Everything here is already in the database: queue depth, the strike record,
 * token spend, the enforcer's heartbeat, but only reachable through `/mod` one
 * guild at a time, which is no use for a graph.
 *
 * **This endpoint is process-wide and therefore operator-only.** The HTTP server
 * is exposed to the public internet through the tunnel, so `/metrics` is off
 * unless `METRICS_TOKEN` is set, and then requires it as a bearer token. Without
 * that gate it would hand every guild's counts to anyone who found the URL:
 * the same cross-guild leak that `/mod status` was fixed for.
 *
 * Labels stay low-cardinality on purpose: `purpose`, `model` and `action` are
 * small fixed sets. Never label by guild, user or channel: that turns a metrics
 * series into a per-member activity record, and it is unbounded besides.
 *
 * Every number below comes from a repository function in `src/db/`, like every
 * other reader in the codebase. This module used to prepare its own statements,
 * which is how a second definition of "overdue" got to exist next to the
 * enforcer's and drift from it.
 */
import { config, isGuildAllowed } from '../config.js';
import { stats as historyStats } from '../db/history.js';
import { depth, dueCount, maxAttempts } from '../db/queue.js';
import { configuredGuildCount, pausedGuildIds } from '../db/settings.js';
import { breakdownFor, monthKey } from '../db/usage.js';
import { countsByAction } from '../db/violations.js';

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
  // The same list the enforcer skips, filtered the same way: a guild that is
  // paused *and* no longer allowlisted has its rows dropped rather than parked.
  const paused = pausedGuildIds().filter((guildId) => isGuildAllowed(guildId));

  // One breakdown, two series: it already carries both counters per group, so
  // asking for tokens and calls separately would be the same scan twice.
  const month = breakdownFor(monthKey());
  const label = (row) => ({ purpose: row.purpose, model: row.model });

  const tickAgeSeconds = enforcer.lastTickAt
    ? (Date.now() - new Date(enforcer.lastTickAt).getTime()) / 1000
    : -1;

  const lines = [
    ...metric('mai_up', 'Always 1 while the process serves requests.', 'gauge', [{ value: 1 }]),
    ...metric(
      'mai_queue_depth',
      'Flagged messages waiting out their grace period.',
      'gauge',
      [{ value: depth() }],
    ),
    // Split, because these two say opposite things about the same rows. A
    // paused guild's rows sit past due_at forever *by design*, so counting them
    // as overdue made the alerting signal fire on a server that had simply run
    // /mod off. `overdue` is what a tick would act on right now; `paused` is
    // what is deliberately parked. The exclusion mirrors the enforcer exactly,
    // allowlist filter included, so the two views cannot drift apart.
    ...metric(
      'mai_queue_overdue',
      'Queue rows past due_at that a tick would act on; sustained non-zero means enforcement is behind.',
      'gauge',
      [{ value: dueCount(new Date().toISOString(), paused) }],
    ),
    ...metric(
      'mai_queue_paused',
      'Pending rows held in guilds that switched Mai off. Waiting, not late.',
      'gauge',
      [{ value: paused.reduce((total, guildId) => total + depth(guildId), 0) }],
    ),
    ...metric(
      'mai_queue_attempts_max',
      'Highest failed-enforcement attempt count on any row. Rising means a stuck row.',
      'gauge',
      [{ value: maxAttempts() }],
    ),
    ...metric(
      'mai_violations',
      'Strike records currently retained, by outcome.',
      'gauge',
      Object.entries(countsByAction()).map(([action, count]) => ({
        labels: { action },
        value: count,
      })),
    ),
    ...metric(
      'mai_chat_history_rows',
      'Stored chat turns (encrypted at rest, pruned by retention).',
      'gauge',
      [{ value: historyStats().rows }],
    ),
    ...metric(
      'mai_tokens_month',
      'OpenAI tokens used this calendar month (UTC), by purpose and model.',
      'gauge',
      month.map((row) => ({ labels: label(row), value: row.totalTokens ?? 0 })),
    ),
    ...metric(
      'mai_calls_month',
      'OpenAI calls this calendar month (UTC), by purpose and model.',
      'gauge',
      month.map((row) => ({ labels: label(row), value: row.calls ?? 0 })),
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
      [{ value: configuredGuildCount() }],
    ),
  ];

  return `${lines.join('\n')}\n`;
}
