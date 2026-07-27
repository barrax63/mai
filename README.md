# Mai

<p align="center">
  <img src="docs/mai.png" alt="Mai, die Katze" width="380">
</p>

Docker Compose stack running **Mai**, a Discord bot with a cat persona, behind a Cloudflare tunnel. Moderation and chat run inside the bot: it classifies messages and generates replies through the OpenAI API and keeps its state in a local SQLite database.

## Architecture

```text
Discord ──HTTPS──▶ Cloudflare Tunnel ──▶ cloudflared ──edge──▶ mai (:3000 /interactions)
Discord ◀─────────WebSocket (gateway, outbound)──────────────  mai
OpenAI  ◀─────────HTTPS (outbound: /moderations, /chat/completions)  mai
                                                                    mai ──▶ SQLite (mai-data volume)
```

- **`mai`** — Node.js 24 Discord app: HTTP interactions endpoint (slash commands), gateway listener for messages, moderation pipeline, chat, and an in-process scheduler. See [mai/README.md](mai/README.md).
- **`cloudflared`** — Cloudflare tunnel exposing the interactions endpoint to Discord without open ports. Browsers hitting the tunnel URL get a static landing page instead of an error.

## Moderation

Every new **and edited** message in an allowlisted guild (`DISCORD_GUILD_IDS`) is classified. Message content is never persisted — only IDs, category labels and timestamps:

- **Flagged** → warning reaction, a scold reply, and a queue row with a grace period.
- **After the grace period** → messages the author did not delete themselves are removed and the author gets a warning DM. The scold reply is cleaned up either way.
- **Edited** → re-classified, so the edit button is not a way past the check. The verdict cuts both ways: an edit that fixes a flagged message takes the warning reaction, the scold reply and the queue row back off it. Editing one violation into another refreshes the categories but keeps the original deadline.
- **`/mai ask`** → the question is classified before Mai quotes it back into the channel. Her own replies are deliberately *not* classified: she is written to get ruder the more open violations someone has, and a filter would cut exactly that.

Every action can also be mirrored into a staff channel as an embed — metadata only, never message content ([mai/README.md](mai/README.md#moderation-log)).

How hard Mai judges is per server too: `/mod config set threshold` decides violations on the classifier's own scores instead of its English-tuned default, and `/mod exempt add` leaves a channel alone entirely (chat and reactions keep working there).

Staff inspect and override with `/mod status`, `/mod forgive <user>` and `/mod config` (log channel, welcome channel, grace period, threshold, categories — per server); everything they see and do is scoped to their own server, and every change is announced in the server's own log channel. Whoever runs the bot (`OPERATOR_USER_IDS`) additionally sees the process-wide figures. Members talk to her with `/mai ask` and clear her memory of them with `/mai forget`.

## Mai — the bot persona

The bot is **Mai**, the server's cat-moderator. Mentioning her, replying to her messages, or sending her a direct message gets an in-character reply (OpenAI, cat persona, short per-channel memory). Direct messages skip moderation (a bot cannot delete a DM) and are only accepted from users who share an allowlisted server with her. Her conversation memory is kept a few hours to give her context, then deleted; it is encrypted at rest (AES-256-GCM). While a member has an un-enforced violation, Mai turns aggressive toward them wherever they talk to her. She also reacts to trigger words (🐟, 😺) and can welcome new members ([mai/README.md](mai/README.md)).

Everything she says — persona, prompts, scold lines, welcome messages, reaction triggers — lives in [mai/config/mai.yaml](mai/config/mai.yaml). Secrets, models and limits live in `.env`.

## Quick start

```sh
# 1. Configure secrets
cp .env.example .env   # then fill in the values:
                       #   DISCORD_BOT_TOKEN / DISCORD_PUBLIC_KEY / DISCORD_APP_ID
                       #   OPENAI_API_KEY
                       #   CHAT_HISTORY_KEY=$(openssl rand -base64 32)
                       #   CLOUDFLARED_TUNNEL_TOKEN

# 2. Build and start
docker compose up -d --build

# 3. Register slash commands (once, and after command changes)
docker compose run --rm mai npm run register
```

Discord-side setup (intents, tunnel hostname, interactions endpoint URL) is documented in [mai/README.md](mai/README.md).

## Security baseline

All services run with `no-new-privileges`, `cap_drop: ALL`, read-only root filesystem, tmpfs-only writes, resource limits, and log rotation. The bot's only writable location is the `mai-data` volume holding the SQLite database. Secrets live only in `.env` (gitignored).
