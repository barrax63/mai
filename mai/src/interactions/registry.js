/**
 * Registries for the interaction kinds that are not slash commands.
 *
 * A component's or modal's `custom_id` is `<name>:<arg>:<arg>…`. The part before
 * the first colon selects the handler, the rest is passed along — that is how a
 * button or modal carries state (a message id, a guild id) without a
 * server-side session. Never trust those arguments as authorization: check the
 * clicker's own id or permissions in the handler.
 *
 * To add one: export a handler map from the feature module and list it below.
 */
import { forgetComponents } from '../commands/mai.js';
import { reportComponents, reportModals } from '../commands/report.js';
import { appealButtons, appealDecisions, appealModals } from '../moderation/appeal.js';

/** @type {Map<string, (interaction: object, args: string[]) => object | Promise<object>>} */
export const componentHandlers = new Map(
  Object.entries({
    ...forgetComponents,
    ...reportComponents,
    ...appealButtons,
    ...appealDecisions,
  }),
);

/** @type {Map<string, (interaction: object, args: string[]) => object | Promise<object>>} */
export const modalHandlers = new Map(Object.entries({ ...reportModals, ...appealModals }));

/**
 * @param {string} customId
 * @returns {{ name: string, args: string[] }}
 */
export function parseCustomId(customId) {
  const [name, ...args] = String(customId ?? '').split(':');
  return { name, args };
}
