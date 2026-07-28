# Mai (Discord app)

Discord app based on the structure of [discord-example-app](https://github.com/discord/discord-example-app), extended with a gateway client. The bot is **Mai**, the server's cat: she moderates, chats, reacts, and welcomes members in character. Moderation and chat run in this process: classification and replies come from the OpenAI API, state lives in a local SQLite database.

Two connections to Discord run side by side:

| Path | Transport | Purpose |
|------|-----------|---------|
| `POST /interactions` | HTTP (inbound via cloudflared) | Slash commands, autocomplete, buttons and modal submits, signature-verified with the app public key |
| Gateway | WebSocket (outbound) | `messageCreate` / `messageUpdate` / `messageDelete` / `guildMemberAdd` events from every channel the bot can read |

The gateway connection is outbound, so message listening works even without the tunnel; cloudflared is only needed for the interactions endpoint.

The HTTP server ([src/http/server.js](src/http/server.js)) additionally serves `GET /healthz` (liveness probe used by the Docker healthcheck, it also reports database reachability and the age of the last moderation tick: three missed ticks answer 503, with a startup grace period before the first one), `GET /metrics` (operator-only, off by default: see *Operations*) and a static landing page at `GET /` (from [src/http/public/](src/http/public/)) for browsers hitting the public tunnel URL.

## Layout

```text
config/mai.yaml            persona, prompts, scold lines, welcome lines, reaction triggers, statuses
src/config.js              environment: secrets, models, feature flags, limits, isGuildAllowed/isOperator
src/content.js             loads + validates config/mai.yaml
src/errors.js              describeError (operator) / explainError (guild staff): never err.message
src/alerts.js              error+fatal log lines into ALERT_CHANNEL_ID, wired in as a pino hook
src/logger.js              pino, plus the hook that raises those alerts
src/rate-limit.js          the shared token bucket (interactions, chat, reports, appeals, DM checks)
src/ai/                    openai.js (HTTP client + retries + token accounting), moderation.js
                           (classify + applyPolicy), chat.js (prompt build, tool loop, normalize)
src/db/                    the only SQL: index.js (open/migrate), queue.js, history.js, settings.js,
                           violations.js, usage.js, crypto.js, migrations/
src/moderation/            check.js (per message, incl. recheck + exemptions), enforcer.js (tick loop),
                           cleanup.js (undoing Mai's marks), escalation.js (strike ladder + timeouts),
                           warning.js (DM composer + grouping), log.js (staff-channel embeds),
                           appeal.js (button, modal, decisions), screen.js (/mai ask input guard)
src/chat/                  reply.js (turn orchestration), limits.js (rate limit, concurrency,
                           serialization), tools.js (argument-free function calling)
src/gateway/               client.js (intents + wiring), presence.js, events/
src/http/                  server.js (interactions, healthz, landing page), metrics.js, public/
src/interactions/          router.js (dispatch, allowlist, kill switch), registry.js (components +
                           modals), options.js (subcommand/option reading), respond.js (builders)
src/commands/              slash commands: /ping, /mai, /mod, and the "Nachricht melden" message
                           command (report.js)
```

## Moderation

Every non-bot guild message with text content is classified when it is posted **and again when it is edited** ([src/moderation/check.js](src/moderation/check.js)):

- **Guild allowlist** via `DISCORD_GUILD_IDS` (comma-separated IDs; empty = all guilds). This is the **whole-bot** gate, enforced once in `onMessageCreate` and in the interactions endpoint: in an un-listed guild Mai does nothing (no moderation, no chat, no reactions, no welcome, no slash-command response). Direct messages are never moderated (a bot cannot delete a DM) and are allowed only from users who share a listed guild with the bot (see Chat below).
- **Local rules first** ([src/moderation/heuristics.js](src/moderation/heuristics.js)): before anything is sent to the provider, the guild's own rules judge the message. A classifier scores what a message *means*, and none of these are about meaning: an advertisement is a perfectly polite invite link, a raid is twenty harmless lines in five seconds, a mass ping is one word plus fifty mentions. They are free (no API call, no tokens), they keep working while the provider is down, which is exactly when a raid is cheapest to run, and a message they trip on is never classified at all. All four are house rules rather than a safety floor, so each is **off** until a server turns it on:
  - `invite-filter`: Discord invite links, with or without a scheme (category `invite`);
  - `link-policy: allowlist` plus `link-domains`: every link outside the list counts, subdomains of a listed host included (category `link`);
  - `mention-cap`: users, roles, `@everyone` and `@here` in one message, channel links excluded because they ping nobody (category `mentions`);
  - `flood` as `count/seconds`: more than `count` messages from one member in that window (category `flood`). One violation **per burst**, not per message: a strike and a scold reply per message would have Mai out-spamming the spammer, and one burst is one incident.

  What they produce is an ordinary list of category slugs, so a trip goes through the same path as a classified violation: warning reaction, scold reply, grace period, queue row, log entry, strike. There is deliberately no separate "delete it instantly" route. Content rules also run on **edits** (posting clean and editing an invite in afterwards would otherwise walk past all of them); the flood rule does not, because editing a message is not sending one.
- **Flagged** (`POST /moderations`, `OPENAI_MODERATION_MODEL`): Mai reacts with the warning emoji, replies with a random scold line, and stores metadata in the queue with `dueAt = now + MODERATION_GRACE_PERIOD_MINUTES`. Reaction and scold reply are best effort; the queue row is what counts.
- **Shadow mode** runs both layers and acts on neither: no warning reaction, no scold reply, no queue row, no strike, no timeout. Every verdict goes to the log channel as a *Nur beobachtet* entry carrying the categories, the **top score** and a working jump link, so a server picks its threshold by reading its own traffic instead of by deleting the wrong messages and apologising. It is not a pause: rows queued before it was switched on are still enforced (`/mod off` is the pause).

  It comes in two shapes, and the difference matters. `/mod setup observe` starts an **observation period**: `shadow_until` is set `MODERATION_SHADOW_DAYS` out, the enforcer tick switches the guild back to enforcing when it passes, and the log channel gets a *Beobachtungszeit vorbei* entry with the count of what she would have acted on. That is the promise her introduction makes, and it is kept without anybody remembering to collect on it. `/mod config set shadow:true` is the other shape: open-ended, because somebody decided it deliberately and will decide when it ends. Any statement about shadow mode (another preset, a manual `shadow:…`) cancels a running period, so a leftover end date cannot fire days later and announce the end of an observation nobody was running. There is deliberately **no process-wide shadow switch**: it is a server's decision about its own moderation, and an environment flag could only produce the shapeless version, on everywhere and forever. `/mod simulate <text>` answers the same question for one string on demand, including which local rule would have caught it, and is the only place a full score vector is shown: the text is the moderator's own, the answer is ephemeral to them, and nothing is stored or logged.
- **Where the line sits is per server.** The endpoint answers twice (a `flagged` boolean and a `category_scores` map), and `MODERATION_THRESHOLD` (`/mod config set threshold`) decides which one counts. At `0` the provider decides, as before. Above `0`, a category counts when it scores at least that much and the provider's own boolean is ignored entirely (otherwise raising the threshold could never make anything pass). This exists for a measured reason: omni-moderation scores the same insult **0.88 in English and 0.20 in German**, so on a German-speaking server its default line lets most abuse through. `MODERATION_CATEGORIES` (`/mod config set categories`) narrows things the other way: only the listed categories count at all.
- **Exempt channels** (`/mod exempt add|remove|list`): a vent channel, an NSFW channel, a staff channel. Moderation only: chat and reactions keep working there, which is usually the point. Exempting a channel covers its threads, and any pending queue rows in it are dropped on the next tick rather than enforced later: "Mai does not moderate here" should not be followed by her deleting something there ten minutes on.
- **Edits** ([src/gateway/events/message-update.js](src/gateway/events/message-update.js)) run through the same classifier via `recheckMessage`, because otherwise "post something harmless, then edit it" walks straight past the check. The verdict cuts both ways, since the message may already have a queue row:
  - clean before, a violation now → flagged like any new message, with a fresh grace period;
  - a violation before and still one → the categories are refreshed, the deadline is **not** (editing one slur into another must not buy more time) and the message is not scolded a second time;
  - a violation before, clean now → the flag is taken back off entirely: Mai's warning reaction is removed, the scold reply is deleted, the queue row is dropped, and the log channel gets a *Vom Autor korrigiert* entry so a `flagged` entry never just evaporates. The correction is recorded in the strike history as `edited` and, like a self-deletion during the grace period, deliberately **does not** count towards escalation;
  - classification unavailable → an unqueued message passes as usual, but a queued one **keeps its row**: no verdict is not the same as innocent.

  Discord also fires `messageUpdate` for link previews resolving, pins and flag changes; those are filtered out by `edited_timestamp` plus a content comparison, so they never cost a classification call. Edits are moderation-only: retrofitting a mention into a message does not make Mai answer it. No extra intent or Developer Portal toggle is needed.
- **Display names are screened separately** ([src/moderation/names.js](src/moderation/names.js)), because a nickname is on every message its owner sends and no message rule can ever see it: Mai was deleting a word out of a member's sentences while it sat in their name untouched. `name-check` is `off`, `log` (an entry in the moderation log) or `reset` (the same entry, plus the *server* nickname is removed). A global username is not Mai's to change and she never kicks or bans over a name, so `reset` falling back to a flagged global name ends in an entry and a human decision. The entry carries **no copy of the name**: `<@id>` renders as that member's current display name for whoever reads it, which is both the evidence and always up to date. Screened on join (a flagged name is not welcomed, since a welcome would put it in front of the whole server in Mai's own words) and on rename, filtered to actual name changes because MEMBER_UPDATE also fires for roles, avatars and every timeout Mai hands out. Bounded at 3 checks per member per 10 minutes: renaming is free and instant. Fails open like the rest of the pipeline, which here means an API timeout can never strip somebody's nickname. Needs `MODERATION_NAME_CHECK` (the process-wide switch that requests the privileged **Server Members Intent**) plus the per-guild setting.
- **Self-deletion resolves immediately** ([src/gateway/events/message-delete.js](src/gateway/events/message-delete.js)): the moment the author removes a flagged message, the scold reply goes with it, the queue row is dropped and the log gets its entry: no waiting out a grace period that has nothing left to enforce. Deletions Mai performs herself (enforcement, an approved report) are registered beforehand and skipped, or her own work would be recorded as the author having fixed it. The enforcer keeps the same handling as a fallback for a deletion that happened while the gateway was down.
- **Enforcement** ([src/moderation/enforcer.js](src/moderation/enforcer.js)) runs every `MODERATION_TICK_MS`: for each due row, the channel and then the message are looked up. Gone (author deleted it, or the channel is) → the orphaned scold reply is removed, the row dropped, no DM. Still there → message and scold reply are deleted, a strike is recorded, the row dropped, and the author gets one DM per tick and guild listing every removed message with category and timestamp. Any other lookup failure (missing permission, transient, a channel that holds no messages) keeps the row for the next tick and counts an attempt.

  A warning DM that **bounces** (the member has DMs from server members off, or blocked Mai) is a normal outcome for the process and a bad one for the member: their messages are gone, they may be timed out, and the one message explaining why, carrying the appeal button, never arrived. So the guild's log gets a *Verwarnung nicht zugestellt* entry naming the member, how many messages were removed and the reason in words, because otherwise the log shows a clean `deleted` entry and nothing suggests anyone needs to do anything. `/mai appeal` is the member's own way back in (see *Reports and appeals*).

  Rows are processed **serially** (each one is several Discord calls, so parallelism only trades a shorter tick for a harder rate limit) and capped at `MODERATION_MAX_ROWS_PER_TICK`, oldest first, so a backlog after an outage drains in order instead of outlasting the interval and being skipped by the overlap guard forever. Two categories of row are therefore kept out of the due query itself rather than skipped inside the loop, because a row that is kept but can never resolve would otherwise stay the oldest and occupy the cap on every tick: guilds paused with `/mod off`, and only those still on the allowlist (a guild that is *both* paused and un-listed stays in the query, because dropping its rows is the allowlist check's job). A channel that became exempt after the flag drops its rows, checked *after* the channel lookup because an exemption covers the threads inside the exempted channel and the parent id is only knowable from the channel object. The same tick prunes chat history and the strike record, so retention does not depend on anyone talking to Mai.
- **Escalation** ([src/moderation/escalation.js](src/moderation/escalation.js)): each enforced deletion is recorded as a strike, and the strike count inside `MODERATION_STRIKE_WINDOW_DAYS` picks a Discord timeout from the ladder (`MODERATION_TIMEOUT_LADDER`, default `0,10,60,1440`: nothing, 10 min, 1 h, then 24 h repeating). Escalation runs **once per member and guild per tick**: three messages removed in one sweep is one incident, and one grouping pass feeds both the timeout and the warning DM so the two cannot drift. Never on the user id alone: one process serves several servers, so the same person can be enforced in two of them in the same tick, and merging those produced a DM quoting one guild's deleted messages next to another's, with an appeal button scoped to whichever guild sorted first. A message the author deleted during the grace period is recorded but never escalates. The ceiling is a timeout by design: Mai never kicks or bans on her own, because an automated permanent action on a false positive is not recoverable. Needs the **Moderate Members** permission and Mai's role above the member's; a refused timeout is logged at `error` (so it alerts) and shown in the log channel rather than silently skipped. The one exception is a target Discord can *never* time out (an administrator or the guild owner): that is checked before trying and refused at `info`, because a permanent property of the target is not an incident and would otherwise page the operator every single time such a member trips the ladder. The log-channel entry still goes out: staff should know the ladder had no effect.
- **Fails open**: if classification is unavailable (API down, key revoked), the message passes and Mai keeps chatting. `MODERATION_ENABLED=false` disables the pipeline entirely. Two paths deliberately fail **closed** instead, because there is no deletion to fall back on: an already-queued message being re-checked after an edit (see above), and a `/mai ask` question, which Mai would be republishing herself.
- **…but not silently.** Failing open is invisible from inside Discord: an outage looks exactly like a quiet afternoon, and until it was reported only the operator (container log, alert channel) ever found out. After `MODERATION_DEGRADED_AFTER` consecutive failures in a server, its log channel gets a *Moderation fällt aus* entry, and a *Moderation läuft wieder* one when the next classification succeeds ([src/moderation/health.js](src/moderation/health.js)). Exactly one of each per outage: an entry per failed message would be a second flood on top of the first. `/mod status` answers the same question on demand, which is the only route for a server with no log channel. The local rules above keep working throughout, which is half of why they are worth having.
- **`/mai ask` screens the question** ([src/moderation/screen.js](src/moderation/screen.js)), before the completion runs, because the answer quotes it back into the channel, that command was otherwise a way to publish arbitrary text past moderation under Mai's name.
- **What Mai says herself is deliberately not classified.** Her tone escalates with a member's open violations, and the top rung tells her to insult them outright (`chat.flagged.tones`); a classifier reads that as harassment (0.89–0.98 measured), so an outbound filter would silence the angry cat precisely when she is supposed to be angry. The behaviour is the feature. What stops a prompt-injected model is the prompt (fenced quotes and a system-only instruction notice (see *Chat* below)) rather than a filter on her output.
- **Image attachments** are only checked when `MODERATION_CLASSIFY_IMAGES=true`. While it is off, a message carrying *only* an image is not classified at all (there is no text to look at) so posting an image is a way around moderation. With it on, image URLs are sent to the moderation endpoint alongside any text (Discord's signed CDN links are fetched by OpenAI; nothing is downloaded or stored by Mai).
- The queue holds **metadata only**: message text is never persisted. The content quoted in the warning DM is read from Discord at enforcement time.

## Mai persona features

- **Chat** ([src/gateway/events/mai-chat.js](src/gateway/events/mai-chat.js), [src/chat/reply.js](src/chat/reply.js)): mentioning the bot, replying to one of its messages, or sending it a direct message makes Mai answer in character (`OPENAI_CHAT_MODEL` via `POST /chat/completions`). A typing indicator runs while the model call is in flight, and all pings inside the reply are suppressed via `allowedMentions` plus `@everyone`/`@here` neutralization.
  - Guild messages addressed to Mai are moderated **first**: a flagged message gets no chat answer: the scold reply takes its place, and the message never reaches the chat pipeline or the history table.
  - **Direct messages** are always treated as addressed to Mai (no mention needed) and skip moderation, but only from an author who shares at least one `DISCORD_GUILD_IDS` guild with the bot (`isDmAuthorInAllowedGuild`, a per-guild `members.fetch`; empty allowlist = open). A DM has a `null` guild id; history is keyed per channel (a DM channel is stable per user). The check runs before any chat rate limit, so its answer is cached per user (10 minutes for a yes, 30 for a no) with a small per-user limiter behind the cache; otherwise a stranger's DM spam is a free Discord round trip per guild per message.
  - **Memory**: the last `CHAT_HISTORY_TURNS` turns of the channel are sent as a real `messages[]` array: one entry per turn with its own role, user turns prefixed with the speaker's name because a channel has many. Turns are stored in SQLite with `content` and `username` encrypted (AES-256-GCM, `CHAT_HISTORY_KEY`) and pruned after `CHAT_HISTORY_MAX_AGE_HOURS`. One of only two places message content is stored (see *Storage*).
  - **Context Discord hides**: what a message replies to (quoted, truncated) and the thread it sits in are resolved and put in front of the current turn. Without them a reply reads as a non-sequitur. Neither is persisted: only what the member wrote themselves.
  - **Prompt injection**: only the system message carries instructions, and it says so. Text the speaker merely *chose* to pull in (the quoted message, the thread title) is wrapped in `⟪…⟫`, with those characters stripped from the value first so it cannot close its own fence. Speaker labels have newlines and colons removed, so a username cannot forge a second `Name:` turn. The speaker's own message is deliberately not fenced: it is the thing being answered.
  - **Vision** (`CHAT_VISION_ENABLED`): image attachments on messages addressed to her are passed to the model as content parts, at most `CHAT_VISION_MAX_IMAGES` per message. Images are never stored; a picture-only message is remembered as a placeholder.
  - **Tools** (`CHAT_TOOLS_ENABLED`, [src/chat/tools.js](src/chat/tools.js)): `get_my_violations`, `get_server_info`, `get_current_time`, `get_my_timeout_status`, `get_my_appeal_status`, and `get_server_rules` where `chat.rules` in the YAML is filled in (an empty list means the tool is not offered at all, because one that answers "no rules" sends the model straight back to inventing them). **No tool takes arguments from the model**: who is asking and where comes from the interaction context, so a model cannot read another member's record by naming them. They are also synchronous by design, so the timeout tool reads the member cache and reports "unknown" on a miss rather than guessing. At most two tool rounds, then the last call goes out without tools so she has to answer in words.
  - **Tone**: while the author has an open (un-enforced) violation in the queue (in *any* guild, DMs included) Mai turns aggressive, escalating with the number of open strikes. Enforcement (or `/mod forgive`) makes her friendly again. This reads the *queue*, not the strike record: a member with an empty queue and ten strikes gets friendly Mai.
  - **Limits**: `CHAT_RATE_LIMIT_MAX` replies per user per `CHAT_RATE_LIMIT_WINDOW_MS`, `CHAT_MAX_CONCURRENT` model calls in flight. Over either limit she reacts with the busy emoji instead of answering. Turns in one channel are serialized so parallel conversations cannot interleave history reads and writes.
  - `CHAT_ENABLED=false` disables chat.
- **Reactions** ([src/gateway/events/reactions.js](src/gateway/events/reactions.js)): keyword triggers (fish, cat words, meowing, "gute Katze") get an emoji reaction, some only with a random chance. At most one reaction per message. Triggers live in `config/mai.yaml`, and `content.js` strips `g` and `y` from their `flags`: the patterns are used with `.test()`, where either flag walks `lastIndex` and makes the same message match, then not, then match again. A reaction firing every other time is not something anyone would go looking for in a config file.
- **Welcome messages** ([src/gateway/events/guild-member-add.js](src/gateway/events/guild-member-add.js)): new members are greeted in the guild's `welcome-channel`, falling back to its system channel (and to silence if neither is reachable). Requires `DISCORD_WELCOME_ENABLED=true` **and** the privileged "Server Members Intent" (Developer Portal → Bot): the flag gates the `GuildMembers` intent, because logging in with a privileged intent that is not enabled in the portal fails.
- **Presence** ([src/gateway/presence.js](src/gateway/presence.js)): custom status ("😺 schnurrt irgendwo in der Nähe", …) picked at random on gateway ready and rotated every `PRESENCE_ROTATE_HOURS` hours (default 3; 0 = no rotation).

## Slash commands

Every command and right-click action, option by option, lives in
**[COMMANDS.md](../COMMANDS.md)**. In short:

| Command | Who |
|---------|-----|
| `/ping`, `/mai ask <frage>`, `/mai forget`, `/mai appeal` | everyone |
| `Nachricht melden` (right-click a message → Apps) | everyone |
| `/mod setup`, `/mod status`, `/mod history`, `/mod forgive`, `/mod warn`, `/mod note`, `/mod simulate`, `/mod spend` | Manage Messages |
| `/mod off` / `/mod on`, `/mod exempt`, `/mod config` | Manage Messages |
| `Löschen (Mai)` (right-click a message → Apps) | Manage Messages |

Discord hides the `/mod` subcommands from members without Manage Messages
(`default_member_permissions`), but the check is repeated in code: that field is
a UI default a server admin can widen. Every `/mod config`, `/mod exempt` and
`/mod off` / `/mod on` run also posts a `config` entry into the guild's own log
channel, because `updated_by` in a database nobody can read from Discord is not
visibility, and `/mod off` is exactly when the rest of the team needs to know.

## Reports and appeals

Both need a configured `log-channel`: without one there is nowhere for either
to land, and Mai says so instead of swallowing them.

**Reporting** ([src/commands/report.js](src/commands/report.js)): right-click a
message → *Apps* → *Nachricht melden* opens a modal asking why (optional). The
report appears in the log channel with **Löschen** / **Verwerfen** buttons; both
are Manage Messages-only and checked server-side, not just hidden. Approving
deletes the reported message immediately: a human already judged it, so there is
no grace period; a message that is already gone is recorded as such rather than
failing the click. Dismissing keeps it. Rate limit: 5 reports per member per 10
minutes.

The decision is written back into the log entry itself, so **every** moderator
sees it: the title and colour change, the buttons disappear so nobody
re-decides, and a field names who decided what. A second click replaces that
field instead of stacking another one. The approve path is deferred before the
delete, so a slow Discord round trip cannot make the click fail and leave stale
buttons behind, but only for staff, since a deferred response can no longer be
ephemeral and a stranger's refusal must not overwrite the entry.

**Appealing** ([src/moderation/appeal.js](src/moderation/appeal.js)): the warning
DM carries an *Einspruch einlegen* button. It opens a modal, and the member's
statement is posted into that guild's log channel. Rate limit: 3 per member per
hour, whichever door the appeal came through.

**`/mai appeal`** is the second door, for a member with DMs closed: the warning
never reaches them, so neither does the button, and they would be enforced with
no way to answer for it. The command rebuilds the same appeal from the strike
record: the most recent enforcement pass, found by the gap between strikes
(rows of one tick are written seconds apart, two passes a tick interval apart),
and only inside the strike window, because a strike that no longer counts has
nothing left for a granted appeal to overturn. Everything downstream is the
identical flow, including the scope: the incident, not the record.

That entry carries **Stattgeben** / **Ablehnen** buttons, both Manage
Messages-only and checked server-side. Either way the decision is written back
into the entry (same pattern as a report) *and* DMed to the member, because an
appeal that disappears into a staff channel is not an appeals process. A closed
DM is recorded as such rather than failing the click.

Granting an appeal means Mai was wrong, so the strikes it is about **stop
counting**: they are marked `overturned` rather than deleted, which takes them
out of the escalation ladder while leaving the record honest: `/mod history`
still shows them, labelled *Einspruch stattgegeben*.

Only the strikes from the enforcement pass being appealed, though. The warning
DM covers one pass, and its timestamp travels through the button ids
(`appeal:<guild>:<since>` → `appeal-grant:<user>:<since>`), so appealing one
incident cannot clear four earlier, correct strikes. Staff who *do* mean the
whole record run `/mod forgive <user> strikes:true`.

Reports and appeals are the only paths where member-written text reaches the log
channel, and only because that member typed it and pressed submit. The reported
message itself is still just linked, never copied.

**Evidence** ([src/db/evidence.js](src/db/evidence.js)) answers the question the
record could not: *what did the deleted message actually say?* Staff deciding an
appeal had ids and category slugs, the message was gone, and the only place its
text was ever quoted is the offender's own DM, so "das war doch nur ein Zitat"
came down to the member's word against Mai's.

This is the second deliberate exception to the no-content rule, and every limit
around it is deliberate:

- **off** unless the operator set `MODERATION_EVIDENCE_HOURS` *and* the guild ran
  `/mod config set evidence:true`. Two switches, because it is the operator's
  database and the guild's members;
- only messages Mai **enforced**, captured at the moment she deletes them (the
  text is in hand anyway: the warning DM quotes it);
- **encrypted** at rest with the same AES-256-GCM key as the chat history;
- **hours, not days**, pruned by the same tick as everything else. Setting the
  window back to 0 clears what is left on the next tick, and `/mod forgive
  <user> strikes:true` clears that member's;
- read back through a *Beweis ansehen* button on the appeal entry that is
  Manage Messages-only, answers **ephemerally** (one moderator, once: posting it
  into the channel would put the text back in front of everyone, which is what
  deleting it was for), and is scoped to the **incident** being appealed rather
  than to the member's back catalogue. The guild comes from the interaction, not
  from the `custom_id`: the clicker names a member, not a server;
- the button is only attached where evidence is actually kept, so it is never a
  promise Mai cannot keep.

## Staff acting through Mai

Everything above is Mai deciding. Three commands let the team decide instead,
and land in the same record so the next moderator sees one history rather than
"what Mai did" plus whatever happened out of band:

- **`Löschen (Mai)`** ([src/commands/remove.js](src/commands/remove.js)),
  right-click a message → *Apps*. The message goes and the strike is recorded,
  so it counts towards the *next* automatic escalation. No grace period (a human
  already looked), no timeout (Discord's own is right there, with the duration
  visible), no appeal button (an appeal is against Mai being wrong; this was a
  person). If Mai still had the message queued, that row and its scold reply go
  too: otherwise the next tick would find the message missing, read it as the
  author having fixed it, and write a self-deletion over the strike.
- **`/mod warn <user> [reason]`**: the warning DM Mai sends after enforcement,
  but from the team and without anything having been deleted. Recorded as
  `warned`, which is deliberately **not** a strike, so a moderator having a word
  cannot quietly move somebody up a ladder that ends in a timeout. A closed DM
  is reported to the moderator and in the log entry, so they can say it in the
  channel instead.
- **`/mod note add|clear <user>`**: what the team knows that no counter records
  ("already spoke to them in voice", "is fourteen"). Shown in `/mod history`,
  where somebody will actually look. Plaintext, unlike the two encrypted
  content stores: this is staff's own words about their own server, the same
  class as a report reason. Pruned on the strike-record window, so it does not
  become an unbounded file on a person.

## Joining a server, and staying alive in it

Three things Mai does about her own setup, because nobody else will:

- **She introduces herself, once** ([src/gateway/events/guild-create.js](src/gateway/events/guild-create.js)). A fresh server used to get nothing: no log channel, every house rule off (the only honest default for a house rule), and seventeen `/mod config set` options between an admin and a working bot. She now posts one message in the system channel (or the first channel she may write in) naming what she does, and carries the three setup presets as buttons: one click is a whole configuration. `onboarded_at` in `guild_settings` keeps it to one message ever, whatever a reconnect or a re-join does, and the row it writes does not count as "configured" in the metrics.
- **She checks her own permissions** ([src/permissions.js](src/permissions.js)): once per process for every allowlisted server, again on join (the result goes into the introduction), and on demand in `/mod status`. Only what that server switched on is checked, so a guild with escalation off is not nagged about Moderate Members. Every one of these fails gracefully at runtime, which is exactly why nobody notices them.
- **She restarts herself when wedged** ([src/moderation/enforcer.js](src/moderation/enforcer.js)): the overlap guard turns a hung tick into permanent silence, and `/healthz` reporting that changes nothing on its own, because Docker restart policies do not watch health. After `MODERATION_STUCK_RESTART_TICKS` intervals with no sign of life the process logs at `fatal` (so the alert channel hears about it) and exits, and `restart: on-failure` brings back a working one. It measures **progress**, not completion: every resolved row counts, so a long pass through a backlog under a rate limit is never mistaken for a hang and restarted into the same backlog forever.

### Presets

[src/moderation/presets.js](src/moderation/presets.js), applied by `/mod setup <preset>` or by the buttons on the introduction:

| Preset | What it sets |
|---|---|
| `observe` | An observation period: shadow mode until `MODERATION_SHADOW_DAYS` are up, invite filter on, mention cap 6, flood `6/10`, name check `log`, escalation off. Everything detects, nothing acts, and she switches herself back to enforcing when the window ends |
| `standard` | The same detection, enforced |
| `strict` | Enforced, plus threshold `0.3`, mention cap 5, flood `5/10`, grace 5 minutes, name check `reset` |

A preset is a starting point, not a mode: it writes ordinary per-guild settings
through the ordinary path, and every one of them can be changed afterwards or
put back with `/mod config reset`. None of them touches `enabled`, so applying
one cannot undo somebody's `/mod off`, and only `strict` sets a `threshold`:
guessing that number for a server nobody has looked at is the tuning-by-deletion
that shadow mode exists to replace.

## Per-guild settings

One process serves several servers, and they disagree about where Mai should log
and how long the grace period is. `guild_settings` holds only what a server
actually changed; a NULL column inherits the process default from `.env`.
[src/db/settings.js](src/db/settings.js) is the single authority:
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
| `threshold` | `MODERATION_THRESHOLD` | Minimum category score (0–1) that counts; 0 defers to the provider's own `flagged` |
| `categories` | `MODERATION_CATEGORIES` | Category slugs that count at all, comma-separated; empty = all of them (max 30) |
| `exempt-channels` | none | Channels moderation ignores, comma-separated (max 50). Edited through `/mod exempt add\|remove\|list`, not `/mod config set` |
| `enabled` | on | The kill switch: same flag as `/mod off` / `/mod on` |
| `invite-filter` | `MODERATION_INVITE_FILTER` | Treat Discord invite links as a violation |
| `link-policy` | `MODERATION_LINK_POLICY` | `off`, or `allowlist`: every link outside `link-domains` counts |
| `link-domains` | `MODERATION_LINK_DOMAINS` | Allowed host names, comma-separated (max 50); subdomains of a listed host are covered |
| `mention-cap` | `MODERATION_MENTION_CAP` | Most mentions one message may carry, `@everyone` included (0–100, 0 = off) |
| `flood` | `MODERATION_FLOOD` | Burst rule as `count/seconds`, e.g. `6/10`; `off` disables it here |
| `name-check` | `MODERATION_NAME_CHECK` | Display names: `off`, `log`, or `reset` (also removes the server nickname) |
| `shadow` | off | Report every verdict in the log and act on none of them. No process default: `/mod setup observe` for a window that ends by itself, `/mod config set shadow:true` for an open-ended one |
| `evidence` | off | Keep enforced messages (encrypted, `MODERATION_EVIDENCE_HOURS`) so staff can review an appeal |

A setting whose value is a *list* still lives in the `SETTINGS` map as one
comma-separated column, but gets its own subcommands for editing: nobody types
channel ids into `/mod config set`. `link-domains` is the exception that proves
the rule: host names are read and written by humans, so it stays a plain option.

For the local rules, "off" and "not configured" are different answers, and the
column keeps them apart: `/mod config set flood:off` stores an explicit *no
flood rule here* rather than reverting to whatever `.env` says, which is what
`/mod config reset flood` is for.

Two settings need something only the operator can switch on, because a guild
cannot: `name-check` rides on a gateway intent (requested once, at login, for
the whole process) and `evidence` on a retention window in the operator's
database. Both are stored anyway, so they take effect the moment that changes,
and `/mod config set` says plainly that nothing is happening yet. Silently
accepting a setting that does nothing is how a server ends up believing it is
protected.

### Kill switch

`/mod off` stops Mai in that server completely: no moderation, no chat, no
reactions, no welcome, and queued rows are not enforced. It is a pause, not an
amnesty: the rows are kept and resume when `/mod on` is used, rather than
quietly forgiving everything. `/mod` itself keeps answering while she is off,
otherwise the only way back would be editing the database. Everything else
replies with the paused message. Direct messages are unaffected: a DM has no
guild to pause.

Adding a setting means: a column in a new migration, an entry in the `SETTINGS`
map (with its parse/validate rule), and an option on `/mod config set`.

## Moderation log

With `log-channel` set, every moderation action is posted as an embed
([src/moderation/log.js](src/moderation/log.js)), one colour and title per kind:

| Kind | Colour | When |
|---|---|---|
| `flagged` | amber | Classified as a violation; carries a jump link and the deletion deadline |
| `deleted` | red | Enforced after the grace period |
| `selfDeleted` | green | The author removed it themselves in time |
| `cleared` | teal | The author edited the violation back out |
| `forgiven` | blue | `/mod forgive`, naming the staff member and the count |
| `reported` | blurple | A member reported a message; carries the *Löschen* / *Verwerfen* buttons |
| `appealed` | purple | A member appealed a warning; carries *Stattgeben* / *Ablehnen* |
| `appealGranted` / `appealDenied` | green / near-black | How staff decided |
| `timeout` / `timeoutFailed` | red / orange | The escalation ladder fired, or Discord refused it |
| `stuck` / `abandoned` | orange / grey | A row keeps failing to enforce, and where Mai gives up |
| `config` | slate | `/mod config`, `/mod exempt` or `/mod off` / `/mod on` changed the rules |
| `warningUndelivered` | orange | The warning DM bounced: the member was enforced without ever being told, and never saw the appeal button |
| `degraded` / `recovered` | orange / green | Classification started failing (moderation is passing everything through here), and started working again |
| `nameFlagged` | dark orange | A member's display name was classified as a violation, and what happened to it |
| `shadow` | grey | Shadow mode: what Mai *would* have done, with the score that decided it |
| `shadowEnded` | teal | An observation period ran out: she is enforcing from now on, and this is how much she would have acted on during it |
| `manualDelete` / `warned` | red / amber | Staff acting through Mai: a message deleted by hand, or `/mod warn` |

**Every entry starts with the same head**: member, channel, message, in that
order, and each kind appends its own fields. Following one incident across
*markiert → gelöscht → Einspruch* never means hunting for the message id in a
different field or finding it absent. The id is always rendered in a code span
(it correlates with Discord's audit log even once the message is gone), and a
jump link is added only for the kinds where the message still exists: a link to
a deleted message is a 404.

**Metadata only.** No message content goes into the channel: a Discord channel
is permanent storage readable by everyone with access, which would undo the
no-content rule. Entries carry ids, category slugs, timestamps and a jump link
while the message still exists; the offender's own warning DM stays the only
place their text is quoted back. **That includes `err.message`**: an exception
message is free text that can quote a channel name, a config value or a request
body, so a failure is described through
[src/errors.js](src/errors.js) instead: `explainError()` maps the Discord codes
that actually occur onto sentences in `moderation.errors` in the YAML and
appends the code, and anything unmapped degrades to the error's name plus
`status`/`code`. The full message stays in the container log. There is
deliberately **no** footer repeating the metadata-only rule: it is enforced in
code, and a disclaimer on every single entry was noise staff never acted on.

The only exception to the no-content rule is text a member wrote *for* staff and
submitted themselves: a report reason and an appeal statement.

Posting is best effort: a missing channel, a wrong channel type or a missing
permission is logged locally and never breaks the moderation pipeline. The
channel is also proven to be in the event's own guild before anything is sent:
the id comes from that guild's settings, but the fetch goes through the bot's
client, which reaches every guild Mai is in.

### Two authority tiers

Manage Messages makes someone staff **in their own server**. `OPERATOR_USER_IDS`
is whoever runs the bot. Mai serves several servers out of one database, so
every counter a command prints is filtered to the calling guild unless the
caller is an operator: a guild's moderators are not auditors of the other
servers Mai happens to run in. The same border applies to acting: `/mod forgive`
only pardons in the server it was run in. The one deliberate exception is Mai's
*chat* memory of a member's open violations, which stays cross-guild: her having
one memory of someone is not the same as one server's staff reaching into
another. Empty `OPERATOR_USER_IDS` means the cross-guild view is off entirely.

## Interaction handling

Dispatch for everything arriving at `POST /interactions` lives in
[src/interactions/router.js](src/interactions/router.js): pings, commands,
autocomplete, component clicks (buttons, select menus) and modal submits. The
guild allowlist **and** the kill switch are enforced there, once, for every kind.
One function decides *whether* to refuse, but each kind answers in its own
protocol, because they cannot all refuse the same way: an autocomplete has to be
refused with an empty choice list, and answering one with a message is a
protocol error Discord rejects rather than a refusal anyone sees. `/mod` itself
is deliberately let through while a guild is paused, otherwise switching Mai back
on would need database access.

Command options are read through
[src/interactions/options.js](src/interactions/options.js), never by walking
`interaction.data.options` in a handler: the payload shape differs between a
plain subcommand and a subcommand group, and `resolveSubcommand` flattens both
into `{ group, name, options }` so `/mod config set` and `/mod status` are
handled the same way.

The endpoint is reachable from the public internet through the tunnel, and
verifying an Ed25519 signature is the expensive part of handling a request, so
two cheap caps run *before* it: a per-client rate limit
(`INTERACTIONS_RATE_LIMIT_MAX` per window, keyed on `CF-Connecting-IP` since
every request otherwise carries the cloudflared container's address) and a body
size cap (`INTERACTIONS_MAX_BODY_BYTES`; a request without a `Content-Length` is
refused rather than streamed). Refusals are logged at `debug`: at HTTP volume an
`info` line per refusal would turn a flood into a second flood in the log.

Component `custom_id`s carry state, but an id from the client only ever *names* a
target, it never authorizes one. A handler acting for a user checks the id
against the clicker (`/mai forget`), and one acting on a channel checks that the
channel is in the clicker's guild (`report-approve`, since the bot's client can
reach every server Mai is in).

Discord expects the HTTP response within ~3 s. A handler that needs longer sets
`deferred` and the router answers with a placeholder ("Mai is thinking…"), then
edits it through the interaction webhook when the handler resolves, so handlers
never deal with the deadline themselves. Two traps come with that: `ephemeral` is
fixed at defer time and the later edit **cannot** change it, so a deferred public
command has to return public refusals too; and the interaction token expires
after 15 minutes, so a failed edit is not retried.

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

Buttons and modals carry their state in the `custom_id` (`name:arg:arg`); the part
before the first colon selects the handler from
[src/interactions/registry.js](src/interactions/registry.js), which collects the
handler maps exported by the feature modules (`forgetComponents` in
[src/commands/mai.js](src/commands/mai.js), `reportComponents` / `reportModals` in
[src/commands/report.js](src/commands/report.js), `appealButtons` /
`appealDecisions` / `appealModals` in
[src/moderation/appeal.js](src/moderation/appeal.js)). A click by someone other
than the id's owner is refused: never trust a client-supplied id. When such a
check fails inside a handler that is already deferred it must **not** answer with
a refusal (after a defer the response replaces the log entry); it falls through as
a failed action so the outcome lands in the entry instead.

**Opening a modal cannot be deferred; submitting one must be.** Discord opens the
modal as the immediate response, so a handler returning `modalResponse` does
synchronous work only (`report.execute`, `appealButtons.appeal`). The *submit*
handler is the opposite case: publishing to the log channel is a fetch plus a
send, two Discord round trips that outlast the ~3 s budget under a rate limit,
and the cost of blowing it is the member's typed report or appeal, which they
cannot get back. Everything a submit handler needs therefore has to travel in the
modal's `custom_id`: the resolved data of the original interaction is gone by
then, and the 100-character id limit is the real budget
(`report:<channelId>:<messageId>:<authorId>` is 65).

## Tests

```sh
npm test        # node:test, no dependencies, no network
```

`test/setup.js` fills the environment before `config.js` is imported and points
the database at a throwaway file. `config.js` reads and validates the environment
*at import time*, so anything a file needs switched on has to be set before that:
each `test/setup-*.js` does exactly that for one shape of configuration and must
be imported **before** `setup.js`.

| Setup | Turns on |
|---|---|
| `setup-chat.js` | Chat, with a history key |
| `setup-moderation.js` | Moderation |
| `setup-gateway.js` | Both at once, the only configuration in which `onMessageCreate` makes all of its decisions |
| `setup-security.js` | Both plus the operator tier and a token budget |
| `setup-limits.js` | Chat with deliberately tiny guards and a budget small enough to blow through |
| `setup-enforcer.js` | Two allowed guilds and a tiny per-tick cap, to exercise the capped, ordered due query |
| `setup-http.js` | A tiny interactions rate limit, so three requests reach the gate instead of 120 |
| `setup-metrics.js` | A `METRICS_TOKEN`, for the one file covering the auth path |
| `setup-alerts.js` | `ALERT_CHANNEL_ID` and a `LOG_LEVEL` low enough that the pino hook is not a no-op |
| `setup-openai.js` | Retries actually switched on, since the retry loop is what is under test |
| `setup-presence.js` | An absurd rotation interval, so the 32-bit timer clamp is under test |

OpenAI and Discord are reached through a stubbed global `fetch`. Tests are not
copied into the image (see `.dockerignore`): run them on the host.

## Configuration

Two surfaces, both read once at startup:

- **`.env`**: secrets, models, feature flags, timings, limits. See [../.env.example](../.env.example). Changing it requires a container **recreate** (`docker compose up -d mai`), not just a restart.
- **`config/mai.yaml`**: everything Mai says: persona, prompt scaffolding, moderation tone directives, scold lines, warning-DM template, `/mai` and `/mod` replies, log-embed titles and field labels, the Discord error codes explained to staff (`moderation.errors`), welcome lines, reaction triggers, presence statuses. Loaded and validated by [src/content.js](src/content.js). **No handler may contain a literal string Mai says**: adding wording means a YAML key plus a validated field in `content.js`. Point `MAI_CONFIG_PATH` at a read-only bind mount to edit it without rebuilding the image; a restart applies it.

## Storage

SQLite via the builtin `node:sqlite` module (no native dependency), at `DATABASE_PATH` (default `/data/mai.sqlite`, on the `mai-data` volume: the container rootfs is read-only). Schema changes are new numbered files in [src/db/migrations/](src/db/migrations/), applied automatically at startup and recorded in `schema_migrations`.

| Table | Contents | Retention |
|-------|----------|-----------|
| `moderation_queue` | Pending enforcement: ids, category slugs, timestamps, `attempts`: no content | until the row resolves (enforced, forgiven, self-deleted or edited clean) |
| `violations` | The long-term strike record: ids, category slugs, action, timestamp: no content | `VIOLATION_RETENTION_DAYS` |
| `chat_history` | Mai's short-term memory; `content`/`username` encrypted | `CHAT_HISTORY_MAX_AGE_HOURS` |
| `evidence` | Enforced messages, for reviewing an appeal; `content` encrypted. Off by default | `MODERATION_EVIDENCE_HOURS` (0 = never stored) |
| `member_notes` | What staff wrote down about a member (`/mod note`), plaintext: staff's own words about their own server | `VIOLATION_RETENTION_DAYS` |
| `guild_settings` | Per-guild overrides of the process defaults; NULL = inherit | until changed |
| `usage_daily` | Call and token counters per day, guild, model and purpose | kept |
| `schema_migrations` | Which numbered migration files have been applied | kept |

**The first two are not the same thing.** `moderation_queue` is what is *pending*
and is emptied the moment a row resolves; `violations` is the record that stays.
Mai's chat tone reads the queue (an *open* violation makes her hiss), escalation
counts the record. A member with an empty queue and ten strikes is friendly-Mai
but next-step-on-the-ladder.

`chat_history` is the first deliberate exception to the no-content rule, limited
to messages addressed to Mai. `content` and `username` are ciphertext
([src/db/crypto.js](src/db/crypto.js)); `channel_id` and `sent_at` stay plaintext
because they are the lookup and pruning keys. Rotating `CHAT_HISTORY_KEY` makes
older rows undecryptable: they are skipped and pruned, never crash a reply.

`evidence` is the second and the narrower one: enforced messages only, two
switches to turn on (operator *and* guild), the same key, hours rather than
hours-times-forty-eight, and one ephemeral reader. See *Reports and appeals*.
Both tables use the same key, so `CHAT_HISTORY_KEY` is required as soon as
either feature is on.

## Operations

**Token accounting** ([src/db/usage.js](src/db/usage.js)): every API call is
counted where the response reports it, so `/mod spend` can answer "how much?"
without guessing. Counters only: no prompts, no replies, nothing identifying a
member. `OPENAI_MONTHLY_TOKEN_BUDGET` (UTC calendar month, 0 = no limit) is the
safety net: once the month's tokens are used up, chat degrades to reactions:
Mai answers a mention with the busy emoji instead of a reply. **Moderation is
never gated by the budget**; safety is not a budget item, and the moderation
endpoint reports no tokens anyway.

**Metrics** ([src/http/metrics.js](src/http/metrics.js)): `GET /metrics` in
Prometheus text format: queue depth, overdue rows, parked rows, the highest
failed-attempt count on any row, strike records by outcome, chat-history size,
this month's tokens and calls by purpose and model, the configured token budget,
the age of the last enforcer tick and whether one is in flight, and how many
guilds have changed a setting at all.

`mai_queue_overdue` and `mai_queue_paused` are split on purpose: they say
opposite things about rows that look identical in the table. A guild that ran
`/mod off` keeps its rows past `due_at` *by design*, so counting them as overdue
made the alerting signal fire on a server that had simply switched Mai off.
`overdue` is what a tick would act on right now, `paused` is what is deliberately
parked, and both reuse the enforcer's own exclusion list (allowlist filter
included) so the two views cannot drift apart from its behaviour.

It is **off unless `METRICS_TOKEN` is set** (404, so an unconfigured endpoint
does not advertise itself), and then wants that token as `Authorization: Bearer
…`, compared with a timing-safe equality. The whole HTTP server is public
through the tunnel and these numbers span every guild Mai serves, so this is
operator data in the same sense `/mod spend` is. Labels are deliberately
low-cardinality (`purpose`, `model`, `action`) and never a guild, user or
channel: that would turn a metrics series into a per-member activity record, and
it is unbounded besides.

**Error alerts**: with `ALERT_CHANNEL_ID` set, every `error` and `fatal` log line
is mirrored into that channel. It is wired into pino as a hook
([src/alerts.js](src/alerts.js)), so no call site can forget to raise one, and
only whitelisted keys (ids, command/component/modal/tool names, request paths,
status codes, attempt counts) are forwarded: a log record may carry content, an
alert must not. **`err.message` is not forwarded either**, only the error's name
plus `status`/`code`, for the same reason the moderation log follows that rule:
the alert channel is permanent Discord storage and an exception message is free
text that can quote config, a database value or a request body. The full message
stays in the container log, which is where an operator debugging this already
is. Throttled to 5 per 5 minutes, with the dropped ones counted and reported by
the first alert of the next window. Two consequences worth knowing: alerts are
process-wide, not per guild, and a `LOG_LEVEL` above `error` silences them too,
because pino replaces a disabled level's method (hook included) with a no-op.

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
   - *Bot* → enable **Server Members Intent** (privileged) **only if** you set `DISCORD_WELCOME_ENABLED=true` or `MODERATION_NAME_CHECK` to anything but `off`: either flag makes the bot request the `GuildMembers` intent, and login fails when the portal toggle is off. Screening display names also wants **Manage Nicknames** on the invite if you use `name-check: reset`.
   - Direct-message replies need **no** portal toggle: the non-privileged `DirectMessages` intent is requested in code. Users can DM Mai once they share a server with her (subject to their Discord privacy settings).
   - Copy *Application ID*, *Public Key* (General Information) and *Bot Token* (Bot) into `.env`.
   - Invite the bot with the `bot` + `applications.commands` scopes. Permissions needed: Read Messages, Send Messages, Embed Links (moderation log), Add Reactions, Manage Messages (deleting flagged messages), and **Moderate Members** for the escalation timeouts. Mai's role must sit above the members she is expected to time out: Discord refuses otherwise, and admins and the owner can never be timed out.
2. **Secrets**: `OPENAI_API_KEY`, and `CHAT_HISTORY_KEY` from `openssl rand -base64 32`.
3. **Cloudflare tunnel**: route your public hostname to `http://mai:3000`.
4. **Interactions Endpoint URL** (General Information): set to `https://<your-hostname>/interactions`. Discord sends a signed PING to verify: the stack must be running first.
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
- **New button, select menu or modal**: export a handler map from the feature module and list it in `src/interactions/registry.js`. State travels in the `custom_id`, which is capped at 100 characters, and it names a target rather than authorizing one: check the clicker.
- **New gateway event**: add a handler in `src/gateway/events/` and wire it in `src/gateway/client.js` (`client.on(Events.X, ...)`).
- **New reaction trigger / new wording**: edit `config/mai.yaml`. No code change, no rebuild if the file is bind-mounted. No handler may hold a literal string Mai says.
- **New per-guild setting**: a column in a new migration, an entry in the `SETTINGS` map in `src/db/settings.js` (with its parse/validate rule), an option on `/mod config set`, and a key in `inherited`. Read it through `effectiveSettings(guildId)`, never `config.moderation.*` directly.
- **New table or column**: add `src/db/migrations/00N_*.sql` and a repository function next to `queue.js` / `history.js`. Nothing outside `src/db/` may contain SQL, and an applied migration is never edited.
- **New Discord error code worth explaining to staff**: add it under `moderation.errors` in `config/mai.yaml`. Never reach for `err.message`.
- **Different model provider**: `OPENAI_BASE_URL`, where only `/chat/completions` and `/moderations` are used.

## Logging

Structured JSON via pino. `LOG_LEVEL=info` logs metadata only (IDs, category slugs, model names, timings); `LOG_LEVEL=debug` adds message content, prompts, replies and warning-DM bodies. **Usernames count as content.** The rule covers both directions: inbound message text and Mai's own replies. Moderation `category_scores` are metadata but only the *highest* one is logged, at `debug`: a full score vector is a profile of the message.

`LOG_LEVEL` also decides whether error alerts happen at all, since they hang off the same pino methods (see *Operations*).
