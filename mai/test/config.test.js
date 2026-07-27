/**
 * The validators in config.js, tested where they are defined rather than through
 * one caller.
 *
 * Each of them is used twice: once on the environment at startup and once on
 * whatever a moderator types into `/mod config set`. That is the reason they are
 * exported, and the reason the rules have to hold on their own: a value the
 * environment would refuse must not slip in through a slash command.
 */
import './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  config,
  isGuildAllowed,
  isOperator,
  MAX_TIMEOUT_MINUTES,
  parseCategoryList,
  parseThreshold,
  parseTimeoutLadder,
} from '../src/config.js';
import { TEST_GUILD, OTHER_GUILD, TEST_USER } from './setup.js';

test('a ladder is whole minutes, in order of appearance', () => {
  assert.deepEqual(parseTimeoutLadder('0,10,60,1440'), [0, 10, 60, 1440]);
  assert.deepEqual(parseTimeoutLadder(' 5 , 15 '), [5, 15]);
  assert.deepEqual(parseTimeoutLadder('7'), [7]);
});

test('an empty ladder is refused: a ladder with no steps is not a policy', () => {
  for (const raw of ['', '   ', ',,,', null, undefined]) {
    assert.throws(() => parseTimeoutLadder(raw), RangeError);
  }
});

test('a ladder step that is not a number at all is refused', () => {
  for (const raw of ['0,ten', 'abc', '0,,x']) {
    assert.throws(() => parseTimeoutLadder(raw), RangeError, raw);
  }
});

test('a fractional step is truncated to whole minutes, not refused', () => {
  // parseInt semantics, and the unit is minutes: "10.5" is 10 minutes, which is
  // what the error message asks for anyway.
  assert.deepEqual(parseTimeoutLadder('10.5,20'), [10, 20]);
});

test('Discord caps a timeout at 28 days, so the ladder does too', () => {
  assert.deepEqual(parseTimeoutLadder(String(MAX_TIMEOUT_MINUTES)), [MAX_TIMEOUT_MINUTES]);
  assert.throws(() => parseTimeoutLadder(`10,${MAX_TIMEOUT_MINUTES + 1}`), RangeError);
  assert.throws(() => parseTimeoutLadder('-1'), RangeError);
});

test('the label appears in the error, so the caller knows which knob was wrong', () => {
  assert.throws(() => parseTimeoutLadder('nope', 'timeout-ladder'), /timeout-ladder/);
  assert.throws(() => parseCategoryList('NOT A SLUG', 'categories'), /categories/);
  assert.throws(() => parseThreshold('2', 'threshold'), /threshold/);
});

test('categories are lowercased, trimmed and deduplicated', () => {
  assert.deepEqual(parseCategoryList('Harassment, harassment ,HATE'), ['harassment', 'hate']);
});

test('a category slug is checked for shape, not against a fixed list', () => {
  // Whatever OPENAI_BASE_URL points at decides the vocabulary, so an unknown
  // but well-formed slug has to pass.
  assert.deepEqual(parseCategoryList('violence/graphic,self-harm,some_provider_slug9'), [
    'violence/graphic',
    'self-harm',
    'some_provider_slug9',
  ]);

  for (const raw of ['has space', 'Ünicode', '-leading-dash', '/slash-first', 'semi;colon']) {
    assert.throws(() => parseCategoryList(raw), RangeError, raw);
  }
});

test('an empty category list means every category counts', () => {
  assert.deepEqual(parseCategoryList(''), []);
  assert.deepEqual(parseCategoryList(null), []);
});

test('an absurdly long category list is refused', () => {
  const many = Array.from({ length: 31 }, (_, index) => `slug${index}`).join(',');

  assert.throws(() => parseCategoryList(many), RangeError);
});

test('a threshold is a number between 0 and 1, boundaries included', () => {
  assert.equal(parseThreshold('0'), 0);
  assert.equal(parseThreshold('1'), 1);
  assert.equal(parseThreshold(0.55), 0.55);

  for (const raw of ['-0.1', '1.1', 'abc', '', null, undefined, Infinity, NaN]) {
    assert.throws(() => parseThreshold(raw), RangeError, String(raw));
  }
});

test('the allowlist is the single authority, and a DM has no guild to match', () => {
  assert.ok(config.discord.guildIds.has(TEST_GUILD));

  assert.ok(isGuildAllowed(TEST_GUILD));
  assert.ok(!isGuildAllowed(OTHER_GUILD));
  // A DM: gated by isDmAuthorInAllowedGuild instead, not here.
  assert.ok(isGuildAllowed(null));
  assert.ok(isGuildAllowed(undefined));
});

test('being an operator is not the same as being staff somewhere', () => {
  // The test environment configures nobody, which is the shipped default: the
  // cross-guild view stays off unless it is deliberately switched on.
  assert.equal(config.discord.operatorIds.size, 0);
  assert.ok(!isOperator(TEST_USER));
  assert.ok(!isOperator(null));
  assert.ok(!isOperator(undefined));
  assert.ok(!isOperator(''));
});

test('the config object cannot be edited at runtime', () => {
  assert.ok(Object.isFrozen(config));
  assert.throws(() => {
    config.moderation = {};
  }, TypeError);
});
