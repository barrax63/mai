/**
 * The two ways a failure is described for somewhere permanent and readable:
 * `describeError` for the operator's alert channel, `explainError` for a guild's
 * moderation log.
 *
 * The property under test is the same for both: **never `error.message`**. An
 * exception message is free text that can quote a channel name, a config value
 * or a request body, and both destinations are Discord channels anyone with
 * access can scroll back through.
 */
import './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { content, fill } from '../src/content.js';
import { describeError, explainError } from '../src/errors.js';

/** A message no output may ever contain, in any of the cases below. */
const SECRET = 'token=abcdef in #general said by tester';

test('a thrown non-object has no name to report and no message to leak', () => {
  for (const value of [null, undefined, 'a string error', 42, Symbol('x')]) {
    assert.equal(describeError(value), 'Error');
    assert.equal(explainError(value), 'Error');
  }
});

test('the name is reported, the message never is', () => {
  const error = new TypeError(SECRET);

  assert.equal(describeError(error), 'TypeError');
  assert.doesNotMatch(describeError(error), /token=/);
});

test('status and code ride along, in that order', () => {
  const error = Object.assign(new Error(SECRET), { name: 'OpenAiError', status: 429, code: 'http_error' });

  assert.equal(describeError(error), 'OpenAiError status=429 code=http_error');
});

test('a plain object falls back to its constructor name', () => {
  assert.equal(describeError({}), 'Object');
  assert.equal(describeError({ code: 50013 }), 'Object code=50013');
  assert.equal(describeError(Object.create(null)), 'Error');
});

test('an absurd code is truncated instead of becoming the whole entry', () => {
  const error = { name: 'DiscordAPIError', code: 'x'.repeat(500) };
  const described = describeError(error);

  assert.ok(described.length < 100, described);
  assert.ok(described.endsWith('…'), described);
});

test('a multi-line code is collapsed, so it cannot forge lines in an embed', () => {
  assert.equal(describeError({ name: 'Error', code: 'a\n\nb  c' }), 'Error code=a b c');
});

test('a code of 0 is a code, not a missing one', () => {
  assert.equal(describeError({ name: 'Error', status: 0, code: 0 }), 'Error status=0 code=0');
});

test('a mapped Discord code becomes a sentence staff can act on', () => {
  const error = Object.assign(new Error(SECRET), { name: 'DiscordAPIError', code: 50013 });
  const explained = explainError(error);

  assert.equal(
    explained,
    fill(content.moderation.errorLine, { reason: content.moderation.errors['50013'], code: '50013' }),
  );
  assert.ok(explained.includes('50013'), 'the code stays, staff hand it to the operator');
  assert.doesNotMatch(explained, /token=/);
});

test('the one code Mai mints herself is mapped too', () => {
  const explained = explainError({ name: 'Error', code: 'not_text_channel' });

  assert.ok(explained.includes(content.moderation.errors.not_text_channel));
});

test('an unmapped code degrades to the name and the code, never the message', () => {
  const error = Object.assign(new Error(SECRET), { name: 'DiscordAPIError', code: 99999 });

  assert.equal(explainError(error), 'DiscordAPIError code=99999');
});

test('an error without a code is described, not explained', () => {
  assert.equal(explainError(new RangeError(SECRET)), 'RangeError');
});

test('a code inherited from Object.prototype is not a mapped code', () => {
  for (const code of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    const explained = explainError({ name: 'DiscordAPIError', code });

    assert.equal(explained, `DiscordAPIError code=${code}`);
    assert.doesNotMatch(explained, /function|\[object/i);
  }
});

test('every mapped code renders through the configured line', () => {
  for (const [code, reason] of Object.entries(content.moderation.errors)) {
    const explained = explainError({ name: 'DiscordAPIError', code });

    assert.equal(explained, fill(content.moderation.errorLine, { reason, code }));
  }
});
