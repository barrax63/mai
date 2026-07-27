# Mai (Discord app)

Discord app based on the structure of [discord-example-app](https://github.com/discord/discord-example-app), extended with a gateway client. The bot is **Mai**, the server's cat — she moderates, chats, reacts, and welcomes members in character. Moderation and chat run in this process: classification and replies come from the OpenAI API, state lives in a local SQLite database.

Two connections to Discord run side by side:

| Path | Transport | Purpose |
|------|-----------|---------|
| `POST /interactions` | HTTP (inbound via cloudflared) | Slash commands, signature-verified with the app public key |
| Gateway | WebSocket (outbound) | `messageCreate` / `messageUpdate` / `guildMemberAdd` events from every channel the bot can read |

The gateway connection is outbound, so message listening works even without the tunnel; cloudflared is only needed for the interactions endpoint.

The HTTP server ([src/http/server.js](src/http/server.js)) additionally serves `GET /healthz` (liveness probe used by the Docker healthcheck — it also reports database reachability and the age of the last moderation tick) and a static landing page at `GET /` (from [src/http/public/](src/http/public/)) for browsers hitting the public tunnel URL.

## Layout

```text
config/mai.yaml            persona, prompts, scold lines, welcome lines, reaction triggers, statuses
src/config.js              environment: secrets, models, feature flags, limits
src/content.js             loads + validates config/mai.yaml
src/ai/                    openai.js (HTTP client), moderation.js (classify), chat.js (prompt + normalize)
src/db/                    SQLite: index.js (open/migrate), queue.js, history.js, crypto.js, migrations/
src/moderation/            check.js (per message), enforcer.js (tick loop), warning.js (DM composer)
src/chat/                  reply.js (turn orchestration), limits.js (rate limit, concurrency, serialization)
src/gateway/               client + event handlers
src/http/                  interactions endpoint, healthz, landing page
src/commands/              slash commands (/ping, /mai)
```

## Moderation

Every non-bot guild message with text content is classified when it is posted **and again when it is edited** ([src/moderation/check.js](src/moderation/check.js)):

- **Guild allowlist** via `DISCORD_GUILD_IDS` (comma-separated IDs; empty = all guilds). This is the **whole-bot** gate, enforced once in `onMessageCreate` and in the interactions endpoint — in an un-listed guild Mai does nothing (no moderation, no chat, no reactions, no welcome, no slash-command response). Direct messages are never moderated (a bot cannot delete a DM) and are allowed only from users who share a listed guild with the bot (see Chat below).
- **Flagged** (`POST /moderations`, `OPENAI_MODERATION_MODEL`): Mai reacts with the warning emoji, replies with a random scold line, and stores metadata in the queue with `dueAt = now + MODERATION_GRACE_PERIOD_MINUTES`. Reaction and scold reply are best effort; the queue row is what counts.
- **Edits** ([src/gateway/events/message-update.js](src/gateway/events/message-update.js)) run through the same classifier via `recheckMessage`, because otherwise "post something harmless, then edit it" walks straight past the check. The verdict cuts both ways, since the message may already have a queue row:
  - clean before, a violation now → flagged like any new message, with a fresh grace period;
  - a violation before and still one → the categories are refreshed, the deadline is **not** — editing one slur into another must not buy more time — and the message is not scolded a second time;
  - a violation before, clean now → the flag is taken back off entirely: Mai's warning reaction is removed, the scold reply is deleted, the queue row is dropped, and the log channel gets a *Vom Autor korrigiert* entry so a `flagged` entry never just evaporates. The correction is recorded in the strike history as `edited` and, like a self-deletion during the grace period, deliberately **does not** count towards escalation;
  - classification unavailable → an unqueued message passes as usual, but a queued one **keeps its row**: no verdict is not the same as innocent.

  Discord also fires `messageUpdate` for link previews resolving, pins and flag changes; those are filtered out by `edited_timestamp` plus a content comparison, so they never cost a classification call. Edits are moderation-only — retrofitting a mention into a message does not make Mai answer it. No extra intent or Developer Portal toggle is needed.
- **Enforcement** ([src/moderation/enforcer.js](src/moderation/enforcer.js)) runs every `MODERATION_TICK_MS`: for each due row, the message is looked up. Gone (author deleted it) → the orphaned scold reply is removed, the row dropped, no DM. Still there → message and scold reply are deleted, the row dropped, and the author gets one DM per tick listing every removed message with category and timestamp. Any other lookup failure (missing permission, transient) keeps the row for the next tick.
- **Escalation** ([src/moderation/escalation.js](src/moderation/escalation.js)): each enforced deletion is recorded as a strike, and the strike count inside `MODERATION_STRIKE_WINDOW_DAYS` picks a Discord timeout from the ladder (`MODERATION_TIMEOUT_LADDER`, default `0,10,60,1440` — nothing, 10 min, 1 h, then 24 h repeating). Escalation runs **once per member per tick**: three messages removed in one sweep is one incident. A message the author deleted during the grace period is recorded but never escalates. The ceiling is a timeout by design — Mai never kicks or bans on her own, because an automated permanent action on a false positive is not recoverable. Needs the **Moderate Members** permission and Mai's role above the member's; a refused timeout is logged at `error` (so it alerts) and shown in the log channel rather than silently skipped.
- **Fails open**: if classification is unavailable (API down, key revoked), the message passes and Mai keeps chatting. `MODERATION_ENABLED=false` disables the pipeline entirely. Two paths deliberately fail **closed** instead, because there is no deletion to fall back on: an already-queued message being re-checked after an edit (see above), and a `/mai ask` question, which Mai would be republishing herself.
- **`/mai ask` screens the question** ([src/moderation/screen.js](src/moderation/screen.js)), before the completion runs, because the answer quotes it back into the channel — that command was otherwise a way to publish arbitrary text past moderation under Mai's name.
- **What Mai says herself is deliberately not classified.** Her tone escalates with a member's open violations, and the top rung tells her to insult them outright (`chat.flagged.tones`); a classifier reads that as harassment (0.89–0.98 measured), so an outbound filter would silence the angry cat precisely when she is supposed to be angry. The behaviour is the feature. What stops a prompt-injected model is the prompt — fenced quotes and a system-only instruction notice (see *Chat* below) — rather than a filter on her output.
- **Image attachments** are only checked when `MODERATION_CLASSIFY_IMAGES=true`. While it is off, a message carrying *only* an image is not classified at all — there is no text to look at — so posting an image is a way around moderation. With it on, image URLs are sent to the moderation endpoint alongside any text (Discord's signed CDN links are fetched by OpenAI; nothing is downloaded or stored by Mai).
- The queue holds **metadata only** — message text is never persisted. The content quoted in the warning DM is read from Discord at enforcement time.

## Mai persona features

- **Chat** ([src/gateway/events/mai-chat.js](src/gateway/events/mai-chat.js), [src/chat/reply.js](src/chat/reply.js)): mentioning the bot, replying to one of its messages, or sending it a direct message makes Mai answer in character (`OPENAI_CHAT_MODEL` via `POST /chat/completions`). A typing indicator runs while the model call is in flight, and all pings inside the reply are suppressed via `allowedMentions` plus `@everyone`/`@here` neutralization.
  - Guild messages addressed to Mai are moderated **first**: a flagged message gets no chat answer — the scold reply takes its place, and the message never reaches the chat pipeline or the history table.
  - **Direct messages** are always treated as addressed to Mai (no mention needed) and skip moderation, but only from an author who shares at least one `DISCORD_GUILD_IDS` guild with the bot (`isDmAuthorInAllowedGuild`, a per-guild `members.fetch`; empty allowlist = open). A DM has a `null` guild id; history is keyed per channel (a DM channel is stable per user). The check runs before any chat rate limit, so its answer is cached per user — 10 minutes for a yes, 30 for a no — with a small per-user limiter behind the cache; otherwise a stranger's DM spam is a free Discord round trip per guild per message.
  - **Memory**: the last `CHAT_HISTORY_TURNS` turns of the channel are sent as a real `messages[]` array — one entry per turn with its own role, user turns prefixed with the speaker's name because a channel has many. Turns are stored in SQLite with `content` and `username` encrypted (AES-256-GCM, `CHAT_HISTORY_KEY`) and pruned after `CHAT_HISTORY_MAX_AGE_HOURS`. This is the only place message content is stored.
  - **Context Discord hides**: what a message replies to (quoted, truncated) and the thread it sits in are resolved and put in front of the current turn. Without them a reply reads as a non-sequitur. Neither is persisted — only what the member wrote themselves.
  - **Prompt injection**: only the system message carries instructions, and it says so. Text the speaker merely *chose* to pull in — the quoted message, the thread title — is wrapped in `⟪…⟫`, with those characters stripped from the value first so it cannot close its own fence. Speaker labels have newlines and colons removed, so a username cannot forge a second `Name:` turn. The speaker's own message is deliberately not fenced: it is the thing being answered.
  - **Vision** (`CHAT_VISION_ENABLED`): image attachments on messages addressed to her are passed to the model as content parts, at most `CHAT_VISION_MAX_IMAGES` per message. Images are never stored; a picture-only message is remembered as a placeholder.
  - **Tools** (`CHAT_TOOLS_ENABLED`, [src/chat/tools.js](src/chat/tools.js)): `get_my_violations`, `get_server_info` and `get_current_time`. **No tool takes arguments from the model** — who is asking and where comes from the interaction context, so a model cannot read another member's record by naming them. At most two tool rounds, then the last call goes out without tools so she has to answer in words.
  - **Tone**: while the author has an open (un-enforced) violation in the queue — in *any* guild, DMs included — Mai turns aggressive, escalating with the number of open strikes. Enforcement (or `/mai forgive`) makes her friendly again.
  - **Limits**: `CHAT_RATE_LIMIT_MAX` replies per user per `CHAT_RATE_LIMIT_WINDOW_MS`, `CHAT_MAX_CONCURRENT` model calls in flight. Over either limit she reacts with the busy emoji instead of answering. Turns in one channel are serialized so parallel conversations cannot interleave history reads and writes.
  - `CHAT_ENABLED=false` disables chat.
- **Reactions** ([src/gateway/events/reactions.js](src/gateway/events/reactions.js)): keyword triggers (fish, cat words, meowing, "gute Katze") get an emoji reaction, some only with a random chance. At most one reaction per message. Triggers live in `config/mai.yaml`.
- **Welcome messages** ([src/gateway/events/guild-member-add.js](src/gateway/events/guild-member-add.js)): new members are greeted in the guild's system channel. Requires `DISCORD_WELCOME_ENABLED=true` **and** the privileged "Server Members Intent" (Developer Portal → Bot) — the flag gates the `GuildMembers` intent, because logging in with a privileged intent that is not enabled in the portal fails.
- **Presence** ([src/gateway/presence.js](src/gateway/presence.js)): custom status ("😺 schnurrt irgendwo in der Nähe", …) picked at random on gateway ready and rotated every `PRESENCE_ROTATE_HOURS` hours (default 3; 0 = no rotation).

## Slash commands

| Command | Who | Effect |
|---------|-----|--------|
| `/ping` | everyone | Liveness check (ephemeral) |
| `/mai ask <frage>` | everyone | A public question to Mai, answered in character. Stateless: no channel history in the prompt, nothing written to her memory. Subject to the same rate limit as chat, and the question is classified before it is quoted back into the channel |
| `/mai forget` | everyone | Wipes what Mai remembers about you, behind a confirmation button. Removes your own turns everywhere plus the full history of your DM channel with her |
| `/mod status` | Manage Messages | Open violations and chat-memory size **for this server**, plus last moderation tick, configured models and uptime (ephemeral) |
| `/mod forgive <user> [strikes]` | Manage Messages | Drops that member's open violations **in this server** and cleans up the scold replies; `strikes:true` also wipes their strike record, resetting the ladder |
| `/mod config view` | Manage Messages | The settings in effect here, marking which ones are inherited defaults |
| `/mod config set [log-channel] [welcome-channel] [grace]` | Manage Messages | Sets any subset for this server |
| `/mod history <user>` | Manage Messages | That member's strike record here, and what their next enforced deletion would cost |
| `/mod spend` | Manage Messages | OpenAI calls and tokens today and this month **for this server**, per purpose and model. The budget's figures are process-wide, so staff only learn whether it is exhausted |
| `/mod config reset [setting]` | Manage Messages | Back to the default; omit the setting to reset all |
| `Nachricht melden` (right-click a message → Apps) | everyone | Reports the message to staff; see below |
| `/mod off` / `/mod on` | Manage Messages | Kill switch: switches Mai off in this server completely, and back on |

## Reports and appeals

Both need a configured `log-channel` — without one there is nowhere for either
to land, and Mai says so instead of swallowing them.

**Reporting** ([src/commands/report.js](src/commands/report.js)): right-click a
message → *Apps* → *Nachricht melden* opens a modal asking why (optional). The
report appears in the log channel with **Löschen** / **Verwerfen** buttons; both
are Manage Messages-only and checked server-side, not just hidden. Approving
deletes the reported message immediately — a human already judged it, so there is
no grace period; a message that is already gone is recorded as such rather than
failing the click. Dismissing keeps it. Rate limit: 5 reports per member per 10
minutes.

The decision is written back into the log entry itself, so **every** moderator
sees it: the title and colour change, the buttons disappear so nobody
re-decides, and a field names who decided what. A second click replaces that
field instead of stacking another one. The approve path is deferred before the
delete, so a slow Discord round trip cannot make the click fail and leave stale
buttons behind — but only for staff, since a deferred response can no longer be
ephemeral and a stranger's refusal must not overwrite the entry.

**Appealing** ([src/moderation/appeal.js](src/moderation/appeal.js)): the warning
DM carries an *Einspruch einlegen* button. It opens a modal, and the member's
statement is posted into that guild's log channel. Rate limit: 3 per member per
hour.

Reports and appeals are the only paths where member-written text reaches the log
channel, and only because that member typed it and pressed submit. The reported
message itself is still just linked, never copied.

## Per-guild settings

One process serves several servers, and they disagree about where Mai should log
and how long the grace period is. `guild_settings` holds only what a server
actually changed; a NULL column inherits the process default from `.env`.
[src/db/settings.js](src/db/settings.js) is the single authority —
`effectiveSettings(guildId)` returns the merged view plus which keys are
inherited.

| Setting | Default | Effect |
|---|---|---|
| `log-channel` | none | Target channel for the moderation log. Unset = no log for this guild |
| `welcome-channel` | the guild's system channel | Where new members are greeted |
| `grace` | `MODERATION_GRACE_PERIOD_MINUTES` | Minutes an author has to delete a flagged message (1–1440) |
| `timeout-ladder` | `MODERATION_TIMEOUT_LADDER` | Timeout minutes per strike, e.g. `0,10,60,1440`; the last step repeats |
| `strike-window` | `MODERATION_STRIKE_WINDOW_DAYS` | Days an enforced deletion counts towards escalation (1–365) |
| `escalation` | `MODERATION_ESCALATION_ENABLED` | Hand out timeouts at all; off still records strikes |
| `enabled` | on | The kill switch — same flag as `/mod off` / `/mod on` |

### Kill switch

`/mod off` stops Mai in that server completely: no moderation, no chat, no
reactions, no welcome, and queued rows are not enforced. It is a pause, not an
amnesty — the rows are kept and resume when `/mod on` is used, rather than
quietly forgiving everything. `/mod` itself keeps answering while she is off,
otherwise the only way back would be editing the database. Everything else
replies with the paused message. Direct messages are unaffected: a DM has no
guild to pause.

Adding a setting means: a column in a new migration, an entry in the `SETTINGS`
map (with its parse/validate rule), and an option on `/mod config set`.

## Moderation log

With `log-channel` set, every moderation action is posted as an embed
([src/moderation/log.js](src/moderation/log.js)): flagged (amber, with a jump
link and the deletion deadline), deleted (red), deleted by the author during the
grace period (green), and forgiven (blue, naming the staff member who did it).

**Metadata only.** No message content goes into the channel — a Discord channel
is permanent storage readable by everyone with access, which would undo the
no-content rule. Entries carry ids, category slugs, timestamps and a jump link
while the message still exists; the offender's own warning DM stays the only
place their text is quoted back. The embed footer says so, in the channel.

Posting is best effort: a missing channel, a wrong channel type or a missing
permission is logged locally and never breaks the moderation pipeline.

### Two authority tiers

Manage Messages makes someone staff **in their own server**. `OPERATOR_USER_IDS`
is whoever runs the bot. Mai serves several servers out of one database, so
every counter a command prints is filtered to the calling guild unless the
caller is an operator — a guild's moderators are not auditors of the other
servers Mai happens to run in. The same border applies to acting: `/mod forgive`
only pardons in the server it was run in. The one deliberate exception is Mai's
*chat* memory of a member's open violations, which stays cross-guild: her having
one memory of someone is not the same as one server's staff reaching into
another. Empty `OPERATOR_USER_IDS` means the cross-guild view is off entirely.

## Interaction handling

Dispatch for everything arriving at `POST /interactions` lives in
[src/interactions/router.js](src/interactions/router.js): pings, commands,
autocomplete, component clicks (buttons, select menus) and modal submits. The
guild allowlist is enforced there, once, for every kind.

The endpoint is reachable from the public internet through the tunnel, and
verifying an Ed25519 signature is the expensive part of handling a request — so
two cheap caps run *before* it: a per-client rate limit
(`INTERACTIONS_RATE_LIMIT_MAX` per window, keyed on `CF-Connecting-IP` since
every request otherwise carries the cloudflared container's address) and a body
size cap (`INTERACTIONS_MAX_BODY_BYTES`; a request without a `Content-Length` is
refused rather than streamed). Refusals are logged at `debug`: at HTTP volume an
`info` line per refusal would turn a flood into a second flood in the log.

Component `custom_id`s carry state, but an id from the client only ever *names* a
target — it never authorizes one. A handler acting for a user checks the id
against the clicker (`/mai forget`), and one acting on a channel checks that the
channel is in the clicker's guild (`report-approve`, since the bot's client can
reach every server Mai is in).

Discord expects the HTTP response within ~3 s. A handler that needs longer sets
`deferred` and the router answers with a placeholder ("Mai is thinking…"), then
edits it through the interaction webhook when the handler resolves — so handlers
never deal with the deadline themselves:

```js
export const example = {
  definition: { name: 'example', description: '…', type: 1 },
  deferred: true,          // or (interaction) => boolean, e.g. per subcommand
  ephemeral: false,        // fixes placeholder visibility; the edit cannot change it
  execute(interaction) { return messageResponse('…'); },
};
```

Response builders (`messageResponse`, `ephemeralResponse`, `updateResponse`,
`modalResponse`, `autocompleteResponse`, plus `editOriginalResponse` /
`followUpResponse`) are in
[src/interactions/respond.js](src/interactions/respond.js). All of them default to
`allowed_mentions: { parse: [] }`.

Buttons carry their state in the `custom_id` (`name:arg:arg`); the part before the
first colon selects the handler from
[src/interactions/registry.js](src/interactions/registry.js). A click by someone
other than the id's owner is refused — never trust a client-supplied id. Modal
routing exists but no modal ships yet.

## Tests

```sh
npm test        # node:test, no dependencies, no network
```

`test/setup.js` fills the environment before `config.js` is imported and points
the database at a throwaway file; `test/setup-chat.js`, `test/setup-moderation.js`
and `test/setup-security.js` turn the relevant features on for the files that
need them, and must be imported *before* `setup.js`. OpenAI and Discord are
reached through a stubbed global `fetch`. Tests are not copied into the image —
run them on the host.

## Configuration

Two surfaces, both read once at startup:

- **`.env`** — secrets, models, feature flags, timings, limits. See [../.env.example](../.env.example). Changing it requires a container **recreate** (`docker compose up -d mai`), not just a restart.
- **`config/mai.yaml`** — everything Mai says: persona, moderation tone directives, scold lines, warning-DM template, `/mai` replies, welcome lines, reaction triggers, presence statuses. Point `MAI_CONFIG_PATH` at a read-only bind mount to edit it without rebuilding the image; a restart applies it.

## Storage

SQLite via the builtin `node:sqlite` module (no native dependency), at `DATABASE_PATH` (default `/data/mai.sqlite`, on the `mai-data` volume — the container rootfs is read-only). Schema changes are new numbered files in [src/db/migrations/](src/db/migrations/), applied automatically at startup and recorded in `schema_migrations`.

Two tables:

| Table | Contents | Retention |
|-------|----------|-----------|
| `moderation_queue` | IDs, category slugs, timestamps of flagged messages — no content | until enforced (grace period) |
| `chat_history` | Mai's short-term memory; `content`/`username` encrypted | `CHAT_HISTORY_MAX_AGE_HOURS` |
| `guild_settings` | Per-guild overrides of the process defaults | until changed |
| `usage_daily` | Call and token counters per day, guild, model and purpose | kept |
| `violations` | Strike record: ids, category slugs, action, timestamp — no content | `VIOLATION_RETENTION_DAYS` |

## Operations

**Token accounting** ([src/db/usage.js](src/db/usage.js)): every API call is
counted where the response reports it, so `/mod spend` can answer "how much?"
without guessing. Counters only — no prompts, no replies, nothing identifying a
member. `OPENAI_MONTHLY_TOKEN_BUDGET` (UTC calendar month, 0 = no limit) is the
safety net: once the month's tokens are used up, chat degrades to reactions —
Mai answers a mention with the busy emoji instead of a reply. **Moderation is
never gated by the budget**; safety is not a budget item, and the moderation
endpoint reports no tokens anyway.

**Error alerts**: with `ALERT_CHANNEL_ID` set, every `error` and `fatal` log line
is mirrored into that channel. It is wired into pino as a hook
([src/alerts.js](src/alerts.js)), so no call site can forget to raise one, and
only whitelisted keys (ids, command names, status codes, the error type and
message) are forwarded — a log record may carry content, an alert must not.
Throttled to 5 per 5 minutes, with the dropped ones counted and reported by the
first alert of the next window. Two consequences worth knowing: alerts are
process-wide, not per guild, and a `LOG_LEVEL` above `error` silences them too,
because pino replaces a disabled level's method — hook included — with a no-op.

**Stuck enforcement**: a queue row that cannot be enforced (missing permission,
transient API failure) counts its attempts. After 5 it reports itself once in the
moderation log *and* at `error` level; after 60 Mai gives up, logs it and drops
the row. Before this, such a row failed silently every minute forever.

Backup = the volume:

```sh
docker run --rm -v mai_mai-data:/data -v "$PWD:/backup" alpine tar czf /backup/mai-data.tgz -C /data .
```

## Setup

1. **Discord Developer Portal** (<https://discord.com/developers/applications>):
   - *Bot* → enable **Message Content Intent** (privileged; required for reading message content).
   - *Bot* → enable **Server Members Intent** (privileged) **only if** you set `DISCORD_WELCOME_ENABLED=true` — the flag makes the bot request the `GuildMembers` intent, and login fails when the portal toggle is off.
   - Direct-message replies need **no** portal toggle: the non-privileged `DirectMessages` intent is requested in code. Users can DM Mai once they share a server with her (subject to their Discord privacy settings).
   - Copy *Application ID*, *Public Key* (General Information) and *Bot Token* (Bot) into `.env`.
   - Invite the bot with the `bot` + `applications.commands` scopes. Permissions needed: Read Messages, Send Messages, Embed Links (moderation log), Add Reactions, Manage Messages (deleting flagged messages), and **Moderate Members** for the escalation timeouts. Mai's role must sit above the members she is expected to time out — Discord refuses otherwise, and admins and the owner can never be timed out.
2. **Secrets**: `OPENAI_API_KEY`, and `CHAT_HISTORY_KEY` from `openssl rand -base64 32`.
3. **Cloudflare tunnel**: route your public hostname to `http://mai:3000`.
4. **Interactions Endpoint URL** (General Information): set to `https://<your-hostname>/interactions`. Discord sends a signed PING to verify — the stack must be running first.
5. **Register slash commands** (once, and after every command change):

   ```sh
   docker compose run --rm mai npm run register
   ```

6. Start:

   ```sh
   docker compose up -d --build
   ```

## Adding features

- **New slash command**: add a file in `src/commands/` exporting `{ definition, execute }` (sync or async), list it in `src/commands/index.js`, run `npm run register`.
- **New gateway event**: add a handler in `src/gateway/events/` and wire it in `src/gateway/client.js` (`client.on(Events.X, ...)`).
- **New reaction trigger / new wording**: edit `config/mai.yaml`. No code change, no rebuild if the file is bind-mounted.
- **New table or column**: add `src/db/migrations/00N_*.sql` and a repository function next to `queue.js` / `history.js`. Nothing outside `src/db/` may contain SQL.
- **Different model provider**: `OPENAI_BASE_URL` — only `/chat/completions` and `/moderations` are used.

## Logging

Structured JSON via pino. `LOG_LEVEL=info` logs metadata only (IDs, category slugs, model names, timings); `LOG_LEVEL=debug` adds message content, prompts, replies and warning-DM bodies. Usernames count as content.
