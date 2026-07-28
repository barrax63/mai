# Mai's commands

Every slash command and right-click action Mai registers, what it does, who may
use it and where the answer lands.

Definitions live in [mai/src/commands/](mai/src/commands/); the moderation
behaviour behind them is described in [mai/README.md](mai/README.md). New or
changed commands only reach Discord after:

```sh
docker compose run --rm mai npm run register
```

## Conventions used below

- **Everyone** means any member of a server Mai is active in. **Staff** means
  Manage Messages *in that server*. **Operator** means an id in
  `OPERATOR_USER_IDS`, whoever runs the bot itself.
- Discord hides staff commands from members without the permission, but every
  check is repeated in code: that field is a UI default a server admin can
  widen.
- **Ephemeral** answers are visible only to the person who ran the command.
  Everything operational is ephemeral; the two exceptions are `/mai ask`, whose
  answer is the point of asking in public, and Mai's own moderation replies.
- Counters are scoped to the server the command was run in. An operator sees
  process-wide figures instead, marked *(alle Server)*.
- In a server that ran `/mod off`, only `/mod` answers. Everything else replies
  that Mai is asleep, so switching her back on never needs database access.
- Servers outside `DISCORD_GUILD_IDS` get no response at all, including
  autocomplete.

## For everyone

### `/ping`

Liveness check. Answers `Pong!` with the interaction id, so a reply can be
matched to a request in the container log. Ephemeral.

### `/mai ask <frage>`

A public question to Mai, answered in character. Ephemeral: no. The answer
quotes the question back into the channel, which is why this command is the one
path where a member's text is republished by the bot without the message
pipeline having seen it, and why the question is **classified first**. A flagged
question is refused rather than repeated, and the refusal costs no tokens
because the screen runs before the model call.

Stateless on purpose: no channel history goes into the prompt and neither the
question nor the answer is written to Mai's memory. One question, one answer.
Subject to the same per-user rate limit and concurrency cap as ordinary chat,
and to the monthly token budget; over any of them Mai answers in character that
she cannot be bothered right now.

`frage` is required, at most 400 characters.

### `/mai forget`

Wipes what Mai remembers about you, behind a *Ja, vergiss alles* / *Abbrechen*
confirmation. Ephemeral.

Removes your own turns everywhere, plus the full history of your DM channel with
her (there the whole conversation is yours, including her replies, which may
quote you). It does **not** touch the moderation record: an offender cannot
delete the evidence for their own appeal, and strikes are not chat memory.

### `/mai appeal`

Opens the appeal form for your most recent enforcement in this server. Ephemeral
until you submit; the statement then goes to the server's moderation log.

The normal way into an appeal is the button under the warning DM. This command
is the second door, for members whose DMs are closed: the warning bounces, so
the button never arrives, and without this they would be enforced with no way to
answer for it. It reconstructs the same scope from the strike record, so
granting the appeal overturns exactly that incident and not the whole file.

Refused when: run in a DM (an appeal names a server), the server has no
moderation log (the appeal would land nowhere), or there is nothing recent to
appeal. At most 3 appeals per member per hour, whichever door they came through.

### `Nachricht melden` (right-click a message, *Apps*)

Reports a message to staff. Opens a modal asking why (optional, at most 500
characters), then posts the report into the server's moderation log with
*Löschen* / *Verwerfen* buttons for staff. Ephemeral confirmation to the
reporter.

The reported message itself is only linked, never copied: what reaches the log
is the reporter's own words plus ids. Needs a configured `log-channel`, and Mai
says so rather than swallowing the report. At most 5 reports per member per 10
minutes.

## For staff (Manage Messages)

### `/mod status`

Queue depth and chat-memory size for this server, when the last moderation tick
ran, whether classification is currently working, the configured models, and
uptime. Ephemeral.

The classification line matters because moderation **fails open**: when the
provider is unreachable, messages pass and Mai keeps chatting. The log channel
gets one entry when that starts and one when it ends, and this command answers
the same question on demand, which is the only route for a server with no log
channel.

### `/mod history <user>`

That member's record in this server: strikes inside the escalation window, the
totals by outcome, the last ten entries, the team's own notes, and what the next
enforced deletion would cost them. Ephemeral.

Outcomes are not all strikes. Only `gelöscht` counts towards escalation;
`selbst entfernt` (removed during the grace period), `korrigiert` (edited
clean), `vom Team verwarnt` (`/mod warn`) and `Einspruch stattgegeben` are on the
record deliberately and deliberately do not.

### `/mod forgive <user> [strikes]`

Drops that member's open violations in this server and cleans up the scold
replies, so Mai stops hissing at them. Ephemeral.

`strikes:true` additionally wipes their strike record here, which resets the
escalation ladder, and takes any appeal evidence kept about them with it: a
pardon that leaves the quotes in the database is not a pardon. Staff notes are
**not** cleared, because they are the team's own memory rather than a
consequence; `/mod note clear` is for those.

### `/mod warn <user> [reason]`

Sends the member a warning DM from the team, in Mai's voice. Ephemeral.

Recorded as `warned`, which is deliberately **not** a strike: a moderator having
a word must not silently move somebody up a ladder that ends in a timeout. The
DM carries no appeal button, since an appeal overturns strikes and this is not
one; it points the member at the team instead. A closed DM is reported to the
moderator and in the log entry, so they can say it in the channel instead.

`reason` is optional, at most 400 characters, and goes into both the DM and the
log entry.

### `/mod note add <user> <text>` and `/mod note clear <user>`

The team's own notes about a member ("already spoke to them in voice", "is
fourteen"). Shown in `/mod history`, where the next moderator will look.
Ephemeral.

Notes are per member and per server, at most 500 characters each, and pruned on
the same window as the strike record. They are stored in plaintext, unlike the
two encrypted content stores: a note is staff's own words about their own
server, the same class as a report reason.

### `/mod simulate <text>`

What would happen to this text in this server: the verdict, which local rule
would have caught it, the matched categories, the threshold in effect, and the
five highest category scores. Ephemeral.

The answer to "where do I put the threshold?" without finding out by deletion.
Nothing is stored, nothing is logged but the category slugs, and the text is the
moderator's own. This is the only place a full score vector is shown; do not
point it at a member's message with the intention of profiling them. At most 15
runs per moderator per 5 minutes. `text` is required, at most 400 characters.

### `/mod spend`

OpenAI calls and tokens today and this month for this server, broken down by
purpose and model. Ephemeral.

The monthly budget belongs to whoever pays the bill, so staff are told only
whether it is exhausted (which is why Mai stopped chatting); an operator sees
the figures. Tokens rather than currency: prices change and differ per model.
The moderation endpoint reports no token usage at all, so its rows say so
instead of showing a misleading zero.

### `/mod off` and `/mod on`

The kill switch for this server: no moderation, no chat, no reactions, no
welcome. Ephemeral.

A pause, not an amnesty: queued rows are kept and resume on `/mod on` rather
than being quietly forgiven. `/mod` itself keeps answering while she is off,
otherwise the only way back would be editing the database. Both post an entry
into the log channel, because `/mod off` is exactly when the rest of the team
needs to know.

### `/mod exempt add|remove|list [channel]`

Channels the delete-and-scold pipeline ignores: a vent channel, an NSFW channel,
a staff channel. Ephemeral.

Moderation only. Chat, reactions and welcomes keep working there, which is
usually the point. Exempting a channel covers the threads inside it, and any
pending queue rows in it are dropped on the next tick rather than enforced ten
minutes later, because "Mai does not moderate here" has to be true immediately.
At most 50 channels.

### `/mod config view|set|reset`

The per-server settings, marking which ones are inherited from the process
defaults in `.env`. Ephemeral. Every run posts an entry into the log channel:
staff change the rules on each other, and `updated_by` in a database nobody can
read from Discord is not visibility.

`set` takes any subset of the options below; `reset [setting]` returns one
setting to the inherited default, or all of them when the setting is omitted.

| Option | Effect |
|---|---|
| `log-channel` | Where moderation entries are posted. Unset = no log for this server, which also disables reports, appeals and evidence |
| `welcome-channel` | Where new members are greeted (default: the server's system channel) |
| `grace` | Minutes an author has to delete a flagged message themselves (1 to 1440) |
| `timeout-ladder` | Timeout minutes per strike, e.g. `0,10,60,1440`; the last step repeats |
| `strike-window` | Days an enforced deletion counts towards escalation (1 to 365) |
| `escalation` | Hand out timeouts at all. Off still records strikes |
| `enabled` | The same switch as `/mod off` / `/mod on` |
| `threshold` | Minimum category score (0 to 1) that counts. 0 defers to the provider's own `flagged`, which is tuned for English |
| `categories` | Only these category slugs count, comma-separated. Empty = all of them |
| `invite-filter` | Treat Discord invite links as a violation |
| `link-policy` | `off`, or `allowlist`: every link outside `link-domains` counts |
| `link-domains` | Allowed host names, comma-separated. Subdomains of a listed host are covered |
| `mention-cap` | Most mentions one message may carry, `@everyone` included (0 = off) |
| `flood` | Burst rule as `count/seconds`, e.g. `6/10`. `off` disables it here |
| `name-check` | Display names: `off`, `log`, or `reset` (also removes the server nickname) |
| `evidence` | Keep enforced messages briefly, encrypted, so staff can review an appeal |
| `shadow` | Report every verdict in the log and act on none of them |

Two of these need something only the operator can switch on: `name-check` rides
on a gateway intent and `evidence` on a retention window. Both are stored anyway
so they take effect the moment that changes, and the command says plainly that
nothing is happening yet.

For the last seven, "off" and "not configured" are different answers:
`/mod config set flood:off` stores *no flood rule here* rather than reverting to
whatever `.env` says, which is what `/mod config reset flood` is for.

### `Löschen (Mai)` (right-click a message, *Apps*)

Deletes the message through Mai and records the strike, so a staff decision
lands on the same record hers do and counts towards the next automatic
escalation. Ephemeral.

Three deliberate differences to the automatic path: no grace period (a human
already looked, which is what the grace period substitutes for), no timeout
(Discord's own is right there, with the duration visible), and no appeal button
(an appeal is against Mai being wrong; this was a person). If Mai still had the
message queued, that row and its scold reply go with it, or the next tick would
find the message missing, read it as the author having fixed it, and write a
self-deletion over the strike. Bot messages are refused.

## Buttons and modals

None of these are commands; they appear under something Mai posted. The
`custom_id` behind each one names a target and never authorizes one, so every
handler checks the clicker's own id or permissions.

| Control | Where it appears | Who |
|---|---|---|
| *Ja, vergiss alles* / *Abbrechen* | Under `/mai forget` | The member who ran it |
| *Löschen* / *Verwerfen* | Under a report in the log channel | Staff |
| *Einspruch einlegen* | Under a warning DM, when the server has a log channel | The warned member |
| *Stattgeben* / *Ablehnen* | Under an appeal in the log channel | Staff |
| *Beweis ansehen* | Under an appeal, when the server keeps evidence | Staff |

A staff decision is written back into the log entry itself (title, colour, a
resolution field, buttons removed) rather than into an ephemeral reply, so every
moderator sees the outcome and nobody re-decides it. An appeal decision is also
DMed to the member: an appeal that vanishes into a staff channel is not an
appeals process. *Beweis ansehen* is the exception that stays ephemeral: it
shows the deleted messages to the one moderator reviewing them, because posting
them into the channel would undo the deletion it documents.

## Things Mai does without being asked

Not commands, listed here so the picture is complete: classifying every new and
edited message, enforcing after the grace period with a warning DM and the
escalation ladder, screening display names, greeting new members, reacting to
trigger words, and replying in character to mentions, replies and direct
messages. All of it is described in [mai/README.md](mai/README.md).
