/**
 * Command registry.
 *
 * To add a new slash command:
 *   1. Create a file in this directory exporting { definition, execute }.
 *   2. Import and add it to the `commands` array below.
 *   3. Run `npm run register` to sync definitions with Discord.
 */
import { ping } from './ping.js';

const commands = [ping];

/** Command definitions in the shape Discord's registration API expects. */
export const commandDefinitions = commands.map((command) => command.definition);

/** Lookup map: command name -> handler. Used by the interactions endpoint. */
export const commandHandlers = new Map(
  commands.map((command) => [command.definition.name, command.execute]),
);
