-- Initial schema.
--
-- moderation_queue: metadata only, never message content. A row means "this
-- message was flagged and will be enforced at due_at unless the author deletes
-- it first". Rows are removed on enforcement, so an existing row also means
-- "this user currently has an open violation" (read by the chat prompt builder).
CREATE TABLE moderation_queue (
  message_id       TEXT PRIMARY KEY,
  guild_id         TEXT NOT NULL,
  channel_id       TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  categories       TEXT NOT NULL DEFAULT '[]',  -- JSON array of category slugs
  warned_at        TEXT NOT NULL,               -- ISO-8601 UTC
  due_at           TEXT NOT NULL,               -- ISO-8601 UTC
  scold_message_id TEXT                         -- NULL when the scold reply failed
);

CREATE INDEX idx_queue_due ON moderation_queue (due_at);
CREATE INDEX idx_queue_user ON moderation_queue (user_id);

-- chat_history: Mai's short-term memory, the one deliberate exception to the
-- no-content rule. `username` and `content` are AES-256-GCM ciphertext (see
-- db/crypto.js); channel_id and sent_at stay plaintext as lookup/pruning keys.
-- Rows are pruned after CHAT_HISTORY_MAX_AGE_HOURS on every enforcer tick.
CREATE TABLE chat_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  guild_id   TEXT,                              -- NULL for direct messages
  user_id    TEXT,                              -- NULL for Mai's own turns
  username   TEXT,                              -- encrypted
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT NOT NULL,                     -- encrypted
  sent_at    TEXT NOT NULL                      -- ISO-8601 UTC
);

CREATE INDEX idx_history_channel ON chat_history (channel_id, sent_at);
CREATE INDEX idx_history_sent ON chat_history (sent_at);
