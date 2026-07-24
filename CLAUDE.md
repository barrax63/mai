# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Discord moderation system in three parts:

1. **`mai/`** — Node.js 22 ESM app (discord.js + express + discord-interactions + pino). Runs two Discord connections side by side: an HTTP interactions endpoint (`POST /interactions`, slash commands, reached through cloudflared) and an outbound gateway WebSocket (`messageCreate` events). The gateway handler forwards messages to an n8n webhook and receives a moderation verdict as the HTTP response. The bot has a persona — **Mai**, the server's cat: mention/reply/DM chat (via the Mai Chat workflow), keyword emoji reactions, optional welcome messages, custom presence. Persona text lives in the workflow's Central Config; welcome lines and reaction triggers live in `src/gateway/events/`.
2. **`n8n/`** — three workflow JSON files (import into n8n; edited here as versioned artifacts). "Check Messages" (webhook-triggered) classifies content via OpenAI and flags violations; "Delete Messages" (1-min scheduler) enforces a grace period, deletes flagged messages, and DMs the author. They share state only through an n8n data table ("privacy queue") holding metadata, never content. "Mai Chat" (webhook-triggered) answers messages addressed to the bot in character; its history table (`Mai Chat History v2`) is the **one deliberate exception to the no-content rule** — it stores chat turns of users who addressed Mai directly, pruned after `historyMaxAgeHours`. The `content` and `username` columns are obfuscated (reversible XOR+base64 with `historyKey`), keyed on plaintext `channelId`.
3. **`docker-compose.yml`** — stack of `mai` + `cloudflared` on the `edge` network.

Full details: [README.md](README.md), [mai/README.md](mai/README.md), [n8n/README.md](n8n/README.md).

## Commands

```sh
docker compose up -d --build mai   # rebuild + restart bot after code changes
docker compose logs -f mai         # structured pino JSON logs
docker compose run --rm mai npm run register   # sync slash commands with Discord
node --check src/index.js          # (in mai/) syntax check; no test suite exists
```

- **`.env` changes require container recreate** (`docker compose up -d mai`). A plain restart does not re-read the env file — this has caused real debugging sessions.
- `.env` holds all secrets (gitignored); `.env.example` is the documented template. Config is read and validated once in `mai/src/config.js` — add new env vars there, not via scattered `process.env` reads.

## Architecture constraints that aren't obvious from single files

- **Interactions vs. gateway split**: slash commands arrive over HTTP (signature-verified by `verifyKeyMiddleware` — no `express.json()` may run before it on that route); message events only exist on the gateway. New slash command = file in `src/commands/` + entry in `src/commands/index.js` + `npm run register`. New gateway event = handler in `src/gateway/events/` + `client.on()` in `src/gateway/client.js`.
- **n8n webhook contract** (`src/n8n/webhook.js`): auth is n8n header auth — exact value match, `<N8N_WEBHOOK_HEADER>: <N8N_WEBHOOK_SECRET>`, **no `Bearer` prefix**. The workflow responds only after fully processing ("Respond to Webhook" node), so the timeout covers the whole workflow run. Never retry on 4xx or timeout (a timed-out workflow already executed — retrying double-processes the message); retry only 5xx/connection errors. Production webhook path is `/webhook/…`; `/webhook-test/…` only works while n8n's "Listen for test event" is armed. Two targets share this contract and the same header/secret: moderation (`N8N_WEBHOOK_URL`) and Mai chat (`N8N_CHAT_WEBHOOK_URL`, responds `{ reply }`). Moderation always runs for guild messages, also for chat-addressed ones; direct messages skip moderation entirely (a bot cannot delete a DM).
- **Welcome messages need a privileged intent**: the `GuildMembers` intent is only requested when `DISCORD_WELCOME_ENABLED=true` — enabling the flag without switching on "Server Members Intent" in the Developer Portal makes the gateway login fail. Don't add the intent unconditionally.
- **Direct messages are chat-only, and allowlist-gated by membership**: a DM has no `guildId`. `isMaiChatTrigger` treats any DM as addressed to Mai (no mention required), but `onMessageCreate` first calls `isDmAuthorInAllowedGuild` — the DM is dropped unless the author shares at least one `DISCORD_GUILD_IDS` guild with the bot (empty allowlist = open). This is a per-member REST fetch (`guild.members.fetch(id)`, no privileged intent needed), the DM equivalent of the guild allowlist. `onMessageCreate` skips the moderation forward for DMs — a bot cannot delete a user's DM, so the delete/scold pipeline has nothing to enforce. DMs need the non-privileged `DirectMessages` intent **plus** `Partials.Channel` (both in `gateway/client.js`); no Developer Portal toggle. The chat payload's `guildId` is `null` for DMs — keep the chat workflow keyed by `channelId`.
- **LLM output never pings**: Mai's replies are posted with `allowedMentions: { parse: [] }` and the workflow neutralizes `@everyone`/`@here`. Keep both when touching the chat path.
- **Guild targeting lives in the bot, not the workflows**: `DISCORD_GUILD_IDS` is the whole-bot allowlist — routed through `isGuildAllowed(guildId)` in `config.js` and enforced once at each entry point (`onMessageCreate`, the `/interactions` command handler, `guildMemberAdd`), so an un-listed guild gets no behavior at all, not merely no forwarding. DMs have no guildId and use `isDmAuthorInAllowedGuild` instead (shared-guild membership check). Workflows stay guild-agnostic and take `guildId` from the webhook body / queue rows. Don't reintroduce server IDs into workflow config.
- **Privacy queue schema**: columns `messageId, guildId, channelId, userId, categories, warnedAt, dueAt, scoldMessageId`, created on demand. On schema change, bump the `queueTableName` version suffix (e.g. `v3` → `v4`) in the Central Config node of **both** workflows.
- **Logging privacy rule**: message content is never logged at `info` — metadata only; content appears at `debug` level only. This covers **both directions**: inbound message text and Mai's chat replies, and n8n workflow **response bodies** (`webhook.js` logs the verdict `action` + field names at info, the full body only at debug — the chat `{ reply }` is content). Usernames are content too; `userId`/`authorId` snowflakes are metadata and may be logged at info. Keep this when adding handlers.
- **Hardened containers**: `read_only` rootfs, `cap_drop: ALL`, tmpfs-only writes, non-root `node` user. Code writing outside `/tmp` will fail at runtime. Compose v2.40 quirk: `pids_limit` cannot coexist with `deploy.resources.limits` — the pid limit lives at `deploy.resources.limits.pids`.
- **Workflow JSON editing**: n8n code-node sources are single-line JSON-escaped strings; beware mojibake when round-tripping emoji/umlauts (has bitten this repo repeatedly). Node references like `$('Central Config')` must resolve within the same workflow — when splitting workflows, copy the referenced nodes.
