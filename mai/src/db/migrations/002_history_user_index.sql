-- `/mai forget` deletes a caller's own turns and wipes the DM channels they
-- appear in, both of which look up rows by user_id.
CREATE INDEX idx_history_user ON chat_history (user_id);
