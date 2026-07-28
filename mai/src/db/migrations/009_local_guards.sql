-- Per-guild rules Mai enforces without asking a classifier: invites, links,
-- mass mentions and message floods.
--
-- The classifier scores what a message *means*; none of these are about
-- meaning. A raid posts twenty harmless lines in five seconds, an ad is a
-- perfectly polite invite link, and a mass ping is one word plus fifty
-- mentions. All four are decided locally, before any API call, so they cost no
-- tokens and keep working while the provider is down.
--
-- NULL = inherit the process default, like every other column in this table.

-- Refuse Discord invite links (discord.gg/…, discord.com/invite/…). 1 = on.
ALTER TABLE guild_settings ADD COLUMN invite_filter INTEGER;

-- What to do with links in general: 'off' = nothing, 'allowlist' = only the
-- domains in link_domains are allowed and every other link counts as a
-- violation. NULL = inherit MODERATION_LINK_POLICY.
ALTER TABLE guild_settings ADD COLUMN link_policy TEXT;

-- Comma-separated host names the allowlist policy permits (a subdomain of a
-- listed domain is covered). Only read when link_policy is 'allowlist'.
ALTER TABLE guild_settings ADD COLUMN link_domains TEXT;

-- Most user/role mentions (including @everyone and @here) one message may
-- carry. 0 = no cap.
ALTER TABLE guild_settings ADD COLUMN mention_cap INTEGER;

-- Message flood rule as 'count/seconds' (e.g. '6/10'): more than `count`
-- messages from the same member in that many seconds is a violation. Empty or
-- NULL = off. One trip per burst, not one per message: see heuristics.js.
ALTER TABLE guild_settings ADD COLUMN flood_rule TEXT;
