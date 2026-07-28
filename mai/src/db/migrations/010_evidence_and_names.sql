-- Two things staff asked for that the record could not answer.
--
-- 1. `evidence`: what a deleted message actually said, for the moderator who has
--    to decide an appeal about it.
--
--    Until now the answer was nothing: the log holds ids and category slugs, the
--    message itself is gone, and the only place its text was ever quoted is the
--    offender's own DM. So an appeal reading "das war doch nur ein Zitat" left
--    staff choosing between the member's word and Mai's, with no way to look.
--
--    This is the **second** deliberate exception to the no-content rule, and the
--    narrowest one:
--      - off unless a guild switches it on *and* the operator set a retention
--        window (MODERATION_EVIDENCE_HOURS above 0);
--      - only messages Mai actually enforced, never a message that merely
--        passed by;
--      - `content` is AES-256-GCM ciphertext (db/crypto.js), like chat_history;
--      - hours, not days: it exists for the appeal window, not as an archive;
--      - and it is never posted into a channel. Staff read it ephemerally
--        through a button on the appeal entry, which is one moderator seeing it
--        once, not a permanent copy in a room full of people.
CREATE TABLE evidence (
  message_id TEXT PRIMARY KEY,
  guild_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  content    TEXT NOT NULL,               -- encrypted
  attachments INTEGER NOT NULL DEFAULT 0, -- count only; files are never fetched
  categories TEXT NOT NULL DEFAULT '[]',  -- JSON array of category slugs
  created_at TEXT NOT NULL                -- ISO-8601 UTC, = enforcement time
);

CREATE INDEX idx_evidence_member ON evidence (guild_id, user_id, created_at);
CREATE INDEX idx_evidence_created ON evidence (created_at);

-- Whether this guild keeps evidence at all. NULL = inherit
-- MODERATION_EVIDENCE (which is itself off by default). Storing a member's
-- deleted words is a decision each server makes for itself.
ALTER TABLE guild_settings ADD COLUMN evidence_enabled INTEGER;

-- 2. `name_check`: what to do about a member whose display name is the
--    violation. A nickname is on every message they send and no message-level
--    rule can ever see it.
--
--    'off' = ignore, 'log' = tell the log channel, 'reset' = also remove the
--    guild nickname (a global username is not Mai's to change, and never a kick
--    or a ban: same ceiling as everywhere else). NULL = inherit
--    MODERATION_NAME_CHECK.
ALTER TABLE guild_settings ADD COLUMN name_check TEXT;
