/**
 * Interaction response builders and the follow-up REST calls.
 *
 * Discord expects the HTTP response to `POST /interactions` within ~3 s. Work
 * that takes longer (a model call, a Discord REST round trip) must answer with a
 * *deferred* response first and then edit that placeholder through the webhook
 * endpoints below. Those calls authenticate with the interaction token from the
 * payload — no bot token, no application id from config needed.
 */
import { InteractionResponseType } from 'discord-interactions';
import { logger } from '../logger.js';

const API_BASE = 'https://discord.com/api/v10';
const REQUEST_TIMEOUT_MS = 10_000;

/** Message flag: only the invoking user sees the response. */
export const EPHEMERAL = 64;

/** LLM output and user mentions must never ping. */
const NO_PINGS = { parse: [] };

/**
 * @param {string} content
 * @param {{ ephemeral?: boolean, components?: object[] }} [options]
 */
export const messageResponse = (content, { ephemeral = false, components } = {}) => ({
  type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
  data: {
    content,
    ...(ephemeral ? { flags: EPHEMERAL } : {}),
    ...(components ? { components } : {}),
    allowed_mentions: NO_PINGS,
  },
});

/** Same, but always ephemeral — the default for anything operational. */
export const ephemeralResponse = (content, options = {}) =>
  messageResponse(content, { ...options, ephemeral: true });

/**
 * Replaces the message a component belongs to (button click). Passing an empty
 * `components` array — the default — removes the buttons, which is how a
 * one-shot action marks itself as done.
 *
 * @param {string | null} content
 * @param {{ components?: object[], embeds?: object[] }} [options]
 */
export const updateResponse = (content, { components = [], embeds } = {}) => ({
  type: InteractionResponseType.UPDATE_MESSAGE,
  data: {
    ...(content === null ? {} : { content }),
    components,
    ...(embeds ? { embeds } : {}),
    allowed_mentions: NO_PINGS,
  },
});

/**
 * "Mai is thinking…" placeholder. Ephemerality is fixed here and cannot be
 * changed by the later edit.
 *
 * @param {boolean} [ephemeral]
 */
export const deferredResponse = (ephemeral = false) => ({
  type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  ...(ephemeral ? { data: { flags: EPHEMERAL } } : {}),
});

/** Deferred acknowledgement of a component, keeping the message as it is. */
export const deferredUpdateResponse = () => ({
  type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE,
});

/**
 * @param {{ name: string, value: string }[]} choices
 */
export const autocompleteResponse = (choices) => ({
  type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
  data: { choices: choices.slice(0, 25) },
});

/**
 * A modal is the one response that cannot be deferred — Discord opens it
 * immediately, so its handler must stay synchronous work only.
 *
 * @param {{ customId: string, title: string, components: object[] }} modal
 */
export const modalResponse = ({ customId, title, components }) => ({
  type: InteractionResponseType.MODAL,
  data: { custom_id: customId, title, components },
});

const ACTION_ROW = 1;
const TEXT_INPUT = 4;

/** Text input styles. */
export const SHORT_INPUT = 1;
export const PARAGRAPH_INPUT = 2;

/**
 * A single text input wrapped in the action row Discord requires.
 *
 * @param {{ customId: string, label: string, style?: number, required?: boolean,
 *   maxLength?: number, placeholder?: string }} input
 */
export const textInput = ({
  customId,
  label,
  style = SHORT_INPUT,
  required = true,
  maxLength,
  placeholder,
}) => ({
  type: ACTION_ROW,
  components: [
    {
      type: TEXT_INPUT,
      custom_id: customId,
      label,
      style,
      required,
      ...(maxLength ? { max_length: maxLength } : {}),
      ...(placeholder ? { placeholder } : {}),
    },
  ],
});

/**
 * Message body ({ content, components, … }) for the webhook endpoints, which
 * take a plain message object rather than an interaction response envelope.
 *
 * @param {object} response A response built above, or a bare message body.
 * @returns {object}
 */
const toMessageBody = (response) => {
  const body = response?.data ?? response ?? {};
  // `flags` is fixed by the deferred response; sending it again is rejected.
  const { flags, ...rest } = body;
  return { allowed_mentions: NO_PINGS, ...rest };
};

/**
 * @param {object} interaction Raw interaction payload (needs application_id + token).
 * @param {string} path
 * @param {string} method
 * @param {object} body
 */
async function callWebhook(interaction, path, method, body) {
  const url = `${API_BASE}/webhooks/${interaction.application_id}/${interaction.token}${path}`;
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    // Interaction tokens expire after 15 minutes; nothing to retry.
    logger.error(
      { status: response.status, path, method },
      'Interaction webhook call failed',
    );
    logger.debug({ path, body: detail }, 'Interaction webhook error body');
    return null;
  }

  return response.json().catch(() => ({}));
}

/**
 * Fills in the deferred placeholder.
 *
 * @param {object} interaction
 * @param {object} response
 */
export const editOriginalResponse = (interaction, response) =>
  callWebhook(interaction, '/messages/@original', 'PATCH', toMessageBody(response));

/**
 * Adds another message to an already-answered interaction.
 *
 * @param {object} interaction
 * @param {object} response
 */
export const followUpResponse = (interaction, response) =>
  callWebhook(interaction, '', 'POST', toMessageBody(response));
