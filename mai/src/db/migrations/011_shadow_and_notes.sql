-- Two things staff needed before and after a moderation decision.
--
-- 1. `shadow_mode`: classify, report, but do not act.
--
--    Picking a threshold used to mean tuning by deletion: raise it, wait, see
--    whether the wrong messages disappeared, apologise, lower it again. In
--    shadow mode every verdict is written to the log channel with the score
--    that produced it, and nothing else happens: no reaction, no scold, no
--    queue row, no strike, no timeout. A server can watch for a week and read
--    the number off the entries.
--
--    Queue rows that already exist are still enforced: shadow mode stops new
--    flags, it is not a pause (`/mod off` is).
--
--    NULL = inherit MODERATION_SHADOW.
ALTER TABLE guild_settings ADD COLUMN shadow_mode INTEGER;

-- 2. `member_notes`: what staff know about a member that no counter records.
--
--    "Warned them in voice", "is 14", "the joke is between them and their
--    friend": the things a moderation team currently keeps in its own heads or
--    in a pinned message somewhere, and loses when the person who knew it is
--    off that week.
--
--    Deliberately plaintext, unlike `chat_history` and `evidence`. Those hold
--    text members wrote, taken from them by the bot. A note is written *by*
--    staff *for* staff about their own server, in the same class as a report
--    reason (which is already posted into a Discord channel in the clear).
--    Pruned on the same window as the strike record, so it is not an
--    unbounded file on a member either.
CREATE TABLE member_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  author_id  TEXT NOT NULL,             -- the moderator who wrote it
  note       TEXT NOT NULL,
  created_at TEXT NOT NULL              -- ISO-8601 UTC
);

CREATE INDEX idx_notes_member ON member_notes (guild_id, user_id, created_at);
CREATE INDEX idx_notes_created ON member_notes (created_at);
