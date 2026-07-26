-- Per-guild switch for the escalation ladder. NULL = inherit
-- MODERATION_ESCALATION_ENABLED; 1 = on, 0 = off.
--
-- Off means no timeouts are handed out. Strikes are still recorded, so the
-- record stays complete and turning it back on picks up where it left off.
ALTER TABLE guild_settings ADD COLUMN escalation_enabled INTEGER;
