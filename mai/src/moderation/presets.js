/**
 * Whole settings bundles, so a new server is one decision instead of seventeen.
 *
 * `/mod config set` exposes every knob individually, which is right for tuning
 * and wrong for the first ten minutes: an admin who has just added Mai has no
 * way to know whether a mention cap of 6 is sensible, and the honest default
 * for every one of those knobs is "off", so a server that never gets round to
 * it is running a moderation bot that moderates nothing.
 *
 * A preset is a starting point, not a mode: it writes ordinary per-guild
 * settings through the ordinary path, every one of which can be changed
 * afterwards with `/mod config set` or put back with `/mod config reset`.
 *
 * Three of them, and the order matters:
 *
 *   - `observe` is the recommended first step and the reason shadow mode
 *     exists. Everything detects, nothing acts: a week of it tells a server
 *     what Mai would have done to its own traffic, which is the only honest
 *     way to find out whether her line sits where theirs does.
 *   - `standard` is that same detection, enforced.
 *   - `strict` is for a server that already knows it has a problem.
 *
 * **No preset touches `threshold`** except `strict`, deliberately. The
 * provider's own line is tuned for English and a German server needs a number
 * instead, but guessing that number for a server nobody has looked at is
 * exactly the tuning-by-deletion this whole feature set exists to avoid: run
 * `observe`, read the scores off the log, then set it with `/mod simulate` in
 * hand.
 *
 * `enabled` is never in a bundle either: applying a preset must not quietly
 * undo somebody's `/mod off`.
 */

/**
 * Public preset names, as used by `/mod setup` and the onboarding buttons.
 *
 * `settings` is an ordinary patch of public setting names. `observing` marks
 * the one preset that is a *period* rather than a state: it starts a window
 * that ends by itself, because "I watch for a week and then you decide" is what
 * Mai's introduction promises, and a promise nobody has to remember to collect
 * on is the only kind worth making to a server that has just installed a bot.
 */
export const PRESETS = Object.freeze({
  observe: Object.freeze({
    observing: true,
    settings: Object.freeze({
      shadow: true,
      escalation: false,
      'invite-filter': true,
      'mention-cap': 6,
      flood: '6/10',
      'name-check': 'log',
    }),
  }),

  standard: Object.freeze({
    observing: false,
    settings: Object.freeze({
      shadow: false,
      escalation: true,
      'invite-filter': true,
      'mention-cap': 6,
      flood: '6/10',
      'name-check': 'log',
    }),
  }),

  strict: Object.freeze({
    observing: false,
    settings: Object.freeze({
      shadow: false,
      escalation: true,
      'invite-filter': true,
      'mention-cap': 5,
      flood: '5/10',
      'name-check': 'reset',
      // The one preset that takes the decision away from the provider, because
      // a server asking for `strict` has already decided its line is lower.
      threshold: 0.3,
      grace: 5,
    }),
  }),
});

export const PRESET_NAMES = Object.freeze(Object.keys(PRESETS));

/**
 * @param {string} name
 * @returns {{ settings: Record<string, unknown>, observing: boolean } | null}
 *   A fresh patch, or null when the name is not one of ours (it can arrive
 *   from a `custom_id`).
 */
export function preset(name) {
  // Own properties only: the name comes off a component id, and a plain lookup
  // would also answer for everything on Object.prototype.
  if (!Object.hasOwn(PRESETS, String(name))) return null;

  const found = PRESETS[name];
  return { settings: { ...found.settings }, observing: found.observing };
}
