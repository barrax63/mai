# Mai (Discord app)

Discord app based on the structure of [discord-example-app](https://github.com/discord/discord-example-app), extended with a gateway client. The bot is **Mai**, the server's cat — she chats, reacts, and welcomes members in character.

Two connections to Discord run side by side:

| Path | Transport | Purpose |
|------|-----------|---------|
| `POST /interactions` | HTTP (inbound via cloudflared) | Slash commands, signature-verified with the app public key |
| Gateway | WebSocket (outbound) | `messageCreate` events from every channel the bot is a member of |

The gateway connection is outbound, so message listening works even without the tunnel; cloudflared is only needed for the interactions endpoint.

The HTTP server ([src/http/server.js](src/http/server.js)) additionally serves `GET /healthz` (liveness probe used by the Docker healthcheck) and a static landing page at `GET /` (from [src/http/public/](src/http/public/)) for browsers hitting the public tunnel URL.

## n8n message forwarding

Every non-bot message with text content is forwarded to the n8n moderation webhook ([src/n8n/webhook.js](src/n8n/webhook.js)); see [../n8n/README.md](../n8n/README.md) for the workflows behind it. Behavior:

- Guild allowlist via `DISCORD_GUILD_IDS` (comma-separated IDs; empty = all guilds). This is the **whole-bot** gate, enforced once in `onMessageCreate` and in the interactions endpoint — in an un-listed guild Mai does nothing (no moderation forward, no chat, no reactions, no welcome, no slash-command response), not merely no forwarding. Direct messages are never moderated (a bot cannot delete a DM) and are allowed only from users who share a listed guild with the bot (see Chat below).
- Auth: secret sent as `<N8N_WEBHOOK_HEADER>: <N8N_WEBHOOK_SECRET>` (exact match, no `Bearer` prefix — n8n header auth).
- The n8n workflow responds only after it finished processing ("Respond to Webhook"), so the timeout (`N8N_WEBHOOK_TIMEOUT_MS`, default 30 s) covers the whole workflow run. The verdict JSON is logged and returned to the caller.
- Retries with backoff on 5xx/connection errors only; 4xx and timeouts are not retried (a timed-out workflow already ran — retrying would process the message twice).
- Attachment-only messages (no text) are skipped.
- Unset `N8N_WEBHOOK_URL` disables forwarding entirely.

## Mai persona features

All gateway-side; moderation always runs for guild messages, including chat ones. Direct messages are exempt (a bot cannot delete a DM).

- **Chat** ([src/gateway/events/mai-chat.js](src/gateway/events/mai-chat.js)): mentioning the bot, replying to one of its messages, or sending it a direct message forwards the message to the "Mai Chat" n8n workflow (`N8N_CHAT_WEBHOOK_URL`, same auth header/secret as moderation). The workflow answers in character with per-channel conversation memory; the bot posts the `reply` field back as a Discord reply. A typing indicator runs while the workflow executes. All pings inside the LLM reply are suppressed via `allowedMentions`. Unset `N8N_CHAT_WEBHOOK_URL` disables chat. Guild messages addressed to Mai are moderated **first**: a flagged message gets no chat answer — the moderation workflow posts a scold reply instead, and the message never reaches the chat workflow or its history table. Without a verdict (moderation disabled/unreachable) chat proceeds normally. **Direct messages** are always treated as addressed to Mai (no mention needed) and skip moderation entirely — they go straight to the chat workflow — but only from an author who shares at least one `DISCORD_GUILD_IDS` guild with the bot (`isDmAuthorInAllowedGuild`, a per-guild `members.fetch`; empty allowlist = open). Members of non-whitelisted guilds and strangers get no DM reply. A DM's chat payload carries a `null` `guildId`; history is keyed per channel (the DM channel is stable per user). The chat history is only Mai's short-term memory: turns (including DMs) are stored per channel in the n8n data table obfuscated and deleted after a few hours (`historyMaxAgeHours`, default 48 h). See [../n8n/README.md](../n8n/README.md) for the obfuscation details.
- **Reactions** ([src/gateway/events/reactions.js](src/gateway/events/reactions.js)): keyword triggers (fish, cat words, meowing, "gute Katze") get an emoji reaction, some only with a random chance. At most one reaction per message.
- **Welcome messages** ([src/gateway/events/guild-member-add.js](src/gateway/events/guild-member-add.js)): new members are greeted in the guild's system channel. Requires `DISCORD_WELCOME_ENABLED=true` **and** the privileged "Server Members Intent" (Developer Portal → Bot) — the flag gates the `GuildMembers` intent, because logging in with a privileged intent that is not enabled in the portal fails.
- **Presence** ([src/gateway/presence.js](src/gateway/presence.js)): custom status ("😺 schnurrt irgendwo in der Nähe", …) picked at random on gateway ready and rotated every `PRESENCE_ROTATE_HOURS` hours (default 3; 0 = no rotation).

## Setup

1. **Discord Developer Portal** (<https://discord.com/developers/applications>):
   - *Bot* → enable **Message Content Intent** (privileged; required for reading message content).
   - *Bot* → enable **Server Members Intent** (privileged) **only if** you set `DISCORD_WELCOME_ENABLED=true` — the flag makes the bot request the `GuildMembers` intent, and login fails when the portal toggle is off.
   - Direct-message replies need **no** portal toggle: the non-privileged `DirectMessages` intent is requested in code. Users can DM Mai once they share a server with her (subject to their Discord privacy settings).
   - Copy *Application ID*, *Public Key* (General Information) and *Bot Token* (Bot) into `.env`.
   - Invite the bot with the `bot` + `applications.commands` scopes.
2. **Cloudflare tunnel**: route your public hostname to `http://mai:3000`.
3. **Interactions Endpoint URL** (General Information): set to `https://<your-hostname>/interactions`. Discord sends a signed PING to verify — the stack must be running first.
4. **Register slash commands** (once, and after every command change):

   ```sh
   docker compose run --rm mai npm run register
   ```

5. Start:

   ```sh
   docker compose up -d --build
   ```

## Adding features

- **New slash command**: add a file in `src/commands/` exporting `{ definition, execute }`, list it in `src/commands/index.js`, run `npm run register`.
- **New gateway event**: add a handler in `src/gateway/events/` and wire it in `src/gateway/client.js` (`client.on(Events.X, ...)`).
- **New reaction trigger**: add an entry to `TRIGGERS` in [src/gateway/events/reactions.js](src/gateway/events/reactions.js).
- **React to moderation verdicts**: `forwardMessageToN8n()` returns the workflow's response JSON — [src/gateway/events/message-create.js](src/gateway/events/message-create.js) is the place to act on it.

## Logging

Structured JSON via pino. `LOG_LEVEL=info` logs message metadata only (no user content); `LOG_LEVEL=debug` includes message content.
