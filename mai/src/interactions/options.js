/**
 * Reading Discord's nested command options.
 *
 * Kept separate from `router.js` so command modules can use it without an import
 * cycle (the router imports the command registry, which imports the commands).
 */
const SUBCOMMAND = 1;
const SUBCOMMAND_GROUP = 2;

/**
 * Flattens the option tree into the one shape handlers want.
 *
 * `/mod status`         -> { group: null,     name: 'status', options: [] }
 * `/mod config set x:1` -> { group: 'config', name: 'set',    options: [x] }
 *
 * @param {object} interaction
 * @returns {{ group: string | null, name: string | undefined, options: object[] }}
 */
export function resolveSubcommand(interaction) {
  const first = interaction.data?.options?.[0];

  if (first?.type === SUBCOMMAND_GROUP) {
    const second = first.options?.[0];
    return { group: first.name, name: second?.name, options: second?.options ?? [] };
  }

  if (first?.type === SUBCOMMAND || first?.options) {
    return { group: null, name: first.name, options: first.options ?? [] };
  }

  // A command without subcommands: its options sit directly on `data`.
  return { group: null, name: undefined, options: interaction.data?.options ?? [] };
}

/**
 * @param {object[]} options
 * @param {string} name
 * @returns {string | number | boolean | undefined}
 */
export const optionValue = (options, name) =>
  options?.find((option) => option.name === name)?.value;
