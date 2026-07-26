-- Per-guild kill switch (`/mod off`). NULL = inherit the process default
-- (on); 1 = active, 0 = paused.
--
-- Paused means Mai does nothing in that guild: no moderation, no chat, no
-- reactions, no welcome, and no enforcement of rows already queued. The rows
-- are kept, so resuming picks up where it left off rather than quietly
-- forgiving everything.
ALTER TABLE guild_settings ADD COLUMN enabled INTEGER;
