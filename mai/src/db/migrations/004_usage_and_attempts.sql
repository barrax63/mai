-- Token accounting. One row per day, guild, model and purpose; counters are
-- incremented in place, so the table stays small (a handful of rows per day).
-- No message data, only how much was spent and on what.
CREATE TABLE usage_daily (
  day               TEXT NOT NULL,               -- YYYY-MM-DD, UTC
  guild_id          TEXT NOT NULL DEFAULT '',    -- '' = direct messages
  model             TEXT NOT NULL,
  purpose           TEXT NOT NULL,               -- 'chat' | 'moderation'
  calls             INTEGER NOT NULL DEFAULT 0,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, guild_id, model, purpose)
);

CREATE INDEX idx_usage_day ON usage_daily (day);

-- How often the enforcer tried and failed to act on a row (missing permission,
-- transient API error). Lets a permanently stuck row report itself once instead
-- of failing silently every minute forever.
ALTER TABLE moderation_queue ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
