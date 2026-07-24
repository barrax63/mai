# n8n workflows

Two workflows implement AI-based message moderation for all guilds the bot forwards messages from. They communicate exclusively through a shared n8n data table (the "privacy queue") — no message content is ever persisted, only IDs and timestamps. A third workflow ("Mai Chat") answers messages addressed to the bot in its cat persona; unlike moderation it keeps a short conversation memory **including content** (see below).

```text
mai (bot) ──POST──▶ Check Messages (webhook)
                        │  classify content (OpenAI)
                        │  flagged: react 😡 + store metadata in queue + scold reply
                        ▼
                      privacy queue (data table "Discord Server Moderation v3")
                        ▲
                        │  every minute: read due rows
Delete Messages (scheduler)
   delete message from Discord + DM warning to author
```

## Files

| File | Workflow name in n8n | Trigger |
|------------------------------------------|--------------------------------------------|--------------------|
| `discord-server-moderation-webhook.json` | Discord Server Moderation (Check Messages) | Webhook (POST) |
| `discord-server-moderation-scheduler.json` | Discord Server Moderation (Delete Messages) | Schedule (1 min) |
| `discord-server-mai-chat-webhook.json` | Discord Server Moderation (Mai Chat) | Webhook (POST) |

## Check Messages (webhook workflow)

Receives every message the bot forwards, classifies it, and flags violations.

1. **Webhook** — POST endpoint with header auth. The bot authenticates with `<N8N_WEBHOOK_HEADER>: <N8N_WEBHOOK_SECRET>` (exact value match, no `Bearer` prefix). Responds via "Respond to Webhook" nodes, so the bot receives the final verdict.
2. **Classify for Violations** — OpenAI moderation classify on `body.content`.
3. **Violation?**
   - **No** → responds `{ "action": "ok" }`.
   - **Yes** → reacts with the warning emoji on the message, posts a random scold line (`flagReplies`) as a `#` markdown headline in a Discord reply to the flagged message (the reply-ping to the author is the only ping), stores metadata in the queue (message/guild/channel/user IDs, flagged categories, `dueAt` = now + grace period, `scoldMessageId` of the scold message), then responds `{ "action": "flagged", "categories": [...], "dueAt": "..." }`. The scold message is best-effort (`onError: continue`, empty `scoldMessageId` on failure). The bot suppresses Mai's chat answer for flagged messages that mention her — the scold message takes its place.

Expected request body (sent by the bot):

```json
{
  "messageId": "…", "guildId": "…", "channelId": "…", "userId": "…",
  "username": "…", "content": "…", "attachments": [], "createdAt": "ISO-8601"
}
```

`messageId`, `guildId`, `channelId`, and `userId` are required; the workflow fails fast if any is missing.

## Mai Chat (webhook workflow)

Answers messages that mention the bot or reply to one of its messages. The bot strips its own mention and posts to this workflow's webhook (`N8N_CHAT_WEBHOOK_URL`, same header-auth credential as moderation).

1. **Webhook** — POST endpoint with header auth, responds via "Respond to Webhook" (the bot shows a typing indicator until then).
2. **Ensure Chat History / Get History** — data table `Mai Chat History v1` (columns `channelId, guildId, userId, username, role, content, sentAt` — `createdAt` is reserved by n8n as a system column), created on demand. The latest `historyTurns` rows of the channel provide conversation context.
3. **Mai Thinks** — OpenAI chat completion with the persona system prompt from Central Config.
4. **Extract Reply / Send Reply** — sanitizes the model output (length cap, `@everyone`/`@here` neutralized) and responds `{ "reply": "…" }`.
5. **Store Chat Turns / Prune Old Turns** — appends both turns to the history table, then deletes rows older than `historyMaxAgeHours`.

Request body (sent by the bot): `{ messageId, guildId, channelId, userId, username, content, createdAt }` — `content` is the message with the bot mention removed; empty content = a bare poke, answered with a greeting.

**Privacy note:** this table stores message content — a deliberate exception to the moderation privacy rule. Only messages deliberately addressed to Mai land here, and rows are pruned after `historyMaxAgeHours` (default 48 h).

Central Config knobs: `historyTableName`, `historyTurns`, `historyMaxAgeHours`, `maxReplyChars`, `persona`. Schema changes: bump the `historyTableName` suffix (`v1` → `v2`).

## Delete Messages (scheduler workflow)

Runs every minute and enforces the grace period.

1. **Get Due Warnings** — queue rows with `dueAt <= now`.
2. **Check Pending Message** — does the message still exist on Discord?
   - **Deleted by the author** → the now-orphaned scold reply is deleted (if one was stored) and the queue row is removed — the grace period did its job.
   - **Still there** → message and its scold reply are deleted, queue row removed, and the author receives a DM listing the removed messages (grouped per user, sanitized, trimmed to Discord's length limit) with category and timestamp.

   Scold-reply deletion is best-effort in both branches (`onError: continue`) — a manually deleted scold reply never blocks queue cleanup.

All Discord operations take `guildId` from the queue row — the workflows are guild-agnostic. Which guilds get moderated is decided solely by the bot's `DISCORD_GUILD_IDS` allowlist.

## Configuration

Each workflow has a single **Central Config** code node as its only configuration surface:

| Workflow | Knob | Meaning |
|-----------------|----------------------|--------------------------------------------|
| Check Messages | `gracePeriodMinutes` | Time the author has to self-delete |
| Check Messages | `warningEmoji` | Reaction placed on flagged messages |
| Check Messages | `flagReplies` | Scold lines; one random pick replied per flagged message |
| both | `queueTableName` | Shared queue table — **must match in both** |
| Delete Messages | `timezone` | Timestamp formatting in the warning DM |
| Delete Messages | `warningFooter` | Closing line of the warning DM |

**Queue schema changes:** the queue table is created on demand (`createIfNotExists`) with columns `messageId, guildId, channelId, userId, categories, warnedAt, dueAt, scoldMessageId`. When the schema changes, bump the `queueTableName` suffix (e.g. `v3` → `v4`) in **both** workflows; the old table can then be deleted in the n8n UI.

## Setup

1. Import the JSON files into n8n.
2. Ensure credentials exist: Discord Bot API, OpenAI, and a Header Auth credential whose header name/value match `N8N_WEBHOOK_HEADER` / `N8N_WEBHOOK_SECRET` in the bot's `.env`. All webhooks share the same header-auth credential.
3. Activate the workflows.
4. Point the bot's `N8N_WEBHOOK_URL` (moderation) and `N8N_CHAT_WEBHOOK_URL` (Mai Chat) at the **production** webhook URLs (`/webhook/…`, not `/webhook-test/…`).

The `/webhook-test/…` URL only works while "Listen for test event" is active in the editor and accepts a single request — use it for debugging only.
