/**
 * Token accounting.
 *
 * Mai spends the OpenAI budget directly now, and the API already returns what
 * each call cost, this keeps a running total so `/mod spend` can answer "how
 * much?" and the monthly cap can stop a runaway before the invoice does.
 *
 * Counters only: no prompts, no replies, nothing that identifies a member.
 */
import { config } from '../config.js';
import { getDb } from './index.js';

/** UTC day key, so a restart or a timezone change cannot double-count. */
export const dayKey = (date = new Date()) => date.toISOString().slice(0, 10);

/** UTC month prefix of a day key. */
export const monthKey = (date = new Date()) => date.toISOString().slice(0, 7);

/**
 * Adds one call to the running totals.
 *
 * @param {{ guildId?: string | null, model: string, purpose: string,
 *   usage?: { prompt_tokens?: number, completion_tokens?: number, total_tokens?: number } }} entry
 */
export function recordUsage({ guildId, model, purpose, usage }) {
  const prompt = usage?.prompt_tokens ?? 0;
  const completion = usage?.completion_tokens ?? 0;
  const total = usage?.total_tokens ?? prompt + completion;

  getDb()
    .prepare(
      `INSERT INTO usage_daily (day, guild_id, model, purpose, calls, prompt_tokens, completion_tokens, total_tokens)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT (day, guild_id, model, purpose) DO UPDATE SET
         calls = calls + 1,
         prompt_tokens = prompt_tokens + excluded.prompt_tokens,
         completion_tokens = completion_tokens + excluded.completion_tokens,
         total_tokens = total_tokens + excluded.total_tokens`,
    )
    .run(dayKey(), guildId ?? '', model, purpose, prompt, completion, total);
}

const EMPTY = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };

const toTotals = (row) => ({
  calls: row?.calls ?? 0,
  promptTokens: row?.prompt_tokens ?? 0,
  completionTokens: row?.completion_tokens ?? 0,
  totalTokens: row?.total_tokens ?? 0,
});

/**
 * @param {string} prefix A day key (`2026-07-26`) or month key (`2026-07`).
 * @param {string} [guildId] Omit for the process-wide total (operators only).
 * @returns {typeof EMPTY}
 */
export function totalsFor(prefix, guildId) {
  const columns = `SUM(calls) AS calls, SUM(prompt_tokens) AS prompt_tokens,
                   SUM(completion_tokens) AS completion_tokens, SUM(total_tokens) AS total_tokens`;
  const db = getDb();
  const row = guildId
    ? db.prepare(`SELECT ${columns} FROM usage_daily WHERE day LIKE ? AND guild_id = ?`)
        .get(`${prefix}%`, guildId)
    : db.prepare(`SELECT ${columns} FROM usage_daily WHERE day LIKE ?`).get(`${prefix}%`);

  return row?.calls == null ? { ...EMPTY } : toTotals(row);
}

/**
 * @param {string} prefix
 * @param {string} [guildId] Omit for the process-wide breakdown (operators only).
 * @returns {{ purpose: string, model: string, calls: number, totalTokens: number }[]}
 */
export function breakdownFor(prefix, guildId) {
  const columns = 'purpose, model, SUM(calls) AS calls, SUM(total_tokens) AS total_tokens';
  const tail = 'GROUP BY purpose, model ORDER BY SUM(total_tokens) DESC';
  const db = getDb();
  const rows = guildId
    ? db.prepare(`SELECT ${columns} FROM usage_daily WHERE day LIKE ? AND guild_id = ? ${tail}`)
        .all(`${prefix}%`, guildId)
    : db.prepare(`SELECT ${columns} FROM usage_daily WHERE day LIKE ? ${tail}`).all(`${prefix}%`);

  return rows.map((row) => ({
    purpose: row.purpose,
    model: row.model,
    calls: row.calls,
    totalTokens: row.total_tokens,
  }));
}

/**
 * Where the current month stands against `OPENAI_MONTHLY_TOKEN_BUDGET`.
 * A budget of 0 means "no limit".
 *
 * @returns {{ used: number, budget: number, exceeded: boolean }}
 */
export function budgetState() {
  const budget = config.openai.monthlyTokenBudget;
  const used = totalsFor(monthKey()).totalTokens;
  return { used, budget, exceeded: budget > 0 && used >= budget };
}
