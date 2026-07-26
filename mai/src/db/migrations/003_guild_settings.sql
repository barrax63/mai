-- Per-guild overrides. Mai serves several servers from one process, and they
-- disagree about where she should log and how long the grace period is.
--
-- A NULL column means "inherit the process default" (from .env), so a row only
-- ever states what a server actually changed.
CREATE TABLE guild_settings (
  guild_id             TEXT PRIMARY KEY,
  log_channel_id       TEXT,     -- moderation log target; NULL = no mod log
  welcome_channel_id   TEXT,     -- NULL = the guild's system channel
  grace_period_minutes INTEGER,  -- NULL = MODERATION_GRACE_PERIOD_MINUTES
  updated_at           TEXT NOT NULL,
  updated_by           TEXT      -- user id of whoever ran /mod config
);
