-- Per-guild moderation policy: where Mai looks, and how hard she judges.
--
-- All three are NULL = inherit the process default, like every other column in
-- this table.

-- Comma-separated channel IDs Mai does not moderate at all (a vent channel, an
-- NSFW channel, a staff channel). Chat and reactions are unaffected — this is
-- about the delete/scold pipeline only. A thread is covered by exempting its
-- parent channel.
ALTER TABLE guild_settings ADD COLUMN exempt_channels TEXT;

-- Minimum category score (0-1) for a message to count as a violation, from the
-- moderation endpoint's `category_scores`. NULL or 0 = trust the provider's own
-- `flagged` boolean instead, which is the previous behaviour.
--
-- This exists because that boolean is tuned for English: measured against
-- omni-moderation-latest, the same insult scores 0.88 in English and 0.20 in
-- German, so a German-speaking server sees most of its abuse pass. A threshold
-- lets such a guild decide for itself where the line sits.
ALTER TABLE guild_settings ADD COLUMN moderation_threshold REAL;

-- Comma-separated category slugs that count at all (e.g. 'hate,sexual/minors').
-- NULL = every category the provider reports. Lets a server ignore a category
-- its culture handles differently without switching moderation off wholesale.
ALTER TABLE guild_settings ADD COLUMN moderation_categories TEXT;
