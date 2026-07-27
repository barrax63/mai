/**
 * The functions Mai may call while answering.
 *
 * Without these she guesses: "wann ist mein Verstoß vorbei?" used to get a
 * plausible invention. Each tool reads state Mai already owns and returns
 * metadata only.
 *
 * **No tool takes arguments from the model.** Who is asking and where comes from
 * the interaction context the caller passes in, never from the completion: a
 * model that could pass a user id could read another member's record.
 */
import { config } from '../config.js';
import { openViolations } from '../db/queue.js';
import { strikeCount } from '../db/violations.js';
import { logger } from '../logger.js';
import { strikeWindowStart } from '../moderation/escalation.js';

const NO_ARGUMENTS = { type: 'object', properties: {}, additionalProperties: false };

/** Sent to the model with every tool-enabled request. */
export const toolDefinitions = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'get_my_violations',
      description:
        'Offene, noch nicht vollstreckte Regelverstöße der Person, die gerade schreibt: Anzahl, Kategorien und wann die Nachricht gelöscht wird.',
      parameters: NO_ARGUMENTS,
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_server_info',
      description:
        'Fakten über den Server, in dem gerade geschrieben wird: Name, Mitgliederzahl, Gründungsdatum. In Direktnachrichten nicht verfügbar.',
      parameters: NO_ARGUMENTS,
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: 'Aktuelles Datum und Uhrzeit in der Zeitzone des Servers.',
      parameters: NO_ARGUMENTS,
    },
  },
]);

/**
 * Models render a bare ISO string as a date and drop the time, which is the one
 * part "wann ist das vorbei?" is actually about, so hand them both.
 *
 * @param {string | null} iso
 * @returns {string | null}
 */
const localTime = (iso) => {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  return new Intl.DateTimeFormat('de-DE', {
    timeZone: config.timezone,
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
};

const handlers = {
  /**
   * @param {{ userId: string }} context
   */
  get_my_violations({ userId, guildId }) {
    const { count, categories, nextDueAt } = openViolations(userId);

    return {
      open_violations: count,
      categories,
      next_deletion_at: nextDueAt ?? null,
      next_deletion_local: localTime(nextDueAt),
      timezone: config.timezone,
      // Enforced strikes on this server inside the escalation window: what
      // decides whether the next one comes with a timeout.
      ...(guildId
        ? { strikes_in_window: strikeCount(guildId, userId, strikeWindowStart(guildId)) }
        : {}),
    };
  },

  /**
   * @param {{ guildId: string | null, client: object | null }} context
   */
  get_server_info({ guildId, client }) {
    if (!guildId) return { error: 'not_in_a_server' };

    const guild = client?.guilds?.cache?.get(guildId);
    if (!guild) return { error: 'unknown_server' };

    return {
      name: guild.name,
      members: guild.memberCount,
      created_at: guild.createdAt?.toISOString?.() ?? null,
    };
  },

  get_current_time() {
    return {
      iso: new Date().toISOString(),
      local: new Intl.DateTimeFormat('de-DE', {
        timeZone: config.timezone,
        dateStyle: 'full',
        timeStyle: 'short',
      }).format(new Date()),
      timezone: config.timezone,
    };
  },
};

/**
 * @param {{ id: string, function?: { name?: string } }} call One entry of the
 *   assistant message's `tool_calls`.
 * @param {{ userId: string, guildId: string | null, client?: object }} context
 * @returns {object} Result payload, serialized into the tool message by the caller.
 */
export function runTool(call, context) {
  const name = call?.function?.name;
  const handler = handlers[name];

  if (!handler) {
    logger.warn({ tool: name }, 'Model asked for an unknown tool');
    return { error: 'unknown_tool' };
  }

  try {
    const result = handler(context);
    logger.info({ tool: name, userId: context.userId }, 'Tool call handled');
    logger.debug({ tool: name, result }, 'Tool call result');
    return result;
  } catch (error) {
    logger.error({ tool: name, err: error }, 'Tool call failed');
    return { error: 'tool_failed' };
  }
}
