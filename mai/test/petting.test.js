/**
 * `/mai pet` and the bite at the end of it.
 *
 * A cat's petting threshold, and the shape that makes a bot going quiet an
 * acceptable joke: it is per member, always the member's own doing, it wears
 * off on its own, and it never reaches moderation. The clock is an argument, so
 * none of this waits on a real timer.
 */
import './setup-chat.js';
import { interaction, TEST_USER } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../src/config.js';
import { content } from '../src/content.js';
import {
  ANNOYED,
  BITE,
  HAPPY,
  isSulking,
  pet,
  resetPetting,
  SULKING,
} from '../src/chat/petting.js';
import { mai as maiCommand } from '../src/commands/mai.js';

const OTHER_USER = 'user-two';
const { happyPets, patience, windowMs, biteMs } = config.petting;

/** Pets her right up to the last one she puts up with. */
const petToPatience = (userId, now) => {
  const outcomes = [];
  for (let i = 0; i < patience; i++) outcomes.push(pet(userId, now + i));
  return outcomes;
};

test('the first strokes are welcome, the next ones are a warning, the one after bites', () => {
  resetPetting();
  const now = Date.now();

  const tolerated = petToPatience(TEST_USER, now);

  assert.deepEqual(tolerated.slice(0, happyPets), Array(happyPets).fill(HAPPY));
  assert.deepEqual(tolerated.slice(happyPets), Array(patience - happyPets).fill(ANNOYED));
  assert.equal(pet(TEST_USER, now + patience), BITE);
});

test('after biting she sulks, and gets over it on her own', () => {
  resetPetting();
  const now = Date.now();

  petToPatience(TEST_USER, now);
  assert.equal(isSulking(TEST_USER, now), false, 'not before the bite');

  assert.equal(pet(TEST_USER, now), BITE);
  assert.equal(isSulking(TEST_USER, now), true);
  assert.equal(pet(TEST_USER, now + 1), SULKING, 'petting her now gets nowhere');
  assert.equal(isSulking(TEST_USER, now + biteMs - 1), true);
  assert.equal(isSulking(TEST_USER, now + biteMs), false, 'over it');
});

test('the sulk ends without leaving her one pet away from the next bite', () => {
  resetPetting();
  const now = Date.now();

  petToPatience(TEST_USER, now);
  assert.equal(pet(TEST_USER, now), BITE);

  // Sulk over: the counter has to start again, or the first stroke afterwards
  // would bite and the sulk would effectively never end.
  assert.equal(pet(TEST_USER, now + biteMs), HAPPY);
});

test('being petted is forgotten between visits', () => {
  const now = Date.now();
  // The window runs from the last stroke rather than the first, so both cases
  // are measured from there.
  const last = () => now + patience - 1;

  resetPetting();
  petToPatience(TEST_USER, now);
  assert.equal(pet(TEST_USER, last() + windowMs), BITE, 'still one visit');

  resetPetting();
  petToPatience(TEST_USER, now);
  // Somebody coming back later is starting over, not carrying on from four
  // strokes ago.
  assert.equal(pet(TEST_USER, last() + windowMs + 1), HAPPY);
});

test('she sulks with the person who did it, and nobody else', () => {
  resetPetting();
  const now = Date.now();

  petToPatience(TEST_USER, now);
  assert.equal(pet(TEST_USER, now), BITE);

  assert.equal(isSulking(TEST_USER, now), true);
  assert.equal(isSulking(OTHER_USER, now), false);
  assert.equal(pet(OTHER_USER, now), HAPPY);
});

test('an unknown member is not being sulked with', () => {
  resetPetting();

  assert.equal(isSulking('nobody-has-petted-her'), false);
});

test('the command answers with a configured line and never invents one', async () => {
  resetPetting();

  const petting = interaction({ data: { name: 'mai', options: [{ name: 'pet', type: 1 }] } });
  const lines = [];
  for (let i = 0; i <= patience + 1; i++) {
    lines.push((await maiCommand.execute(petting)).data.content);
  }

  const configured = [
    ...content.commands.pet.happy,
    ...content.commands.pet.annoyed,
    ...content.commands.pet.bite,
    ...content.commands.pet.sulking,
  ];
  for (const line of lines) assert.ok(configured.includes(line), line);
  assert.ok(content.commands.pet.bite.includes(lines[patience]), 'the bite lands where it should');
  assert.ok(content.commands.pet.sulking.includes(lines[patience + 1]), 'and then she sulks');
});

test('petting is answered immediately: no defer, no model call, no network', () => {
  const petting = interaction({ data: { name: 'mai', options: [{ name: 'pet', type: 1 }] } });

  assert.equal(maiCommand.deferred(petting), false);
});

test('a member she is sulking with gets nothing out of /mai ask either', async () => {
  resetPetting();
  const now = Date.now();
  petToPatience(TEST_USER, now);
  assert.equal(pet(TEST_USER, now), BITE);

  const asking = interaction({
    data: {
      name: 'mai',
      options: [{ name: 'ask', type: 1, options: [{ name: 'frage', value: 'bitte?' }] }],
    },
  });

  const response = await maiCommand.execute(asking);

  assert.ok(content.commands.pet.sulking.includes(response.data.content));
});
