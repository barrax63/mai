/**
 * Whole settings bundles, so a new server is one decision instead of seventeen.
 *
 * `/mod config set` exposes every knob individually, which is right for tuning
 * and wrong for the first ten minutes: an admin who has just added Mai has no
 * way to know whether a mention cap of 6 is sensible, and the honest default
 * for every one of those knobs is "off", so a server that never gets round to
 * it is running a moderation bot that moderates nothing.
 *
 * A preset is a starting point, not a mode: every value in one can be changed
 * afterwards with `/mod config set` or put back with `/mod config reset`. It is
 * a *layer* rather than a copy, though: `/mod setup` records the name and
 * `effectiveSettings` resolves through it, so a server stores the one decision
 * it made instead of six values it never looked at, and improving a bundle here
 * reaches every server already on it.
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
 * What a setting means for a server that has chosen nothing at all: no profile,
 * no override, which is every server until somebody runs `/mod setup`.
 *
 * These used to be thirteen environment variables, one per knob, and the layer
 * they formed was the problem rather than the solution. A process-wide default
 * for a *per-server* policy is only meaningful in a deployment with one server,
 * and in a deployment with several it silently decided things for servers whose
 * staff had never heard of the operator's `.env`. Answering "why did Mai delete
 * that?" meant reading a file, a database row and a preset and knowing which of
 * the three won. Now it means reading `/mod config view`.
 *
 * The values are what those variables shipped as, so a server that had
 * configured nothing before this existed behaves exactly the same after it.
 * Note what that means: **almost everything is off**. These are a floor, not a
 * recommendation. The recommendation is a profile, which is what `/mod setup`
 * and the buttons in Mai's introduction are for.
 *
 * Written as public setting names with the values `/mod config set` accepts, so
 * they go through the same validation as anything a moderator types (see
 * `compile` in db/settings.js): a typo here fails at startup rather than at the
 * moment somebody earns a timeout.
 */
export const BASE_SETTINGS = Object.freeze({
  escalation: true,
  grace: 10,
  // Nothing for a first offence (the deletion is the message), then 5, 15, 30,
  // 60 minutes, the last step repeating. A ladder that reaches a day off the
  // fourth strike is a punishment; this one is a cooling-off period, which is
  // what an automated ceiling should be when the thing deciding is a classifier.
  'timeout-ladder': '0,5,15,30,60',
  // How long a strike keeps counting towards the next step. Short on purpose:
  // the ladder is about the argument someone is having this week, not a file on
  // them. `VIOLATION_RETENTION_DAYS` is how long the *record* lives.
  'strike-window': 7,
  // 0 = the provider's own `flagged` decides. Worth raising for a non-English
  // server, which is what `/mod setup observe` plus `/mod simulate` are for.
  threshold: 0,
  // Empty = every category the provider reports counts.
  categories: '',
  // The house rules, all off: they are a server's own decision, not a floor.
  'invite-filter': false,
  'link-policy': 'off',
  'link-domains': '',
  'mention-cap': 0,
  flood: '',
  // Keeping a member's deleted words needs the operator's retention window too
  // (`MODERATION_EVIDENCE_HOURS`), which `effectiveSettings` folds in.
  evidence: false,
  shadow: false,
});

// `name-check` is deliberately absent, and it is the one setting whose default
// still comes from the environment (`MODERATION_NAME_CHECK`). Anything but
// `off` requests the privileged GuildMembers intent, which is decided once at
// login for the whole process, so the operator states it up front and a base
// value here would either silently disagree with what the gateway asked for or
// quietly promise a screening that cannot run. The profiles still set it, and a
// guild that does gets the warning `/mod config set name-check` already gives.

/**
 * Every setting name any bundle above decides, which is what `/mod setup` hands
 * back to the profile when it is applied.
 *
 * Applying a profile has to clear the explicit overrides for these keys, or a
 * server that ran `standard` before profiles existed (and therefore carries six
 * written columns) would switch to `strict` and keep the old numbers, with
 * `/mod config view` showing `strict` next to `standard`'s mention cap. Keys no
 * bundle mentions (the log channel, exempt channels) are untouched: those are
 * facts about the server, not a stance on moderation.
 */
export const PROFILE_KEYS = Object.freeze([
  ...new Set(Object.values(PRESETS).flatMap((entry) => Object.keys(entry.settings))),
]);

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
