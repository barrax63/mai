-- The observation week, made real.
--
-- Mai's introduction promised a server that `observe` means "I watch for a
-- week, then you know whether my line matches yours". Nothing in the code knew
-- about a week: shadow mode was a flag that stayed on until somebody
-- remembered to turn it off, which for most servers means forever, which means
-- a moderation bot that never moderates.
--
-- `shadow_until` is that promise as a date. The enforcer tick, which already
-- runs every minute, switches the guild back to enforcing when it passes and
-- says so in the log channel. NULL = shadow mode with no end, which is what an
-- explicit `/mod config set shadow:true` means: a deliberate, open-ended
-- choice rather than an observation period.
ALTER TABLE guild_settings ADD COLUMN shadow_until TEXT;

-- How much Mai would have acted on during that window, so the closing entry
-- can say "23 Nachrichten hätte ich gelöscht" instead of leaving staff to
-- count log entries by hand.
--
-- A count, deliberately, and not a list: the observation period is a question
-- about *the server's line*, not about individuals, and recording named
-- members for something they were never told about (and that never happened to
-- them) is exactly the file this project does not keep. The per-message detail
-- is already in their own log channel, where it expires with the channel.
--
-- Bookkeeping like `onboarded_at`: not in the SETTINGS map, so `/mod config`
-- can neither set nor reset it, and `configuredGuildCount` ignores it.
ALTER TABLE guild_settings ADD COLUMN shadow_hits INTEGER NOT NULL DEFAULT 0;
