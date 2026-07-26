import './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { content, fill, pick } from '../src/content.js';

test('loads and validates the shipped content config', () => {
  assert.ok(content.chat.persona.includes('Mai'));
  assert.equal(content.chat.flagged.tones.length, 3);
  assert.ok(content.moderation.scoldReplies.length > 0);
  assert.ok(content.presence.statuses.length > 0);
  assert.ok(content.welcome.lines.length > 0);
});

test('compiles reaction triggers into working regexes', () => {
  const fish = content.reactions.find((trigger) => trigger.emoji === '🐟');
  assert.ok(fish, 'fish trigger exists');
  assert.equal(fish.pattern.test('hat jemand FISCH?'), true);
  assert.equal(fish.pattern.test('nur eine katze'), false);
  for (const trigger of content.reactions) {
    assert.ok(trigger.chance >= 0 && trigger.chance <= 1);
  }
});

test('fill substitutes known placeholders and leaves unknown ones visible', () => {
  assert.equal(fill('a {x} b {y}', { x: 1, y: 'zwei' }), 'a 1 b zwei');
  assert.equal(fill('{missing}', {}), '{missing}');
  assert.equal(fill('{count} und {plural}', { count: 2, plural: 'en' }), '2 und en');
});

test('fill is used by every command template that has placeholders', () => {
  const rendered = fill(content.commands.status.body, {
    queueDepth: 1,
    historyRows: 2,
    historyChannels: 3,
    lastTick: 'gerade',
    openai: 'chat x',
    uptime: '1m',
  });
  assert.equal(/\{[a-z]/i.test(rendered), false, `unsubstituted placeholder in: ${rendered}`);
});

test('pick returns a member of the list', () => {
  for (let i = 0; i < 20; i++) {
    assert.ok(content.moderation.scoldReplies.includes(pick(content.moderation.scoldReplies)));
  }
});
