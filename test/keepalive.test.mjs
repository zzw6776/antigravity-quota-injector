import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  classifyQuotaGroupKeepAlive,
  evaluateQuotaPoolKeepAlive,
  isQuotaBucketUnstarted,
  listModelsForQuotaGroup,
  pickKeepAliveModelForGroup,
} from '../src/formatting.mjs';
import { createKeepAliveManager } from '../src/keepalive.mjs';

const SAMPLE_GROUPS = [
  {
    displayName: 'Gemini Models',
    description:
      'Models within this group: Gemini 4 Neon, Gemini 4 Hydrogen, Orchestrator (Neon), Gemini 3.8 Flash',
    buckets: [
      {
        bucketId: 'gemini-weekly',
        window: 'weekly',
        remainingFraction: 0.87,
        description: 'You have used some of your weekly limit, it will fully refresh in 6 days.',
        resetTime: '2026-11-28T05:28:28Z',
      },
      {
        bucketId: 'gemini-5h',
        window: '5h',
        remainingFraction: 0.59,
        description: 'You have used some of your 5-hour limit, it will fully refresh in 3 hours.',
        resetTime: '2026-11-21T10:28:28Z',
      },
    ],
  },
  {
    displayName: 'Claude and GPT models',
    description: 'Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B',
    buckets: [
      {
        bucketId: '3p-weekly',
        window: 'weekly',
        remainingFraction: 1,
        resetTime: '2026-11-28T06:46:10Z',
      },
      {
        bucketId: '3p-5h',
        window: '5h',
        remainingFraction: 1,
        resetTime: '2026-11-21T11:46:10Z',
      },
    ],
  },
  {
    displayName: 'Gemini 4 Argon',
    description: 'For paid Pro plans, Argon quota is separate.',
    buckets: [
      {
        bucketId: 'gemini-argon-wtu-weekly',
        window: 'weekly',
        remainingFraction: 1,
        resetTime: '2026-11-28T06:46:10Z',
      },
    ],
  },
];

const SAMPLE_CONFIGS = [
  { label: 'Gemini 4 Neon (High)', modelOrAlias: { model: 'MODEL_NEON_HIGH' }, quotaInfo: { remainingFraction: 0.59, resetTime: '2026-11-21T10:28:28Z' } },
  { label: 'Gemini 4 Hydrogen (Low)', modelOrAlias: { model: 'MODEL_HYDROGEN_LOW' }, quotaInfo: { remainingFraction: 0.59, resetTime: '2026-11-21T10:28:28Z' } },
  { label: 'Gemini 3.8 Flash (High)', modelOrAlias: { model: 'MODEL_FLASH_HIGH' }, quotaInfo: { remainingFraction: 0.59, resetTime: '2026-11-21T10:28:28Z' } },
  { label: 'Gemini 3.8 Flash (Low)', modelOrAlias: { model: 'MODEL_FLASH_LOW' }, quotaInfo: { remainingFraction: 0.59, resetTime: '2026-11-21T10:28:28Z' } },
  { label: 'Orchestrator (Argon)', modelOrAlias: { model: 'MODEL_ORCH_ARGON' }, quotaInfo: { remainingFraction: 1, resetTime: '2026-11-28T06:46:10Z' } },
  { label: 'Gemini 4 Argon (High)', modelOrAlias: { model: 'MODEL_ARGON_HIGH' }, quotaInfo: { remainingFraction: 1, resetTime: '2026-11-28T06:46:10Z' } },
  { label: 'Gemini 4 Argon (Low)', modelOrAlias: { model: 'MODEL_ARGON_LOW' }, quotaInfo: { remainingFraction: 1, resetTime: '2026-11-28T06:46:10Z' } },
  { label: 'Claude Opus 5.5 (High)', modelOrAlias: { model: 'MODEL_OPUS_HIGH' }, quotaInfo: { remainingFraction: 1, resetTime: '2026-11-21T11:46:10Z' } },
  { label: 'Claude Sonnet 5.5 (Low)', modelOrAlias: { model: 'MODEL_SONNET_LOW' }, quotaInfo: { remainingFraction: 1, resetTime: '2026-11-21T11:46:10Z' } },
  { label: 'GPT-OSS 120B (Medium)', modelOrAlias: { model: 'MODEL_GPT_OSS' }, quotaInfo: { remainingFraction: 1, resetTime: '2026-11-21T11:46:10Z' } },
  { label: 'Gemini 4 Carbon', modelOrAlias: { model: 'MODEL_CARBON' }, quotaInfo: {} },
];

test('classifyQuotaGroupKeepAlive distinguishes 5h pools and weekly-only pools', () => {
  const gemPlan = classifyQuotaGroupKeepAlive(SAMPLE_GROUPS[0]);
  assert.equal(gemPlan?.cadence, '5h');
  assert.equal(gemPlan?.cadenceLabel, '唤醒');
  assert.equal(gemPlan?.targetBucket?.bucketId, 'gemini-5h');
  assert.equal(gemPlan?.guardWeeklyBucket?.bucketId, 'gemini-weekly');

  const argonPlan = classifyQuotaGroupKeepAlive(SAMPLE_GROUPS[2]);
  assert.equal(argonPlan?.cadence, 'weekly');
  assert.equal(argonPlan?.cadenceLabel, '唤醒');
  assert.equal(argonPlan?.targetBucket?.bucketId, 'gemini-argon-wtu-weekly');
  assert.equal(argonPlan?.guardWeeklyBucket, null);
});

test('listModelsForQuotaGroup and pickKeepAliveModelForGroup select lightest model per pool and honor preferences', () => {
  const gemPicked = pickKeepAliveModelForGroup(SAMPLE_GROUPS[0], SAMPLE_CONFIGS);
  assert.equal(gemPicked?.modelId, 'MODEL_FLASH_LOW');

  const claudeModels = listModelsForQuotaGroup(SAMPLE_GROUPS[1], SAMPLE_CONFIGS);
  assert.deepEqual(
    claudeModels.map((m) => m.modelId),
    ['MODEL_GPT_OSS', 'MODEL_SONNET_LOW', 'MODEL_OPUS_HIGH']
  );
  assert.equal(pickKeepAliveModelForGroup(SAMPLE_GROUPS[1], SAMPLE_CONFIGS, 'MODEL_SONNET_LOW')?.modelId, 'MODEL_SONNET_LOW');

  const argonPicked = pickKeepAliveModelForGroup(SAMPLE_GROUPS[2], SAMPLE_CONFIGS);
  assert.equal(argonPicked?.modelId, 'MODEL_ARGON_LOW');
});

test('evaluateQuotaPoolKeepAlive triggers only on unstarted full buckets with sufficient weekly quota', () => {
  const nowMs = Date.parse('2026-11-21T06:46:10Z');

  // Claude unstarted (remainingFraction: 1, resetTime = now + 5h) -> eligible
  const claudeRes = evaluateQuotaPoolKeepAlive({
    group: SAMPLE_GROUPS[1],
    enabled: true,
    nowMs,
  });
  assert.equal(claudeRes.eligible, true);
  assert.equal(claudeRes.reason, 'unstarted');

  // Weekly-only Argon unstarted (remainingFraction: 1, resetTime = now + 7d) -> eligible
  const argonRes = evaluateQuotaPoolKeepAlive({
    group: SAMPLE_GROUPS[2],
    enabled: true,
    nowMs,
  });
  assert.equal(argonRes.eligible, true);
  assert.equal(argonRes.plan?.cadence, 'weekly');

  // Gemini already active -> not eligible
  const gemRes = evaluateQuotaPoolKeepAlive({
    group: SAMPLE_GROUPS[0],
    enabled: true,
    nowMs,
  });
  assert.equal(gemRes.eligible, false);
  assert.equal(gemRes.reason, 'already_active');

  // Even if remainingFraction is 1, a shorter locked countdown or "used some" description counts as started
  assert.equal(
    isQuotaBucketUnstarted(
      { remainingFraction: 1, resetTime: '2026-11-21T10:28:28Z', description: '' },
      '5h',
      nowMs
    ),
    false
  );
  assert.equal(
    isQuotaBucketUnstarted(
      { remainingFraction: 1, resetTime: '2026-11-21T11:46:10Z', description: 'You have used some of your 5-hour limit' },
      '5h',
      nowMs
    ),
    false
  );

  // Weekly depleted blocks 5h trigger
  const depletedWeeklyRes = evaluateQuotaPoolKeepAlive({
    group: {
      displayName: 'Claude and GPT models',
      buckets: [
        { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.01, resetTime: '2026-11-28T06:46:10Z' },
        { bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: '2026-11-21T11:46:10Z' },
      ],
    },
    enabled: true,
    nowMs,
  });
  assert.equal(depletedWeeklyRes.eligible, false);
  assert.equal(depletedWeeklyRes.reason, 'weekly_depleted');
});

test('createKeepAliveManager persists settings, enforces multi-window lease lock, and applies error backoff', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-ka-test-'));
  let now = 1_000_000;
  try {
    const mgr = createKeepAliveManager({
      stateDir: dir,
      defaultCooldownMs: 180_000,
      backoffMs: 900_000,
      nowFn: () => now,
    });
    const email = 'Alice@Example.com';

    mgr.setPoolEnabled({ accountEmail: email, poolKey: 'gemini 4 argon', enabled: true });
    mgr.setPoolModel({ accountEmail: email, poolKey: 'gemini 4 argon', modelId: 'MODEL_ARGON_LOW' });

    const c1 = mgr.claimTrigger({ accountEmail: email, poolKey: 'gemini 4 argon' });
    assert.equal(c1.allowed, true);
    assert.ok(c1.runId);

    // Concurrent second window cannot double-claim while lease is held
    const c2 = mgr.claimTrigger({ accountEmail: email, poolKey: 'gemini 4 argon' });
    assert.equal(c2.allowed, false);
    assert.equal(c2.reason, 'in_flight');

    // Error triggers 15m backoff
    mgr.completeTrigger({
      accountEmail: email,
      poolKey: 'gemini 4 argon',
      runId: c1.runId,
      ok: false,
      error: 'HTTP 500',
    });
    now += 200_000;
    const blockedByBackoff = mgr.claimTrigger({ accountEmail: email, poolKey: 'gemini 4 argon' });
    assert.equal(blockedByBackoff.allowed, false);
    assert.equal(blockedByBackoff.reason, 'backoff');

    // Toggling off and on clears error/backoff
    mgr.setPoolEnabled({ accountEmail: email, poolKey: 'gemini 4 argon', enabled: true });
    const reloaded = createKeepAliveManager({ stateDir: dir, nowFn: () => now });
    const state = reloaded.getState(email);
    assert.equal(state.pools['gemini 4 argon']?.enabled, true);
    assert.equal(state.pools['gemini 4 argon']?.preferredModel, 'MODEL_ARGON_LOW');
    assert.equal(state.pools['gemini 4 argon']?.backoffUntil, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
