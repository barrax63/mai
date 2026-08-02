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
import { content } from '../content.js';
import { effectiveSettings } from '../db/settings.js';
import { openViolations } from '../db/queue.js';
import { lastEnforcementPass, strikeCount, totalsFor } from '../db/violations.js';
import { logger } from '../logger.js';
import { strikeWindowStart } from '../moderation/escalation.js';

const NO_ARGUMENTS = { type: 'object', properties: {}, additionalProperties: false };

/**
 * How many of a guild's own emotes are handed to the model.
 *
 * A busy server has hundreds, and the whole list is a few thousand tokens on a
 * request that already pays for a persona and twelve turns of history. Sorted
 * by name before the cut so the same server always offers the same subset,
 * rather than whatever order the cache happens to hold today.
 */
const MAX_EMOTES = 40;

/**
 * Sent to the model with every tool-enabled request.
 *
 * `get_server_rules` is only offered where there *are* rules in the content
 * file. An empty list would be worse than no tool: the model would call it,
 * receive nothing, and go back to inventing, which is the exact failure these
 * tools exist to stop.
 */
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
  {
    type: 'function',
    function: {
      name: 'get_my_timeout_status',
      description:
        'Ob die Person, die gerade schreibt, aktuell stummgeschaltet (Timeout) ist und bis wann. In Direktnachrichten nicht verfügbar.',
      parameters: NO_ARGUMENTS,
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_my_appeal_status',
      description:
        'Ob die Person, die gerade schreibt, gegen ihre letzte Verwarnung Einspruch einlegen kann, wann diese war und ob frühere Einsprüche Erfolg hatten.',
      parameters: NO_ARGUMENTS,
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_server_emotes',
      // Deliberately inviting: a call costs a second request to the provider,
      // and that is the accepted price of her reaching for the server's own
      // emotes as readily as for ordinary ones. The one thing this wording has
      // to keep out is a guessed code, which is what the tool exists for.
      description:
        'Die eigenen Emotes dieses Servers, jeweils mit dem Code, den du wortwörtlich in deine Antwort schreiben musst, damit Discord sie als Bild anzeigt. Ruf es auf, wann immer ein Server-Emote zu deiner Antwort passen könnte; für normale Emojis brauchst du es nicht. In Direktnachrichten nicht verfügbar.',
      parameters: NO_ARGUMENTS,
    },
  },
  ...(content.chat.rules.length > 0
    ? [
        {
          type: 'function',
          function: {
            name: 'get_server_rules',
            description: 'Die Regeln dieses Servers, im Wortlaut. Nutze sie, statt Regeln zu erfinden.',
            parameters: NO_ARGUMENTS,
          },
        },
      ]
    : []),
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

  /**
   * "Wie lange bin ich noch stumm?" used to get an invented number, and the one
   * person who cannot read the answer off Discord's own UI is the member who is
   * timed out and looking at a locked text box.
   *
   * Read from the cache, never fetched: tools are synchronous by design (see
   * `runTool`), and a member who is talking to Mai right now is in the cache
   * because their message put them there. A miss is reported as unknown rather
   * than guessed at.
   *
   * @param {{ userId: string, guildId: string | null, client: object | null }} context
   */
  get_my_timeout_status({ userId, guildId, client }) {
    if (!guildId) return { error: 'not_in_a_server' };

    const member = client?.guilds?.cache?.get(guildId)?.members?.cache?.get(userId);
    if (!member) return { error: 'unknown_member' };

    const until = member.communicationDisabledUntil ?? null;
    const active = Boolean(until) && new Date(until).getTime() > Date.now();

    return {
      timed_out: active,
      until: active ? new Date(until).toISOString() : null,
      until_local: active ? localTime(new Date(until).toISOString()) : null,
      timezone: config.timezone,
    };
  },

  /**
   * What a member can actually do about a warning, so "kann ich da was machen?"
   * stops being answered from the persona's imagination.
   *
   * Their own record only, in this guild only, and metadata only: no message
   * text, no message ids.
   *
   * @param {{ userId: string, guildId: string | null }} context
   */
  get_my_appeal_status({ userId, guildId }) {
    if (!guildId) return { error: 'not_in_a_server' };

    const pass = lastEnforcementPass(guildId, userId, strikeWindowStart(guildId));
    const totals = totalsFor(guildId, userId);

    return {
      // An appeal has to have somewhere to land and something to be about.
      can_appeal: Boolean(pass) && Boolean(effectiveSettings(guildId).logChannelId),
      how_to_appeal: 'Der Button unter der Verwarnungs-DM, oder /mai appeal auf dem Server.',
      last_enforcement_at: pass?.sinceIso ?? null,
      last_enforcement_local: localTime(pass?.sinceIso ?? null),
      messages_removed_then: pass?.strikes ?? 0,
      overturned_total: totals.byAction.overturned ?? 0,
      timezone: config.timezone,
    };
  },

  /**
   * The server's own emotes, with the code that actually renders them.
   *
   * Same reason as every other tool here: without it a model asked for a cat
   * emote writes `<:catjam:123>`, Discord finds no such id and posts that text
   * verbatim. The id is the part that cannot be guessed, so it has to be looked
   * up. Cache read only, like `get_server_info`: emotes arrive with the guild,
   * no privileged intent and no fetch involved.
   *
   * Unlike `get_server_rules` this one cannot be left out of `toolDefinitions`
   * when there is nothing to say: that array is built once at import, and which
   * guild is asking is only known per call. A server without emotes gets an
   * error payload instead, which reads the same way to the model.
   *
   * @param {{ guildId: string | null, client: object | null }} context
   */
  get_server_emotes({ guildId, client }) {
    if (!guildId) return { error: 'not_in_a_server' };

    const guild = client?.guilds?.cache?.get(guildId);
    if (!guild) return { error: 'unknown_server' };

    const emotes = [...(guild.emojis?.cache?.values?.() ?? [])]
      // `available: false` is an emote the server lost with a boost level: it
      // still sits in the cache and renders as raw text.
      .filter((emote) => emote?.id && emote?.name && emote.available !== false)
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_EMOTES)
      .map((emote) => ({
        name: emote.name,
        code: `<${emote.animated ? 'a' : ''}:${emote.name}:${emote.id}>`,
      }));

    if (emotes.length === 0) return { error: 'no_custom_emotes' };
    return { emotes };
  },

  /**
   * The rules in the operator's own words. Without this Mai answered "was sind
   * hier die Regeln?" with whatever the model considered plausible, which is
   * the same failure as inventing a deletion deadline.
   */
  get_server_rules() {
    return { rules: content.chat.rules };
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
  // Own properties only: a plain lookup also finds everything on
  // Object.prototype, so a model naming `constructor` as its tool got Object
  // back and had the caller's context handed to it as an argument.
  const handler = Object.hasOwn(handlers, String(name)) ? handlers[name] : null;

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
