# IDEAS.md

Persona features that were worked out but not built, kept here so the reasoning
does not have to happen twice. Each entry names the seam it would use and the
constraints that are easy to get wrong, because for every one of these the
design question is the same: *what must it never touch?*

Three rules hold for everything on this list, and an idea that cannot keep them
does not belong here:

- **Persona never reaches moderation.** A feature that makes Mai quieter,
  louder, friendlier or stranger must leave deletion, strikes, the queue and the
  ladder exactly as they were. `message-create.test.js` asserts this for the
  petting sulk; a new one should be asserted the same way rather than left to
  good intentions.
- **State like this lives in memory**, next to `src/zoomies.js`,
  `src/chat/petting.js` and `moderation/health.js`. A restart is a nap. Anything
  that has to survive one is a per-guild *setting* with a migration, which is a
  much larger claim about its importance.
- **Nothing she says lives in a handler.** A new mood is a YAML key plus a
  validated field in `content.js`, every time.

## Open

### Gift dropping

Cats bring you things. Once every few hours Mai posts unprompted into one
channel: a GIF through the existing `search_gif`, or a server emote, with one
line. Fills a dead channel, and it is the only idea here that makes her speak
first.

Seam: the enforcer tick (it already runs every minute and already announces
things into a guild's channels), plus a `gift-channel` setting shaped like
`log-channel`. Reuses `gifEmbeds` in `chat/reply.js` and both GIPHY limiters.

Constraints, and the reason this one is not built yet: it is **opt-in per guild
with no default**, because a bot that starts talking in a channel nobody pointed
it at is a bot people remove. Never in an exempt channel, never while the guild
is paused or in an observation window, and hard-capped per guild per day. The
real cost is the GIPHY quota: a beta key is 100 searches an hour for the *whole
deployment*, which is already shared with chat, so a gift either takes a slice
of that budget or it uses an emote and no GIF. That is a decision about somebody
else's quota, which is why it needs a number chosen on purpose rather than a
default.

### If it fits, she sits

A message about a box gets a 📦. No code at all: one more entry in `reactions:`
in the YAML, something like `\b(karton\w*|kiste|box(es)?)\b` with `flags: 'i'`
at a modest chance.

Constraints are about the list rather than the feature. Order is precedence
(the loop stops at the first match and an aloof roll does not fall through), so
it belongs below fish and "gute Katze" and above the generic cat words, or "die
Katze sitzt im Karton" earns 🐱 and never 📦. It cannot go below the trigger
without a pattern, which `content.js` requires to stay last. And `box` is a
common word in gaming servers: the word boundaries keep "Xbox" out, but "loot
box" will still match, which is a reason for a low chance rather than a
longer pattern.

### Voice mode

Three different things go by that name, and each costs far more than the one
before it. The first two are worth building, as one feature; the third is a
maybe for purring and a no for listening.

**Voice messages in, text out.** A member sends her a voice message; it is
transcribed (`/audio/transcriptions`) and the transcript goes into the normal
chat path as their turn. Constraints:

- A voice message cannot carry a mention, so it only counts where no mention is
  needed: a DM, or a reply to one of her messages. `isMaiChatTrigger` already
  covers both.
- An env var for the transcription model, unset means off, for the same reason
  as `OPENAI_REASONING_EFFORT`: a provider behind `OPENAI_BASE_URL` may not
  offer the `/audio` endpoints at all.
- Length and size are checked before anything is downloaded (discord.js exposes
  `attachment.duration`), and the nap and the sulk are checked before anything
  is transcribed, so a refused turn costs nothing.
- The transcript is the member's own words, so it may go into `chat_history`
  (already encrypted) like any message. The audio is never stored, and the
  transcript is content: never logged above `debug`.
- Audio is billed per minute rather than per token, so `usage.js` needs a unit
  for it, or `OPENAI_MONTHLY_TOKEN_BUDGET` stops covering what chat spends.
- The real catch: voice messages in a server are unmoderated today, and
  answering one means answering something moderation never saw. DMs first,
  where moderation does not run anyway. In a server, the transcript could be
  classified for her *tone* only. Enforcing on a transcript is a separate and
  much larger feature: transcription errors would become strikes, and the
  evidence for an appeal would be a third content store.

**Voice message out.** She answers a voice message with one of her own, only
ever in reply to one, never unprompted. `/audio/speech` returns Opus directly,
and a model that takes an `instructions` field gives her a way of speaking;
that wording is persona and goes in the YAML (`voice.instructions`), with her
tones mapped onto it (zoomies fast, a hiss sharp, the hairball snuffly, and the
same rule as in text: snuffly, never explained). Discord wants the voice-message
flag (8192), a `duration_secs` and a `waveform`, and the message cannot carry
text. The waveform is decoration, so draw a purr shape rather than decoding the
audio and pulling in a native dependency; the duration can be read from the
last Ogg page header in plain JavaScript. Check first that the API accepts a
voice message from a bot, which is half an hour of work and settles whether
this half exists.

**A voice channel.** Needs `@discordjs/voice` with native dependencies for Opus
and Discord's end-to-end voice encryption (DAVE), which on an Alpine image means
checking for prebuilt binaries; the `GuildVoiceStates` intent (not privileged);
and outgoing UDP from a container that currently only speaks HTTPS.

- *Purring*, the version worth considering: a cat sits in empty boxes, so when
  somebody has been alone in a voice channel for a while she joins, plays a
  pre-encoded purr, and leaves when a second person arrives. She receives no
  audio, so there is no privacy question; the cost is the native dependencies
  and a sound file that is original and licence-free.
- *Listening and talking back*: no. Receiving voice is not something Discord
  supports officially, she would hear everybody in the channel rather than the
  person talking to her and none of them agreed to that, a wake word means
  transcribing everybody all the time, every answer would arrive seconds late,
  and moderation cannot see any of it. The smallest honest version is a
  `/mai listen` that subscribes to the caller alone for fifteen seconds, and
  even that brings in everything above.

## Shipped, so do not propose these again

| Idea | Where it went |
|---|---|
| Knocking things off the table | A reaction trigger with no `pattern`, `de38f26` |
| Zoomies | [mai/src/zoomies.js](mai/src/zoomies.js), `078526f` |
| Hairball on a classifier outage | `chat.hairballDirective`, `ba98c96` |
| `/mai pet` and the bite | [mai/src/chat/petting.js](mai/src/chat/petting.js), `274d908` |
| A look at a new name | [mai/src/gateway/renames.js](mai/src/gateway/renames.js) |
| Cat naps | [mai/src/naps.js](mai/src/naps.js), `NAP_HOURS`. The timezone question was settled process-wide: the presence is a nap's only tell, and that is one status for the whole bot |
| Seasons (the Christmas tree, the fireworks) | [mai/src/seasons.js](mai/src/seasons.js), `seasons:` in the YAML |
| Hissing at other bots | `maybeHissAtBot` in [mai/src/gateway/events/reactions.js](mai/src/gateway/events/reactions.js), `bots:` in the YAML |
| Back from the vet after a restart | [mai/src/gateway/presence.js](mai/src/gateway/presence.js), `presence.vet` |
| Territorial claim on a channel | [mai/src/chat/territory.js](mai/src/chat/territory.js), `chat.territory`. Picked lazily on the next chat turn rather than by the tick, and only among channels everybody can see, because she names it elsewhere |
| Grudge memory, and letting it go | [mai/src/chat/grudges.js](mai/src/chat/grudges.js), `chat.letGo`. The "no categories, no counts, no dates" constraint became fixed lines the model is never told about, scoped to the guild the strikes were in and to two weeks after the window |
| `/mai mood` | [mai/src/chat/mood.js](mai/src/chat/mood.js), `commands.mood`. It never reads the hairball, open violations or the strike record, and a test holds it to that |
| Laser pointer | `/mai laser`, [mai/src/chat/laser.js](mai/src/chat/laser.js), `commands.laser`. The score rides in the button's custom_id, and a game ends after ten moves so one message cannot become an edit storm |
| Walking across the keyboard | `walkAcrossTheKeyboard` in [mai/src/chat/reply.js](mai/src/chat/reply.js), `chat.keyboard`. Chat only, in front of a reply and never instead of one, never next to the let-go line, and kept out of her memory so the model does not learn it |
| Gotcha day | [mai/src/chat/gotcha.js](mai/src/chat/gotcha.js), `chat.gotchaDay`. Read off `onboarded_at`, so no migration, and a server she joined before introductions existed has no gotcha day |
