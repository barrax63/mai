/**
 * The hairball: while a guild's classifier is failing, Mai is visibly under the
 * weather in her replies.
 *
 * The point of the tests is the line the feature must not cross. Moderation
 * fails open and that is deliberate, but a bot announcing "I cannot moderate
 * right now" in a public channel would be handing out an invitation, so what
 * lands in the prompt is a *mood* and the directive itself forbids explaining
 * it. Also pinned down: it is per guild (a DM is never under the weather, and
 * neither is a healthy server sharing the process with a sick one), and it is
 * added to whichever tone is in force rather than replacing it.
 */
import './setup-chat.js';
import { TEST_GUILD, OTHER_GUILD } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMessages } from '../src/ai/chat.js';
import { config } from '../src/config.js';
import { content } from '../src/content.js';
import {
  isDegraded,
  recordClassifierFailure,
  recordClassifierSuccess,
  resetClassifierHealth,
} from '../src/moderation/health.js';

const NO_VIOLATIONS = { count: 0, categories: [] };

const systemMessage = (extra = {}) =>
  buildMessages({
    history: [],
    username: 'noah',
    content: 'na Mai?',
    violations: NO_VIOLATIONS,
    ...extra,
  })[0].content;

/** Fails until the guild is announced as degraded, which is the state under test. */
const breakClassifier = (guildId) => {
  for (let i = 0; i < config.moderation.degradedAfter; i++) recordClassifierFailure(guildId);
  assert.equal(isDegraded(guildId), true);
};

test('a healthy guild says nothing about hairballs', () => {
  resetClassifierHealth();

  assert.equal(systemMessage({ guildId: TEST_GUILD }).includes(content.chat.hairballDirective), false);
});

test('a failing classifier makes her snuffly, in the guild it is failing in', () => {
  resetClassifierHealth();
  breakClassifier(TEST_GUILD);

  assert.ok(systemMessage({ guildId: TEST_GUILD }).includes(content.chat.hairballDirective));
  // One process, several servers: the other one is fine and reads as fine.
  assert.equal(
    systemMessage({ guildId: OTHER_GUILD }).includes(content.chat.hairballDirective),
    false,
  );
  // A DM has no guild, so there is nothing for it to be the symptom of.
  assert.equal(systemMessage({ guildId: null }).includes(content.chat.hairballDirective), false);
});

test('a streak too short to be announced to staff is too short to be a mood', () => {
  resetClassifierHealth();
  assert.ok(config.moderation.degradedAfter > 1, 'the test needs a threshold above one failure');

  recordClassifierFailure(TEST_GUILD);

  assert.equal(isDegraded(TEST_GUILD), false, 'one timeout is a normal afternoon');
  assert.equal(systemMessage({ guildId: TEST_GUILD }).includes(content.chat.hairballDirective), false);
});

test('she clears up again the moment the classifier answers', () => {
  resetClassifierHealth();
  breakClassifier(TEST_GUILD);
  recordClassifierSuccess(TEST_GUILD);

  assert.equal(isDegraded(TEST_GUILD), false);
  assert.equal(systemMessage({ guildId: TEST_GUILD }).includes(content.chat.hairballDirective), false);
});

test('the directive forbids saying what is wrong, which is the whole condition of shipping it', () => {
  // Not a style check: the feature is acceptable *because* it stays a mood. A
  // rewrite that drops this is a rewrite that publishes an outage to a public
  // channel, so the words have to be in the config, not only in a comment.
  const directive = content.chat.hairballDirective.toLowerCase();
  assert.ok(directive.includes('erklärst es nie'), 'she never explains it');
  for (const forbidden of ['technik', 'fehler', 'ausfäll', 'moderation']) {
    assert.ok(directive.includes(forbidden), `names ${forbidden} as off limits`);
  }
});

test('being ill is added to the tone she is in, not swapped for it', () => {
  resetClassifierHealth();
  breakClassifier(TEST_GUILD);

  const hissing = systemMessage({
    guildId: TEST_GUILD,
    violations: { count: 3, categories: ['harassment'] },
  });

  assert.ok(hissing.includes(content.chat.hairballDirective));
  assert.ok(hissing.includes(content.chat.flagged.tones.at(-1)));
  assert.ok(hissing.endsWith(content.chat.prompt.untrustedNotice));
});
