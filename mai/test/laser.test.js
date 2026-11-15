/**
 * `/mai laser`: a red dot, one button, and a cat that mostly misses.
 *
 * The game has no server side: the score rides in the button's custom_id. So
 * the first things pinned down are the ones that keep that honest: a real
 * button's id moves the game on, an id no button of hers could carry is
 * refused, and after the last move there is no button left to click. Then the
 * persona around it: she does not wake up for it, she does not play with a
 * member she is sulking with, and it calls nothing.
 */
import { interaction, openTestDatabase, stubFetch, TEST_USER } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { InteractionResponseType } from 'discord-interactions';
import { laserId, moveDot, parseScore } from '../src/chat/laser.js';
import { BITE, pet, resetPetting } from '../src/chat/petting.js';
import { laserComponents, mai as maiCommand } from '../src/commands/mai.js';
import { config } from '../src/config.js';
import { content, fill } from '../src/content.js';
import { EPHEMERAL } from '../src/interactions/respond.js';
import { componentHandlers, parseCustomId } from '../src/interactions/registry.js';

await openTestDatabase();

const lines = content.commands.laser;
const MAX = config.laser.maxMoves;

const starting = () => interaction({ data: { name: 'mai', options: [{ name: 'laser', type: 1 }] } });

/** A click on the button whose custom_id is `customId`, by `userId`. */
const click = (customId, userId = TEST_USER) =>
  interaction({
    member: { user: { id: userId, username: 'player' }, permissions: '0' },
    data: { custom_id: customId, component_type: 2 },
    message: { id: 'laser-message' },
  });

/** Routes a click the way the router does: name from the id, the rest as args. */
function press(customId, { roll, userId } = {}) {
  const { name, args } = parseCustomId(customId);
  const realRandom = Math.random;
  if (roll !== undefined) Math.random = () => roll;
  try {
    return componentHandlers.get(name)(click(customId, userId), args);
  } finally {
    Math.random = realRandom;
  }
}

const buttonOf = (response) => response.data.components?.[0]?.components?.[0];

test('the dot goes down in public, with one button and no score yet', () => {
  resetPetting();
  const response = maiCommand.execute(starting());

  assert.equal(maiCommand.deferred(starting()), false);
  assert.equal(response.type, InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
  assert.equal((response.data.flags ?? 0) & EPHEMERAL, 0, 'public');
  assert.ok(lines.start.includes(response.data.content), response.data.content);
  assert.equal(buttonOf(response).custom_id, 'laser:0:0');
  assert.equal(buttonOf(response).label, lines.button);
  assert.equal(componentHandlers.get('laser'), laserComponents.laser, 'registered');
});

test('every click is a pounce: a roll under the chance lands, anything else misses', () => {
  resetPetting();
  assert.ok(lines.chance > 0 && lines.chance < 1, 'the shipped chance can go either way');

  const landed = press('laser:0:0', { roll: 0 });
  assert.equal(landed.type, InteractionResponseType.UPDATE_MESSAGE, 'the game message itself');
  const [line, score] = landed.data.content.split('\n');
  assert.ok(lines.caught.includes(line), line);
  assert.equal(score, fill(lines.score, { caught: 1, tries: 1 }));
  assert.equal(buttonOf(landed).custom_id, 'laser:1:1');

  const missed = press('laser:1:1', { roll: 0.999 });
  assert.ok(lines.missed.includes(missed.data.content.split('\n')[0]));
  assert.equal(buttonOf(missed).custom_id, 'laser:1:2');
});

test('anybody can move the dot, not only whoever put it down', () => {
  resetPetting();
  const response = press('laser:0:3', { roll: 0.999, userId: 'somebody-else' });

  assert.equal(response.type, InteractionResponseType.UPDATE_MESSAGE);
  assert.equal(buttonOf(response).custom_id, 'laser:0:4');
});

test('after the last move she loses interest and the button is gone', () => {
  resetPetting();
  const response = press(laserId({ caught: 2, tries: MAX - 1 }), { roll: 0 });

  const [line, done] = response.data.content.split('\n');
  assert.ok(lines.caught.includes(line), line);
  assert.equal(done, fill(lines.done, { caught: 3, tries: MAX }));
  assert.deepEqual(response.data.components, [], 'nothing left to click');
});

test('an id no button of hers could carry is refused, so a forged one cannot play forever', () => {
  resetPetting();
  const refused = [
    'laser',
    'laser:1',
    'laser:x:1',
    'laser:-1:2',
    'laser:0.5:1',
    'laser:1e1:20',
    'laser: 1:2',
    'laser:3:2', // more caught than tried
    `laser:0:${MAX}`, // already over
    `laser:0:${MAX + 5}`,
    'laser:0:1:2',
    'laser:0001:0002',
  ];

  for (const customId of refused) {
    const response = press(customId, { roll: 0 });
    assert.equal(response.type, InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, customId);
    assert.equal(response.data.flags, EPHEMERAL, customId);
    assert.equal(response.data.content, content.commands.expired, customId);
  }
});

test('the score is arithmetic on the id and nothing else', () => {
  assert.deepEqual(parseScore(['0', '0']), { caught: 0, tries: 0 });
  assert.deepEqual(parseScore(['4', String(MAX - 1)]), { caught: 4, tries: MAX - 1 });
  assert.equal(parseScore(undefined), null);

  assert.deepEqual(moveDot({ caught: 0, tries: 0 }, 0), { caught: 1, tries: 1, hit: true, over: false });
  assert.deepEqual(moveDot({ caught: 0, tries: 0 }, lines.chance), {
    caught: 0,
    tries: 1,
    hit: false,
    over: false,
  });
  assert.equal(moveDot({ caught: 0, tries: MAX - 1 }, 0.999).over, true);
});

test('a member she is sulking with gets the sulk, privately, and the game stays put', () => {
  resetPetting();
  const now = Date.now();
  let outcome;
  for (let i = 0; i <= config.petting.patience; i++) outcome = pet(TEST_USER, now);
  assert.equal(outcome, BITE);

  const started = maiCommand.execute(starting());
  assert.ok(content.commands.pet.sulking.includes(started.data.content));
  assert.equal(started.data.components, undefined, 'no game with them');

  const clicked = press('laser:1:2', { roll: 0 });
  assert.equal(clicked.type, InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, 'not an edit');
  assert.equal(clicked.data.flags, EPHEMERAL);
  assert.ok(content.commands.pet.sulking.includes(clicked.data.content));

  // Everybody else plays on.
  assert.equal(buttonOf(press('laser:1:2', { roll: 0, userId: 'somebody-else' })).custom_id, 'laser:2:3');
  resetPetting();
});

test('a laser game calls nothing: no model, no classifier, no Discord', () => {
  resetPetting();
  const fetched = [];
  const restore = stubFetch((url) => {
    fetched.push(url);
    throw new Error('nothing should be fetched');
  });

  try {
    maiCommand.execute(starting());
    for (let tries = 0; tries < MAX; tries++) press(laserId({ caught: 0, tries }), { roll: 0.5 });
  } finally {
    restore();
  }

  assert.deepEqual(fetched, []);
});

test('the score lines cannot lose the score', () => {
  for (const template of [lines.score, lines.done]) {
    assert.ok(template.includes('{caught}') && template.includes('{tries}'), template);
  }
  assert.ok(lines.button.length <= 80, 'Discord refuses a longer label');
  // Every id a game can produce fits Discord's 100-character custom_id limit.
  assert.ok(laserId({ caught: MAX, tries: MAX }).length <= 100);
});
