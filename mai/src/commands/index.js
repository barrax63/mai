/**
 * Command registry.
 *
 * A command module exports `{ definition, execute }` and may add:
 *   deferred     boolean | (interaction) => boolean — answer with a placeholder
 *                first and edit it when `execute` resolves (anything slower than
 *                Discord's ~3 s budget: model calls, Discord REST round trips)
 *   ephemeral    boolean | (interaction) => boolean — only for deferred
 *                commands; fixes the visibility of the placeholder, which the
 *                later edit cannot change
 *   autocomplete (interaction) => choices[] — for options with autocomplete
 *
 * To add a command:
 *   1. Create a file in this directory exporting the object above.
 *   2. Import and add it to the `commands` array below.
 *   3. Run `npm run register` to sync definitions with Discord.
 *
 * Buttons, select menus and modals are registered separately, in
 * `src/interactions/registry.js`.
 */
import { mai } from './mai.js';
import { mod } from './mod.js';
import { ping } from './ping.js';
import { report } from './report.js';

export const commands = [ping, mai, mod, report];

/** Command definitions in the shape Discord's registration API expects. */
export const commandDefinitions = commands.map((command) => command.definition);

/** Lookup map: command name -> command module. Used by the interaction router. */
export const commandHandlers = new Map(
  commands.map((command) => [command.definition.name, command]),
);
