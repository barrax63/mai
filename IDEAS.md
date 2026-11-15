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

### Territorial claim on a channel

She sits in one channel for a day, the way a cat occupies a box. While claimed,
her replies there carry a smug directive, and she mentions it when talking
elsewhere.

Seam: a claimed channel id plus an expiry in memory, rotated by the tick, and
one more directive in `buildMessages` (which now takes `guildId`, so it can
reach a per-guild fact).

Constraints: it must be a *tone*, not a restriction. She keeps answering
everywhere, the claim never gates a reply, and the claimed channel is picked
from channels she can already speak in, skipping exempt ones. Picking the most
active channel means counting messages per channel, which is a per-channel
activity record and exactly the kind of thing `/metrics` is forbidden from
labelling by channel; a random eligible channel avoids that question entirely
and is almost as funny.

### Grudge memory, and letting it go

She already reads the *queue* for her tone, so enforcement makes her friendly
again immediately. The record is longer: `violations` keeps strikes for
`VIOLATION_RETENTION_DAYS`. The idea is that when somebody's last strike ages
out of the window cleanly, the next time they talk to her she says one line
about it, unprompted, and is done with it.

Seam: `strikeCount(guildId, userId, sinceIso)` and `totalsFor` already exist, so
nothing new in SQL. Needs a once-only flag per member in memory, or she repeats
the line every turn.

Constraints: it is the one idea here that has Mai *mention* somebody's record in
a channel, and a strike is metadata about an enforcement that already happened,
so the line must say she is over it without saying what it was: no categories,
no counts, no dates. Careful with the trigger too, because "their last strike
aged out" is a fact about a clock rather than an event, so it is read on the next
turn and not announced into a channel nobody is reading.

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
