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
import { PRESET_NAMES } from './moderation/presets.js';

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
  const errorCodes = section(moderation, 'errors');
  const warningDm = section(moderation, 'warningDm');
  const manualWarning = section(moderation, 'manualWarning');
  const log = section(moderation, 'log');
  const logTitles = section(log, 'titles');
  const logFields = section(log, 'fields');
  const appeal = section(moderation, 'appeal');
  const names = section(moderation, 'names');
  const commands = section(parsed, 'commands');
  const ask = section(commands, 'ask');
  const appealCommand = section(commands, 'appeal');
  const forget = section(commands, 'forget');
  const status = section(commands, 'status');
  const setupSection = section(commands, 'setup');
  const setupPresets = section(setupSection, 'presets');
  const forgive = section(commands, 'forgive');
  const configSection = section(commands, 'config');
  const reportSection = section(commands, 'report');
  const removeSection = section(commands, 'remove');
  const warnSection = section(commands, 'warn');
  const noteSection = section(commands, 'note');
  const simulateSection = section(commands, 'simulate');
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
      // The server's rules in the operator's own words, for the
      // `get_server_rules` tool. Optional and empty by default: no rules here
      // means the tool is not offered at all, which is better than offering one
      // that answers with nothing and sends the model back to inventing.
      // Absent is fine; present but not a list of strings is a typo and fails
      // loudly, like every other key here.
      rules: Object.freeze(
        chat.rules === undefined ? [] : strings(chat, ['chat', 'rules'], { min: 0 }),
      ),
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
      // Shown in Discord's audit log next to the timeout, so it is text Mai
      // "says" and belongs here rather than in the enforcer.
      timeoutReason: str(moderation, ['moderation', 'timeoutReason']),
      timeoutReasonUnknown: str(moderation, ['moderation', 'timeoutReasonUnknown']),
      errorLine: str(moderation, ['moderation', 'errorLine']),
      // Discord error codes staff might see, in words. Keys stay strings: the
      // API sends numbers, and a YAML author may write them either way.
      errors: Object.freeze(
        Object.fromEntries(
          Object.entries(errorCodes).map(([code, text]) => {
            if (typeof text !== 'string' || !text.trim()) {
              fail(`moderation.errors.${code} must be a non-empty string`);
            }
            return [String(code).trim(), text];
          }),
        ),
      ),
      // Empty timezone = follow the container clock (TZ).
      timezone: typeof moderation.timezone === 'string' && moderation.timezone.trim()
        ? moderation.timezone.trim()
        : config.timezone,
      scoldPrefix: typeof moderation.scoldPrefix === 'string' ? moderation.scoldPrefix : '',
      scoldReplies: Object.freeze(strings(moderation, ['moderation', 'scoldReplies'])),
      log: Object.freeze({
        // The channel she creates for a server that has none.
        channelName: str(log, ['moderation', 'log', 'channelName']),
        channelTopic: str(log, ['moderation', 'log', 'channelTopic']),
        // A config entry with no actor: Mai changed it herself.
        selfActor: str(log, ['moderation', 'log', 'selfActor']),
        escalationSuspended: str(log, ['moderation', 'log', 'escalationSuspended']),
        escalationResumed: str(log, ['moderation', 'log', 'escalationResumed']),
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
          warningUndelivered: str(logTitles, ['moderation', 'log', 'titles', 'warningUndelivered']),
          degraded: str(logTitles, ['moderation', 'log', 'titles', 'degraded']),
          recovered: str(logTitles, ['moderation', 'log', 'titles', 'recovered']),
          nameFlagged: str(logTitles, ['moderation', 'log', 'titles', 'nameFlagged']),
          shadow: str(logTitles, ['moderation', 'log', 'titles', 'shadow']),
          shadowEnded: str(logTitles, ['moderation', 'log', 'titles', 'shadowEnded']),
          manualDelete: str(logTitles, ['moderation', 'log', 'titles', 'manualDelete']),
          warned: str(logTitles, ['moderation', 'log', 'titles', 'warned']),
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
          score: str(logFields, ['moderation', 'log', 'fields', 'score']),
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
        // The evidence view: staff only, ephemeral, one incident.
        evidenceButton: str(appeal, ['moderation', 'appeal', 'evidenceButton']),
        evidenceHeader: str(appeal, ['moderation', 'appeal', 'evidenceHeader']),
        evidenceLine: str(appeal, ['moderation', 'appeal', 'evidenceLine']),
        evidenceEmpty: str(appeal, ['moderation', 'appeal', 'evidenceEmpty']),
        evidenceAttachment: str(appeal, ['moderation', 'appeal', 'evidenceAttachment']),
        evidenceEmptyMessage: str(appeal, ['moderation', 'appeal', 'evidenceEmptyMessage']),
      }),
      names: Object.freeze({
        // Shown in Discord's audit log next to a nickname reset, so it is text
        // Mai "says" and belongs here.
        resetReason: str(names, ['moderation', 'names', 'resetReason']),
        unknownCategory: str(names, ['moderation', 'names', 'unknownCategory']),
        reportedOnly: str(names, ['moderation', 'names', 'reportedOnly']),
        nicknameReset: str(names, ['moderation', 'names', 'nicknameReset']),
        globalName: str(names, ['moderation', 'names', 'globalName']),
        resetFailed: str(names, ['moderation', 'names', 'resetFailed']),
      }),
      // `/mod warn`: staff having a word, in Mai's voice. Its own template
      // because nothing was removed, so there is nothing to quote back.
      manualWarning: Object.freeze({
        title: str(manualWarning, ['moderation', 'manualWarning', 'title']),
        intro: str(manualWarning, ['moderation', 'manualWarning', 'intro']),
        unknownGuild: str(manualWarning, ['moderation', 'manualWarning', 'unknownGuild']),
        reasonLabel: str(manualWarning, ['moderation', 'manualWarning', 'reasonLabel']),
        footer: str(manualWarning, ['moderation', 'manualWarning', 'footer']),
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
      pong: str(commands, ['commands', 'pong']),
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
        // Whether classification is answering. Moderation fails open, so an
        // outage is otherwise indistinguishable from a quiet server.
        healthy: str(status, ['commands', 'status', 'healthy']),
        degraded: str(status, ['commands', 'status', 'degraded']),
        degradedGuilds: str(status, ['commands', 'status', 'degradedGuilds']),
        // What Mai is missing to do what this server asked of her.
        permissionsOk: str(status, ['commands', 'status', 'permissionsOk']),
        permissionsMissing: str(status, ['commands', 'status', 'permissionsMissing']),
        permissionsUnknown: str(status, ['commands', 'status', 'permissionsUnknown']),
      }),
      setup: Object.freeze({
        introduction: str(setupSection, ['commands', 'setup', 'introduction']),
        missingPermissions: str(setupSection, ['commands', 'setup', 'missingPermissions']),
        applied: str(setupSection, ['commands', 'setup', 'applied']),
        appliedPublic: str(setupSection, ['commands', 'setup', 'appliedPublic']),
        needsLogChannel: str(setupSection, ['commands', 'setup', 'needsLogChannel']),
        // What she did about a log channel herself, said in the introduction.
        logChannelAdopted: str(setupSection, ['commands', 'setup', 'logChannelAdopted']),
        logChannelMissing: str(setupSection, ['commands', 'setup', 'logChannelMissing']),
        logChannelCreated: str(setupSection, ['commands', 'setup', 'logChannelCreated']),
        unknownPreset: str(setupSection, ['commands', 'setup', 'unknownPreset']),
        observationEnds: str(setupSection, ['commands', 'setup', 'observationEnds']),
        // One entry per preset, checked against the presets themselves: a new
        // bundle without its wording would otherwise ship a nameless button.
        presets: Object.freeze(
          Object.fromEntries(
            PRESET_NAMES.map((name) => {
              const preset = section(setupPresets, name);
              return [
                name,
                Object.freeze({
                  button: str(preset, ['commands', 'setup', 'presets', name, 'button']),
                  summary: str(preset, ['commands', 'setup', 'presets', name, 'summary']),
                }),
              ];
            }),
          ),
        ),
      }),
      appeal: Object.freeze({
        guildOnly: str(appealCommand, ['commands', 'appeal', 'guildOnly']),
        nothing: str(appealCommand, ['commands', 'appeal', 'nothing']),
        unavailable: str(appealCommand, ['commands', 'appeal', 'unavailable']),
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
          warned: str(historyActions, ['commands', 'history', 'actions', 'warned']),
        }),
        nextTimeout: str(history, ['commands', 'history', 'nextTimeout']),
        nextNothing: str(history, ['commands', 'history', 'nextNothing']),
        nextDisabled: str(history, ['commands', 'history', 'nextDisabled']),
        empty: str(history, ['commands', 'history', 'empty']),
      }),
      spend: Object.freeze({
        body: str(spend, ['commands', 'spend', 'body']),
        line: str(spend, ['commands', 'spend', 'line']),
        lineNoTokens: str(spend, ['commands', 'spend', 'lineNoTokens']),
        budgetOff: str(spend, ['commands', 'spend', 'budgetOff']),
        // Shown instead of the figures when the caller is not an operator.
        budgetHidden: str(spend, ['commands', 'spend', 'budgetHidden']),
        budgetExceededShared: str(spend, ['commands', 'spend', 'budgetExceededShared']),
        budgetOk: str(spend, ['commands', 'spend', 'budgetOk']),
        budgetExceeded: str(spend, ['commands', 'spend', 'budgetExceeded']),
        nothing: str(spend, ['commands', 'spend', 'nothing']),
      }),
      warn: Object.freeze({
        done: str(warnSection, ['commands', 'warn', 'done']),
        undelivered: str(warnSection, ['commands', 'warn', 'undelivered']),
        delivered: str(warnSection, ['commands', 'warn', 'delivered']),
        notDelivered: str(warnSection, ['commands', 'warn', 'notDelivered']),
      }),
      note: Object.freeze({
        added: str(noteSection, ['commands', 'note', 'added']),
        cleared: str(noteSection, ['commands', 'note', 'cleared']),
        nothing: str(noteSection, ['commands', 'note', 'nothing']),
        line: str(noteSection, ['commands', 'note', 'line']),
        empty: str(noteSection, ['commands', 'note', 'empty']),
      }),
      simulate: Object.freeze({
        body: str(simulateSection, ['commands', 'simulate', 'body']),
        line: str(simulateSection, ['commands', 'simulate', 'line']),
        wouldFlag: str(simulateSection, ['commands', 'simulate', 'wouldFlag']),
        wouldPass: str(simulateSection, ['commands', 'simulate', 'wouldPass']),
        noLocal: str(simulateSection, ['commands', 'simulate', 'noLocal']),
        empty: str(simulateSection, ['commands', 'simulate', 'empty']),
        disabled: str(simulateSection, ['commands', 'simulate', 'disabled']),
        busy: str(simulateSection, ['commands', 'simulate', 'busy']),
        failed: str(simulateSection, ['commands', 'simulate', 'failed']),
      }),
      remove: Object.freeze({
        done: str(removeSection, ['commands', 'remove', 'done']),
        guildOnly: str(removeSection, ['commands', 'remove', 'guildOnly']),
        botMessage: str(removeSection, ['commands', 'remove', 'botMessage']),
        failed: str(removeSection, ['commands', 'remove', 'failed']),
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
        // Three layers, so three answers to "who decided this?". `inherited`
        // marks a built-in default, `fromProfile` a value the guild's profile
        // decides, and an unmarked line is one somebody here set deliberately.
        inherited: str(configSection, ['commands', 'config', 'inherited']),
        fromProfile: str(configSection, ['commands', 'config', 'fromProfile']),
        noProfile: str(configSection, ['commands', 'config', 'noProfile']),
        on: str(configSection, ['commands', 'config', 'on']),
        off: str(configSection, ['commands', 'config', 'off']),
        unset: str(configSection, ['commands', 'config', 'unset']),
        systemChannel: str(configSection, ['commands', 'config', 'systemChannel']),
        thresholdOff: str(configSection, ['commands', 'config', 'thresholdOff']),
        allCategories: str(configSection, ['commands', 'config', 'allCategories']),
        noExemptChannels: str(configSection, ['commands', 'config', 'noExemptChannels']),
        // The rules Mai applies herself: each is off until a guild turns it on.
        guardOff: str(configSection, ['commands', 'config', 'guardOff']),
        noDomains: str(configSection, ['commands', 'config', 'noDomains']),
        floodRule: str(configSection, ['commands', 'config', 'floodRule']),
        evidenceOn: str(configSection, ['commands', 'config', 'evidenceOn']),
        shadowUntil: str(configSection, ['commands', 'config', 'shadowUntil']),
        // Stored, but waiting on something only the operator can switch on.
        nameCheckUnavailable: str(configSection, ['commands', 'config', 'nameCheckUnavailable']),
        welcomeUnavailable: str(configSection, ['commands', 'config', 'welcomeUnavailable']),
        evidenceUnavailable: str(configSection, ['commands', 'config', 'evidenceUnavailable']),
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
