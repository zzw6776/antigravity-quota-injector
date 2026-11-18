import assert from 'node:assert/strict';
import test from 'node:test';

import { buildClientScript } from '../src/daemon.mjs';
import {
  computeTurnPairingOffset,
  contextLevelClass,
  extractQuotaBuckets,
  formatCallDetailTitle,
  formatContextCompact,
  formatContextK,
  formatResetCountdown,
  formatTurnSummary,
  matchQuotaGroup,
  normalizeModelLabel,
  orderQuotaBuckets,
} from '../src/formatting.mjs';
import { translateUiText } from '../src/i18n-zh.mjs';

const SAMPLE_GROUPS = [
  {
    displayName: 'Gemini Models',
    description: 'Models within this group: Gemini 4 Hydrogen, Gemini 3.8 Flash',
    buckets: [
      { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.9416 },
      { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.7958 },
    ],
  },
  {
    displayName: 'Claude and GPT models',
    description: 'Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B',
    buckets: [
      { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 1 },
      { bucketId: '3p-5h', window: '5h', remainingFraction: 0.5 },
    ],
  },
  {
    displayName: 'Gemini 4 Argon',
    description: 'Argon quota is separate.',
    buckets: [
      { bucketId: 'gemini-argon-wtu-weekly', window: 'weekly', remainingFraction: 0.67 },
    ],
  },
];

test('formatTurnSummary omits latency and price and formats codex-style line', () => {
  const summary = formatTurnSummary({
    totalTokens: 943000,
    inputTokens: 940000,
    cachedInputTokens: 935300,
    cumulativeTotalTokens: 139749000,
    firstTokenLatencyMs: 4400,
    outputSpeed: 61.7,
    completed: true,
  });
  assert.match(summary, /本轮 Token 0\.943M/);
  assert.match(summary, /缓存命中率 99\.5%/);
  assert.match(summary, /累计 139\.749M/);
  assert.match(summary, /首字 4\.4s/);
  assert.match(summary, /速率 61\.7 tok\/s/);
  assert.doesNotMatch(summary, /延时|价格/);
});

test('matchQuotaGroup picks the group matching active model selector label', () => {
  const g1 = matchQuotaGroup(SAMPLE_GROUPS, 'Gemini 4 Hydrogen High');
  assert.equal(g1.displayName, 'Gemini Models');
  const b1 = extractQuotaBuckets(g1);
  assert.equal(b1.fiveHour.bucketId, 'gemini-5h');
  assert.equal(b1.weekly.bucketId, 'gemini-weekly');

  const g2 = matchQuotaGroup(SAMPLE_GROUPS, 'Claude Sonnet 5.5 (High)');
  assert.equal(g2.displayName, 'Claude and GPT models');

  const g3 = matchQuotaGroup(SAMPLE_GROUPS, 'Gemini 4 Argon Medium');
  assert.equal(g3.displayName, 'Gemini 4 Argon');
  const b3 = extractQuotaBuckets(g3);
  assert.equal(b3.fiveHour, null);
  assert.equal(b3.weekly.bucketId, 'gemini-argon-wtu-weekly');
});

test('formatResetCountdown formats remaining time cleanly', () => {
  const now = Date.parse('2026-11-17T10:00:00Z');
  assert.equal(formatResetCountdown('2026-11-17T14:16:00Z', now), '4小时16分后重置');
  assert.equal(formatResetCountdown('2026-11-19T12:00:00Z', now), '2天2小时后重置');
  assert.equal(formatResetCountdown('2026-11-17T09:59:00Z', now), '即将重置');
});

test('formatContextCompact and contextLevelClass format context window cleanly', () => {
  assert.equal(formatContextCompact(137624), '138k');
  assert.equal(formatContextCompact(256000), '256k');
  assert.equal(formatContextCompact(1000000), '1M');
  assert.equal(formatContextK(384200), '384k');
  assert.equal(formatContextK(1000000), '1000k');
  assert.equal(contextLevelClass(137624, 256000), 'aq-lvl-ok');
  assert.equal(contextLevelClass(200000, 256000), 'aq-lvl-warn');
  assert.equal(contextLevelClass(240000, 256000), 'aq-lvl-crit');
});

test('buildClientScript produces syntactically valid JS without leftover exports or placeholders', () => {
  const { version, script } = buildClientScript({ codexTheme: true, zhUi: true });
  assert.match(version, /^aq-[0-9a-f]{10}$/);
  assert.doesNotMatch(script, /__AQ_VERSION__|__AQ_FORMATTING_HELPERS__|__AQ_I18N_HELPERS__|__AQ_CODEX_THEME_CSS__/);
  assert.match(script, /rgb\(232, 243, 254\)/);
  assert.match(script, /新聊天/);
  assert.match(script, /accountsSupported/);
  assert.match(script, /lastTurnsCid/);
  assert.match(script, /aq-update-open/);
  assert.match(script, /orderQuotaBuckets/);
  assert.match(script, /\.dev/);
  assert.doesNotMatch(script, /当前登录：|data-aq-acct-save|data-aq-quota-refresh|data-aq-update-check|data-aq-update-install|>检查更新<|已是最新版本/);
  assert.doesNotMatch(script, /^\s*export\s+/m);
  assert.doesNotThrow(() => new Function(script));

  const withoutTheme = buildClientScript({ codexTheme: false });
  assert.notEqual(withoutTheme.version, version);
  assert.doesNotMatch(withoutTheme.script, /rgb\(232, 243, 254\)/);

  const withoutZh = buildClientScript({ zhUi: false });
  assert.notEqual(withoutZh.version, version);
  assert.doesNotMatch(withoutZh.script, /ZH_UI_EXACT/);
});

test('orderQuotaBuckets places 5h before weekly and filters disabled buckets', () => {
  const ordered = orderQuotaBuckets([
    { bucketId: 'custom-extra', window: 'monthly', remainingFraction: 0.9 },
    { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.94 },
    { bucketId: 'disabled-5h', window: '5h', remainingFraction: 0.1, disabled: true },
    { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.8 },
  ]);
  assert.deepEqual(
    ordered.map((b) => b.bucketId),
    ['gemini-5h', 'gemini-weekly', 'custom-extra']
  );
});

test('translateUiText translates exact Settings/UI strings and skips arbitrary text', () => {
  assert.equal(translateUiText('New Conversation'), '新聊天');
  assert.equal(translateUiText('  Queued Messages  '), '  排队消息  ');
  assert.equal(translateUiText('Terminal Command Auto Execution'), '终端命令自动执行策略');
  assert.equal(translateUiText('2 attachment(s)'), '2 个附件');
  assert.equal(translateUiText('EcoPaste'), null);
  assert.equal(translateUiText('新聊天'), null);
});

test('formatCallDetailTitle groups repeated tool calls and labels final response', () => {
  assert.equal(
    formatCallDetailTitle({
      toolCalls: [{ toolName: 'edit_file' }, { toolName: 'edit_file' }, { toolName: 'run_command' }],
    }),
    'edit_file ×2、run_command'
  );
  assert.equal(formatCallDetailTitle({ toolCalls: [], hasVisibleText: true }, true), '最终回复');
  assert.equal(formatCallDetailTitle({ toolCalls: [], hasVisibleText: true, followsToolResult: true }, false), '生成回复');
  assert.equal(formatCallDetailTitle({ toolCalls: [], hasVisibleText: false, followsToolResult: true }, false), '处理工具结果');
});

test('computeTurnPairingOffset aligns paginated DOM turn slices to the tail of DB turns', () => {
  assert.equal(computeTurnPairingOffset(7, 34), 27);
  assert.equal(computeTurnPairingOffset(2, 34), 32);
  assert.equal(computeTurnPairingOffset(5, 5), 0);
  assert.equal(computeTurnPairingOffset(6, 5), 0);
  assert.equal(computeTurnPairingOffset(0, 10), 0);
});

test('normalizeModelLabel strips both English Thinking and translated 思考 suffixes', () => {
  assert.equal(normalizeModelLabel('Claude Sonnet 5.5 (High Thinking)'), 'claude sonnet 5.5');
  assert.equal(normalizeModelLabel('Claude Sonnet 5.5 (High 思考)'), 'claude sonnet 5.5');
  assert.equal(normalizeModelLabel('Claude Sonnet 5.5 思考'), 'claude sonnet 5.5');
  assert.equal(matchQuotaGroup(SAMPLE_GROUPS, 'Claude Sonnet 5.5 思考').displayName, 'Claude and GPT models');
});
