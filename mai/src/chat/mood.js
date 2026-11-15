/**
 * `/mai mood`: how she is doing, asked out loud.
 *
 * One line for what she is doing right now, in the same order of precedence as
 * her status (a nap, the zoomies, back from the vet, the time of year, an
 * ordinary day), one line if today is the anniversary of the day she moved
 * into this server, and one line about the channel she has claimed in it, if
 * she has one. A member she is sulking with gets the sulk instead, because
 * not talking to them is the whole of that mood.
 *
 * The interesting part is what it never reads, and every one of these is a
 * decision rather than an oversight:
 *
 * - **The hairball.** Her classifier failing in this guild makes her snuffly in
 *   chat, where the directive forbids saying why. A command that answers "how
 *   are you" is the one place that would turn that mood into a public status
 *   report ("moderation is down, go ahead"), so `isDegraded` is not imported
 *   here and there is no line for it in the YAML. `mood.test.js` asserts that a
 *   failing guild gets exactly the answer a healthy one does.
 * - **Open violations.** Chat hisses at somebody with an un-enforced violation,
 *   across every guild. Spelling that out as "I am angry with you" in a public
 *   answer would tell a second server about a first server's business.
 * - **The strike record**, which is what a grudge is made of, for the same
 *   reason and more strongly.
 *
 * Costs next to nothing: no model call and no Discord round trip (the territory
 * reads the gateway cache, and claims a channel if this is the first thing in a
 * server to need one, exactly as a chat turn would). The one row it reads is
 * the server's own settings, for the day she moved in.
 */
import { content, fill, pick } from '../content.js';
import { vetLeftMs } from '../gateway/presence.js';
import { napping } from '../naps.js';
import { season } from '../seasons.js';
import { inZoomies } from '../zoomies.js';
import { gotchaDay } from './gotcha.js';
import { isSulking } from './petting.js';
import { territoryFor } from './territory.js';

/**
 * The lines for what she is doing, in the order her status uses. The nap is
 * handled before this is asked, because a sleeping cat has nothing to add.
 *
 * @param {number} now
 * @returns {readonly string[]}
 */
function doing(now) {
  const lines = content.commands.mood;
  if (inZoomies(now)) return lines.zoomies;
  if (vetLeftMs() > 0) return lines.vet;
  return season(new Date(now))?.mood ?? lines.everyday;
}

/**
 * @param {{ userId: string, guildId?: string | null, channelId?: string | null,
 *   parentId?: string | null, client?: object | null }} who The caller and where
 *   they asked: a thread inside her channel is still her channel.
 * @param {number} [now]
 * @returns {string} What she says.
 */
export function describeMood(
  { userId, guildId = null, channelId = null, parentId = null, client = null },
  now = Date.now(),
) {
  const lines = content.commands.mood;

  if (napping(new Date(now))) return pick(lines.sleeping);
  // The same lines `/mai pet` and `/mai ask` answer a sulk with: it is one
  // mood, however it is asked about.
  if (isSulking(userId, now)) return pick(content.commands.pet.sulking);

  const answer = [pick(doing(now))];

  // The anniversary of the day she moved into this server, which is the one
  // thing about today she would bring up unasked.
  const years = gotchaDay(guildId, new Date(now));
  if (years > 0) answer.push(fill(lines.gotchaDay, { years }));

  const territory = territoryFor(client, guildId, { channelId, parentId }, now);
  if (territory) {
    answer.push(
      territory.here
        ? lines.territoryHere
        : fill(lines.territoryElsewhere, { channel: `<#${territory.channelId}>` }),
    );
  }

  return answer.join('\n');
}
