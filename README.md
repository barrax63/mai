# Mai

<p align="center">
  <img src="docs/mai.png" alt="Mai, die Katze" width="380">
</p>

Docker Compose stack running **Mai**, a Discord bot with a cat persona, behind a Cloudflare tunnel. New messages are forwarded to n8n workflows via public webhook URLs: moderation for every message, plus Mai's chat, reactions, and welcome messages.

## Architecture

```text
Discord ──HTTPS──▶ Cloudflare Tunnel ──▶ cloudflared ──edge──▶ mai (:3000 /interactions)
Discord ◀─────────WebSocket (gateway, outbound)──────────────  mai
n8n     ◀─────────HTTPS webhook (outbound)───────────────────  mai
```

- **`mai`** — Node.js Discord app: HTTP interactions endpoint (slash commands) + gateway listener for new messages. See [mai/README.md](mai/README.md).
- **`cloudflared`** — Cloudflare tunnel exposing the interactions endpoint to Discord without open ports. Browsers hitting the tunnel URL get a static landing page instead of an error.

## Moderation workflows

The bot forwards every new message (from allowlisted guilds, `DISCORD_GUILD_IDS`) to an n8n webhook. Two workflows handle moderation, connected through a shared metadata queue — message content is never persisted:

- **Check Messages** (webhook) — classifies the message via OpenAI; violations get a warning reaction and are queued with a grace period.
- **Delete Messages** (scheduler) — after the grace period, deletes messages the author did not remove themselves and DMs them a warning.

## Mai — the bot persona

The bot is **Mai**, the server's cat-moderator. Mentioning her or replying to her messages triggers the **Mai Chat** n8n workflow (OpenAI, cat persona, short per-channel memory) and she answers in character. She also reacts to trigger words (🐟, 😺) and can welcome new members ([mai/README.md](mai/README.md)).

Workflow JSON files and full documentation: [n8n/README.md](n8n/README.md).

## Quick start

```sh
# 1. Configure secrets
cp .env.example .env   # then fill in the values

# 2. Build and start
docker compose up -d --build

# 3. Register slash commands (once, and after command changes)
docker compose run --rm mai npm run register
```

Discord-side setup (intents, tunnel hostname, interactions endpoint URL) is documented in [mai/README.md](mai/README.md).

## Security baseline

All services run with `no-new-privileges`, `cap_drop: ALL`, read-only root filesystem, tmpfs-only writes, resource limits, and log rotation. Secrets live only in `.env` (gitignored).
