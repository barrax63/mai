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
import { searchGif } from './gif-search.js';
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
 * The one tool that takes something the model wrote.
 *
 * Every other tool here refuses arguments outright, and the reason is worth
 * restating rather than making an exception to quietly: an argument that names
 * a *target* (a user id, a channel) would let a prompt-injected model reach
 * something that is not the caller's. A search term names no target. It steers
 * what Mai looks for, and what comes back is constrained on our side instead:
 * screened before it is sent, host-checked before it is posted, and never
 * echoed to the model as a URL (see `chat/gif-search.js`).
 */
const searchTools = Object.freeze(
  config.chat.gifSearch.enabled
    ? [
        {
          type: 'function',
          function: {
            name: 'search_gif',
            description: content.chat.gifSearchInstruction,
            parameters: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  // The examples are the strongest steer in here, so they are
                  // deliberately about *situations* and deliberately not cats:
                  // "cat in a box" as a sample turned every search into another
                  // cat GIF, because the persona was already pulling that way.
                  description:
                    'Wonach gesucht wird, ein paar Worte, am besten Englisch, passend zum Thema des Gesprächs: "facepalm", "excited celebration", "monday morning", "mind blown", "awkward silence". Keine Links, keine ganzen Sätze.',
                },
              },
              required: ['query'],
              additionalProperties: false,
            },
          },
        },
      ]
    : [],
);

const WITH_SEARCH = Object.freeze([...toolDefinitions, ...searchTools]);

/**
 * What the model is offered for a given guild.
 *
 * `search_gif` is the first tool a *server* can switch off (`/mod config set
 * gifs:false`), so the offered list stopped being a constant. Both arrays are
 * built once at import; this runs per reply and only decides between them.
 * `gifsEnabled` arrives already folded against the operator's API key, so true
 * here means a key really exists.
 *
 * @param {string | null | undefined} guildId
 * @returns {object[]}
 */
export function toolsFor(guildId) {
  if (searchTools.length === 0) return toolDefinitions;
  return effectiveSettings(guildId).gifsEnabled ? WITH_SEARCH : toolDefinitions;
}

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
 * The one tool with a side effect, and the only one that awaits.
 *
 * Every other handler answers a question; this one *does* something, by leaving
 * the chosen URL on the context for `generateReply` to pick up. The alternative
 * was handing the URL back to the model and posting whatever it echoed, which
 * would make "what did Mai just link?" a question about model output instead of
 * about a host allowlist.
 *
 * Awaiting is allowed here because what it waits for is one outbound request
 * with a hard timeout, which is a different thing from the fetch
 * `get_my_timeout_status` is forbidden: that one would have gone to Discord for
 * state the cache already holds. Nothing here can be answered from memory.
 *
 * The guild's switch is checked again for the usual reason: which tools were
 * offered is not an authorization. Calls in the same turn overwrite each other,
 * so a reply carries at most one GIF.
 *
 * @param {{ guildId: string | null, pendingGif?: string | null }} context
 * @param {{ query?: unknown }} args Model-supplied, validated downstream.
 */
async function searchGifTool(context, args) {
  if (!effectiveSettings(context.guildId).gifsEnabled) return { error: 'gifs_disabled' };

  const url = await searchGif(args?.query, { guildId: context.guildId ?? null });
  // "Nothing found" is a normal answer and the model has to be able to write
  // around it, so it is not an error.
  if (!url) return { found: false };

  context.pendingGif = url;
  return { found: true };
}

const gifHandlers = searchTools.length > 0 ? { search_gif: searchGifTool } : {};

/**
 * The arguments string is parsed here and handed on as a plain object, but that
 * is a convenience and not an endorsement: `search_gif` is the only handler
 * that reads it, and it validates what it finds. Everything else ignores the
 * second parameter entirely, which is what keeps "no tool takes arguments from
 * the model" true where it matters.
 *
 * Awaits the handler. Almost all of them are synchronous and must stay that way
 * (a tool that fetches from Discord for state the cache already holds is the
 * mistake this rule exists to prevent); the exception is the one whose whole
 * job is an outbound request with a timeout.
 *
 * @param {{ id: string, function?: { name?: string, arguments?: string } }} call
 *   One entry of the assistant message's `tool_calls`.
 * @param {{ userId: string, guildId: string | null, client?: object }} context
 * @returns {Promise<object>} Result payload, serialized by the caller.
 */
export async function runTool(call, context) {
  const name = call?.function?.name;
  // Own properties only: a plain lookup also finds everything on
  // Object.prototype, so a model naming `constructor` as its tool got Object
  // back and had the caller's context handed to it as an argument.
  const key = String(name);
  const handler = Object.hasOwn(handlers, key)
    ? handlers[key]
    : (Object.hasOwn(gifHandlers, key) ? gifHandlers[key] : null);

  if (!handler) {
    logger.warn({ tool: name }, 'Model asked for an unknown tool');
    return { error: 'unknown_tool' };
  }

  let args = {};
  const raw = call?.function?.arguments;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      // An array or a bare string parses fine and is not an argument object.
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
    } catch {
      // A model that cannot produce JSON gets the tool's no-argument behaviour,
      // which for every tool but one is the only behaviour there is.
      logger.debug({ tool: name }, 'Tool arguments were not JSON');
    }
  }

  try {
    const result = await handler(context, args);
    logger.info({ tool: name, userId: context.userId }, 'Tool call handled');
    logger.debug({ tool: name, result }, 'Tool call result');
    return result;
  } catch (error) {
    logger.error({ tool: name, err: error }, 'Tool call failed');
    return { error: 'tool_failed' };
  }
}
