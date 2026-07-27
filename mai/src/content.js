/**
 * Loads Mai's content configuration (persona, prompts, scold lines, welcome
 * messages, reaction triggers, presence statuses) from the YAML file at
 * `MAI_CONFIG_PATH` and validates it once at startup.
 *
 * Split of responsibilities: `config.js` = operational knobs and secrets from
 * the environment, this module = everything user-facing. No handler should
 * contain a literal string Mai says.
 */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { config } from './config.js';

const fail = (message) => {
  throw new Error(`Content config (${config.content.path}): ${message}`);
};

const str = (node, path) => {
  const value = node?.[path.at(-1)];
  if (typeof value !== 'string' || !value.trim()) {
    fail(`${path.join('.')} must be a non-empty string`);
  }
  return value;
};

const num = (node, path, { min, max } = {}) => {
  const value = node?.[path.at(-1)];
  if (typeof value !== 'number' || Number.isNaN(value)) {
    fail(`${path.join('.')} must be a number`);
  }
  if (min !== undefined && value < min) fail(`${path.join('.')} must be >= ${min}`);
  if (max !== undefined && value > max) fail(`${path.join('.')} must be <= ${max}`);
  return value;
};

const strings = (node, path, { min = 1 } = {}) => {
  const value = node?.[path.at(-1)];
  if (!Array.isArray(value) || value.length < min) {
    fail(`${path.join('.')} must be an array of at least ${min} string(s)`);
  }
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string' || !entry.trim()) {
      fail(`${path.join('.')}[${index}] must be a non-empty string`);
    }
  }
  return value;
};

const section = (root, name) => {
  const value = root?.[name];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`section "${name}" is missing`);
  }
  return value;
};

function loadContent() {
  let raw;
  try {
    raw = readFileSync(config.content.path, 'utf8');
  } catch (error) {
    fail(`cannot be read (${error.code ?? error.message})`);
  }

  let parsed;
  try {
    parsed = parse(raw);
  } catch (error) {
    fail(`is not valid YAML: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object') fail('is empty');

  const chat = section(parsed, 'chat');
  const flagged = section(chat, 'flagged');
  const prompt = section(chat, 'prompt');
  const moderation = section(parsed, 'moderation');
  const warningDm = section(moderation, 'warningDm');
  const log = section(moderation, 'log');
  const logTitles = section(log, 'titles');
  const logFields = section(log, 'fields');
  const appeal = section(moderation, 'appeal');
  const commands = section(parsed, 'commands');
  const ask = section(commands, 'ask');
  const forget = section(commands, 'forget');
  const status = section(commands, 'status');
  const forgive = section(commands, 'forgive');
  const configSection = section(commands, 'config');
  const reportSection = section(commands, 'report');
  const exemptSection = section(commands, 'exempt');
  const spend = section(commands, 'spend');
  const history = section(commands, 'history');
  const historyActions = section(history, 'actions');
  const power = section(commands, 'power');
  const welcome = section(parsed, 'welcome');
  const presence = section(parsed, 'presence');

  const reactions = parsed.reactions;
  if (!Array.isArray(reactions)) fail('section "reactions" must be an array');

  return Object.freeze({
    chat: Object.freeze({
      persona: str(chat, ['chat', 'persona']).trim(),
      friendlyDirective: str(chat, ['chat', 'friendlyDirective']),
      fallbackReply: str(chat, ['chat', 'fallbackReply']),
      busyEmoji: str(chat, ['chat', 'busyEmoji']),
      flagged: Object.freeze({
        header: str(flagged, ['chat', 'flagged', 'header']),
        footer: str(flagged, ['chat', 'flagged', 'footer']),
        unknownCategory: str(flagged, ['chat', 'flagged', 'unknownCategory']),
        tones: Object.freeze(strings(flagged, ['chat', 'flagged', 'tones'])),
      }),
      prompt: Object.freeze({
        emptyMessagePlaceholder: str(prompt, ['chat', 'prompt', 'emptyMessagePlaceholder']),
        imagePlaceholder: str(prompt, ['chat', 'prompt', 'imagePlaceholder']),
        replyContext: str(prompt, ['chat', 'prompt', 'replyContext']),
        threadContext: str(prompt, ['chat', 'prompt', 'threadContext']),
        assistantLabel: str(prompt, ['chat', 'prompt', 'assistantLabel']),
        unknownUserLabel: str(prompt, ['chat', 'prompt', 'unknownUserLabel']),
        // Appended to the system message: only that turn carries instructions.
        untrustedNotice: str(prompt, ['chat', 'prompt', 'untrustedNotice']),
      }),
    }),
    moderation: Object.freeze({
      warningEmoji: str(moderation, ['moderation', 'warningEmoji']),
      timeoutImmune: str(moderation, ['moderation', 'timeoutImmune']),
      // Empty timezone = follow the container clock (TZ).
      timezone: typeof moderation.timezone === 'string' && moderation.timezone.trim()
        ? moderation.timezone.trim()
        : config.timezone,
      scoldPrefix: typeof moderation.scoldPrefix === 'string' ? moderation.scoldPrefix : '',
      scoldReplies: Object.freeze(strings(moderation, ['moderation', 'scoldReplies'])),
      log: Object.freeze({
        titles: Object.freeze({
          flagged: str(logTitles, ['moderation', 'log', 'titles', 'flagged']),
          deleted: str(logTitles, ['moderation', 'log', 'titles', 'deleted']),
          selfDeleted: str(logTitles, ['moderation', 'log', 'titles', 'selfDeleted']),
          cleared: str(logTitles, ['moderation', 'log', 'titles', 'cleared']),
          forgiven: str(logTitles, ['moderation', 'log', 'titles', 'forgiven']),
          reported: str(logTitles, ['moderation', 'log', 'titles', 'reported']),
          appealed: str(logTitles, ['moderation', 'log', 'titles', 'appealed']),
          stuck: str(logTitles, ['moderation', 'log', 'titles', 'stuck']),
          abandoned: str(logTitles, ['moderation', 'log', 'titles', 'abandoned']),
          timeout: str(logTitles, ['moderation', 'log', 'titles', 'timeout']),
          timeoutFailed: str(logTitles, ['moderation', 'log', 'titles', 'timeoutFailed']),
          config: str(logTitles, ['moderation', 'log', 'titles', 'config']),
          appealGranted: str(logTitles, ['moderation', 'log', 'titles', 'appealGranted']),
          appealDenied: str(logTitles, ['moderation', 'log', 'titles', 'appealDenied']),
        }),
        fields: Object.freeze({
          user: str(logFields, ['moderation', 'log', 'fields', 'user']),
          channel: str(logFields, ['moderation', 'log', 'fields', 'channel']),
          categories: str(logFields, ['moderation', 'log', 'fields', 'categories']),
          due: str(logFields, ['moderation', 'log', 'fields', 'due']),
          message: str(logFields, ['moderation', 'log', 'fields', 'message']),
          actor: str(logFields, ['moderation', 'log', 'fields', 'actor']),
          count: str(logFields, ['moderation', 'log', 'fields', 'count']),
          reporter: str(logFields, ['moderation', 'log', 'fields', 'reporter']),
          reason: str(logFields, ['moderation', 'log', 'fields', 'reason']),
          attempts: str(logFields, ['moderation', 'log', 'fields', 'attempts']),
          strikes: str(logFields, ['moderation', 'log', 'fields', 'strikes']),
          duration: str(logFields, ['moderation', 'log', 'fields', 'duration']),
          until: str(logFields, ['moderation', 'log', 'fields', 'until']),
          resolution: str(logFields, ['moderation', 'log', 'fields', 'resolution']),
          appeal: str(logFields, ['moderation', 'log', 'fields', 'appeal']),
          changes: str(logFields, ['moderation', 'log', 'fields', 'changes']),
          incident: str(logFields, ['moderation', 'log', 'fields', 'incident']),
        }),
        jump: str(log, ['moderation', 'log', 'jump']),
        none: str(log, ['moderation', 'log', 'none']),
      }),
      appeal: Object.freeze({
        button: str(appeal, ['moderation', 'appeal', 'button']),
        modalTitle: str(appeal, ['moderation', 'appeal', 'modalTitle']),
        inputLabel: str(appeal, ['moderation', 'appeal', 'inputLabel']),
        inputPlaceholder: str(appeal, ['moderation', 'appeal', 'inputPlaceholder']),
        submitted: str(appeal, ['moderation', 'appeal', 'submitted']),
        empty: str(appeal, ['moderation', 'appeal', 'empty']),
        busy: str(appeal, ['moderation', 'appeal', 'busy']),
        failed: str(appeal, ['moderation', 'appeal', 'failed']),
        // The staff decision, and what the member is told about it.
        grantButton: str(appeal, ['moderation', 'appeal', 'grantButton']),
        denyButton: str(appeal, ['moderation', 'appeal', 'denyButton']),
        granted: str(appeal, ['moderation', 'appeal', 'granted']),
        denied: str(appeal, ['moderation', 'appeal', 'denied']),
        grantedDm: str(appeal, ['moderation', 'appeal', 'grantedDm']),
        deniedDm: str(appeal, ['moderation', 'appeal', 'deniedDm']),
        decisionSent: str(appeal, ['moderation', 'appeal', 'decisionSent']),
        decisionNotSent: str(appeal, ['moderation', 'appeal', 'decisionNotSent']),
        strikesOverturned: str(appeal, ['moderation', 'appeal', 'strikesOverturned']),
      }),
      warningDm: Object.freeze({
        maxLength: num(warningDm, ['moderation', 'warningDm', 'maxLength'], { min: 100, max: 2000 }),
        maxContentChars: num(warningDm, ['moderation', 'warningDm', 'maxContentChars'], { min: 1 }),
        locale: str(warningDm, ['moderation', 'warningDm', 'locale']),
        title: str(warningDm, ['moderation', 'warningDm', 'title']),
        intro: str(warningDm, ['moderation', 'warningDm', 'intro']),
        categoryLabel: str(warningDm, ['moderation', 'warningDm', 'categoryLabel']),
        unknownCategory: str(warningDm, ['moderation', 'warningDm', 'unknownCategory']),
        messagesLabel: str(warningDm, ['moderation', 'warningDm', 'messagesLabel']),
        emptyMessage: str(warningDm, ['moderation', 'warningDm', 'emptyMessage']),
        attachmentMessage: str(warningDm, ['moderation', 'warningDm', 'attachmentMessage']),
        unknownTimestamp: str(warningDm, ['moderation', 'warningDm', 'unknownTimestamp']),
        omittedLine: str(warningDm, ['moderation', 'warningDm', 'omittedLine']),
        timeoutNote: str(warningDm, ['moderation', 'warningDm', 'timeoutNote']),
        footer: str(warningDm, ['moderation', 'warningDm', 'footer']),
      }),
    }),
    commands: Object.freeze({
      forbidden: str(commands, ['commands', 'forbidden']),
      notActive: str(commands, ['commands', 'notActive']),
      paused: str(commands, ['commands', 'paused']),
      error: str(commands, ['commands', 'error']),
      expired: str(commands, ['commands', 'expired']),
      ask: Object.freeze({
        answer: str(ask, ['commands', 'ask', 'answer']),
        busy: str(ask, ['commands', 'ask', 'busy']),
        empty: str(ask, ['commands', 'ask', 'empty']),
        disabled: str(ask, ['commands', 'ask', 'disabled']),
        // The question itself was flagged, so Mai will not repeat it.
        refused: str(ask, ['commands', 'ask', 'refused']),
      }),
      forget: Object.freeze({
        confirm: str(forget, ['commands', 'forget', 'confirm']),
        confirmButton: str(forget, ['commands', 'forget', 'confirmButton']),
        cancelButton: str(forget, ['commands', 'forget', 'cancelButton']),
        done: str(forget, ['commands', 'forget', 'done']),
        cancelled: str(forget, ['commands', 'forget', 'cancelled']),
      }),
      status: Object.freeze({
        body: str(status, ['commands', 'status', 'body']),
        never: str(status, ['commands', 'status', 'never']),
        // Marks a view whose counters span every guild (operators only).
        allGuilds: str(status, ['commands', 'status', 'allGuilds']),
      }),
      forgive: Object.freeze({
        done: str(forgive, ['commands', 'forgive', 'done']),
        nothing: str(forgive, ['commands', 'forgive', 'nothing']),
        strikesCleared: str(forgive, ['commands', 'forgive', 'strikesCleared']),
      }),
      history: Object.freeze({
        body: str(history, ['commands', 'history', 'body']),
        line: str(history, ['commands', 'history', 'line']),
        actions: Object.freeze({
          deleted: str(historyActions, ['commands', 'history', 'actions', 'deleted']),
          self_deleted: str(historyActions, ['commands', 'history', 'actions', 'self_deleted']),
          edited: str(historyActions, ['commands', 'history', 'actions', 'edited']),
          overturned: str(historyActions, ['commands', 'history', 'actions', 'overturned']),
        }),
        nextTimeout: str(history, ['commands', 'history', 'nextTimeout']),
        nextNothing: str(history, ['commands', 'history', 'nextNothing']),
        nextDisabled: str(history, ['commands', 'history', 'nextDisabled']),
        empty: str(history, ['commands', 'history', 'empty']),
      }),
      spend: Object.freeze({
        body: str(spend, ['commands', 'spend', 'body']),
        line: str(spend, ['commands', 'spend', 'line']),
        budgetOff: str(spend, ['commands', 'spend', 'budgetOff']),
        // Shown instead of the figures when the caller is not an operator.
        budgetHidden: str(spend, ['commands', 'spend', 'budgetHidden']),
        budgetExceededShared: str(spend, ['commands', 'spend', 'budgetExceededShared']),
        budgetOk: str(spend, ['commands', 'spend', 'budgetOk']),
        budgetExceeded: str(spend, ['commands', 'spend', 'budgetExceeded']),
        nothing: str(spend, ['commands', 'spend', 'nothing']),
      }),
      report: Object.freeze({
        modalTitle: str(reportSection, ['commands', 'report', 'modalTitle']),
        reasonLabel: str(reportSection, ['commands', 'report', 'reasonLabel']),
        reasonPlaceholder: str(reportSection, ['commands', 'report', 'reasonPlaceholder']),
        thanks: str(reportSection, ['commands', 'report', 'thanks']),
        approveButton: str(reportSection, ['commands', 'report', 'approveButton']),
        dismissButton: str(reportSection, ['commands', 'report', 'dismissButton']),
        titleApproved: str(reportSection, ['commands', 'report', 'titleApproved']),
        titleDismissed: str(reportSection, ['commands', 'report', 'titleDismissed']),
        approved: str(reportSection, ['commands', 'report', 'approved']),
        approvedFailed: str(reportSection, ['commands', 'report', 'approvedFailed']),
        dismissed: str(reportSection, ['commands', 'report', 'dismissed']),
        guildOnly: str(reportSection, ['commands', 'report', 'guildOnly']),
        unavailable: str(reportSection, ['commands', 'report', 'unavailable']),
        busy: str(reportSection, ['commands', 'report', 'busy']),
        failed: str(reportSection, ['commands', 'report', 'failed']),
      }),
      power: Object.freeze({
        on: str(power, ['commands', 'power', 'on']),
        onAlready: str(power, ['commands', 'power', 'onAlready']),
        off: str(power, ['commands', 'power', 'off']),
        offAlready: str(power, ['commands', 'power', 'offAlready']),
        guildOnly: str(power, ['commands', 'power', 'guildOnly']),
      }),
      config: Object.freeze({
        body: str(configSection, ['commands', 'config', 'body']),
        inherited: str(configSection, ['commands', 'config', 'inherited']),
        on: str(configSection, ['commands', 'config', 'on']),
        off: str(configSection, ['commands', 'config', 'off']),
        unset: str(configSection, ['commands', 'config', 'unset']),
        systemChannel: str(configSection, ['commands', 'config', 'systemChannel']),
        thresholdOff: str(configSection, ['commands', 'config', 'thresholdOff']),
        allCategories: str(configSection, ['commands', 'config', 'allCategories']),
        noExemptChannels: str(configSection, ['commands', 'config', 'noExemptChannels']),
        nothing: str(configSection, ['commands', 'config', 'nothing']),
        invalid: str(configSection, ['commands', 'config', 'invalid']),
        guildOnly: str(configSection, ['commands', 'config', 'guildOnly']),
      }),
      exempt: Object.freeze({
        added: str(exemptSection, ['commands', 'exempt', 'added']),
        alreadyAdded: str(exemptSection, ['commands', 'exempt', 'alreadyAdded']),
        removed: str(exemptSection, ['commands', 'exempt', 'removed']),
        notExempt: str(exemptSection, ['commands', 'exempt', 'notExempt']),
        body: str(exemptSection, ['commands', 'exempt', 'body']),
        line: str(exemptSection, ['commands', 'exempt', 'line']),
        empty: str(exemptSection, ['commands', 'exempt', 'empty']),
        limit: str(exemptSection, ['commands', 'exempt', 'limit']),
      }),
    }),
    welcome: Object.freeze({
      lines: Object.freeze(strings(welcome, ['welcome', 'lines'])),
    }),
    reactions: Object.freeze(
      reactions.map((trigger, index) => {
        const path = ['reactions', String(index)];
        const emoji = str(trigger, [...path, 'emoji']);
        const chance = num(trigger, [...path, 'chance'], { min: 0, max: 1 });
        const source = str(trigger, [...path, 'pattern']);
        // `g` and `y` are stripped on purpose: the trigger is used with
        // `.test()`, and either flag makes that stateful through `lastIndex`:
        // the same message would match, then not match, then match again. A
        // reaction rule that fires every other time is a bug nobody would look
        // for in a YAML file.
        const flags = (typeof trigger.flags === 'string' ? trigger.flags : '').replace(/[gy]/g, '');
        let pattern;
        try {
          pattern = new RegExp(source, flags);
        } catch (error) {
          fail(`reactions[${index}].pattern is not a valid regular expression: ${error.message}`);
        }
        return Object.freeze({ emoji, chance, pattern });
      }),
    ),
    presence: Object.freeze({
      statuses: Object.freeze(strings(presence, ['presence', 'statuses'])),
    }),
  });
}

export const content = loadContent();

/**
 * Substitutes {name} placeholders. Unknown placeholders are left untouched so a
 * typo in the config shows up in the output instead of silently vanishing.
 *
 * @param {string} template
 * @param {Record<string, string | number>} values
 * @returns {string}
 */
export function fill(template, values = {}) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) =>
    Object.hasOwn(values, key) ? String(values[key]) : match,
  );
}

/**
 * @template T
 * @param {readonly T[]} items
 * @returns {T}
 */
export function pick(items) {
  return items[Math.floor(Math.random() * items.length)];
}
