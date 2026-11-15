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
