/**
 * Registries for the interaction kinds that are not slash commands.
 *
 * A component's `custom_id` is `<name>:<arg>:<arg>…`. The part before the first
 * colon selects the handler, the rest is passed along — that is how a button
 * carries state (a message id, a user id) without a server-side session.
 *
 * To add a button or select menu: export a handler map from the feature module
 * and list it below. Modals work the same way; there is no modal in the UI yet,
 * but the routing exists so adding one is a single entry here.
 */
import { forgetComponents } from '../commands/mai.js';

/** @type {Map<string, (interaction: object, args: string[]) => object | Promise<object>>} */
export const componentHandlers = new Map(Object.entries({ ...forgetComponents }));

/** @type {Map<string, (interaction: object, args: string[]) => object | Promise<object>>} */
export const modalHandlers = new Map();

/**
 * @param {string} customId
 * @returns {{ name: string, args: string[] }}
 */
export function parseCustomId(customId) {
  const [name, ...args] = String(customId ?? '').split(':');
  return { name, args };
}
