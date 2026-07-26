-- Strike history: what was enforced, per member and guild.
--
-- The moderation queue only holds *pending* violations and is emptied on
-- enforcement, so until now a repeat offender looked identical to a first-timer
-- ten minutes later. This table is the long-term record the escalation ladder
-- counts against.
--
-- Metadata only, like the queue: ids, category slugs, timestamps. Never content.
-- Rows are pruned after VIOLATION_RETENTION_DAYS.
CREATE TABLE violations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  message_id TEXT NOT NULL,
  categories TEXT NOT NULL DEFAULT '[]',  -- JSON array of category slugs
  -- 'deleted'      = the grace period expired and Mai removed the message
  -- 'self_deleted' = the author removed it themselves; recorded for the record,
  --                  but it does not count towards escalation
  action     TEXT NOT NULL,
  created_at TEXT NOT NULL                -- ISO-8601 UTC
);

CREATE INDEX idx_violations_member ON violations (guild_id, user_id, created_at);
CREATE INDEX idx_violations_created ON violations (created_at);

-- Per-guild escalation, both NULL = inherit the process defaults.
ALTER TABLE guild_settings ADD COLUMN timeout_ladder TEXT;
ALTER TABLE guild_settings ADD COLUMN strike_window_days INTEGER;
