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
  decimalNumber,
  isGuildAllowed,
  isOperator,
  MAX_TIMEOUT_MINUTES,
  parseCategoryList,
  parseThreshold,
  parseTimeoutLadder,
  wholeNumber,
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

test('a step that only starts like a number is refused, not read up to the typo', () => {
  // Every one of these parses as a plausible number if the digits are read off
  // the front, which is how a typo becomes policy instead of an error message.
  for (const raw of ['1O', '10min', '10.5', '1 0', '0x10', '1e3', '١٠']) {
    assert.throws(() => parseTimeoutLadder(`0,${raw}`), RangeError, raw);
  }
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
  assert.equal(parseThreshold('.5'), 0.5);
  // Exponent notation stays readable as a number, and an existing .env may
  // already hold one.
  assert.equal(parseThreshold('5e-1'), 0.5);

  for (const raw of ['-0.1', '1.1', 'abc', '', null, undefined, Infinity, NaN]) {
    assert.throws(() => parseThreshold(raw), RangeError, String(raw));
  }
});

test('a threshold that only starts like a number is refused too', () => {
  // '0,7' is the German decimal comma, which is exactly the typo this knob
  // invites: it used to parse as 0 and switch the threshold off silently.
  for (const raw of ['0.7abc', '0,7', '. 5', '0.5.1']) {
    assert.throws(() => parseThreshold(raw), RangeError, raw);
  }
});

test('the whole-number check is the one both surfaces share', () => {
  assert.equal(wholeNumber('42'), 42);
  assert.equal(wholeNumber(' 42 '), 42);
  assert.equal(wholeNumber('-42'), -42, 'the sign passes, so the range check can explain itself');
  assert.equal(wholeNumber(7), 7);

  for (const raw of ['4 2', '42abc', '4.2', '', '  ', null, undefined, {}, '0b1']) {
    assert.ok(Number.isNaN(wholeNumber(raw)), String(raw));
  }
});

test('the decimal check accepts what a ratio needs and nothing else', () => {
  assert.equal(decimalNumber('0.5'), 0.5);
  assert.equal(decimalNumber('2.'), 2);
  assert.equal(decimalNumber('-1.25e2'), -125);

  for (const raw of ['0,5', '1/2', 'NaN', 'Infinity', '', null, '1.2.3']) {
    assert.ok(Number.isNaN(decimalNumber(raw)), String(raw));
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
