-- The score distribution of one server's own traffic, so the threshold can be
-- read off it instead of guessed.
--
-- `MODERATION_THRESHOLD` was the hardest number in the whole system to choose
-- and the one with the worst way of finding out you were wrong. The provider
-- scores the same insult 0.88 in English and 0.20 in German, so its own
-- `flagged` boolean leaves a German server effectively unmoderated, and the
-- documented remedy was "start around 0.2 and watch": tuning by deleting the
-- wrong messages until it looks about right.
--
-- The observation period already watches a week of real traffic without acting
-- on it. This is the same week, counted: one row per bucket per guild, twenty
-- buckets of 0.05, incremented with the **top** category score of every message
-- that was classified during the window. At the end there is a distribution to
-- pick a percentile off, and the number is the server's own rather than a guess
-- from somebody who has never read a line of it.
--
-- Two things this deliberately is not:
--
--   * It counts *every* classified message, not only the ones that were flagged.
--     A histogram of what the provider already flagged cannot say the line is
--     too high, because the messages that prove it are precisely the ones it
--     did not flag.
--   * It is per guild and per bucket, never per member and never per message.
--     No id, no timestamp, no content: the same rule `shadow_hits` follows. What
--     it can answer is "how does this server's traffic score", and nothing about
--     any person in it. The rows are dropped as soon as the window they belong
--     to has been read.
CREATE TABLE IF NOT EXISTS shadow_scores (
  guild_id TEXT NOT NULL,
  -- 0-19: bucket n covers scores in [n * 0.05, (n + 1) * 0.05).
  bucket INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, bucket)
);
