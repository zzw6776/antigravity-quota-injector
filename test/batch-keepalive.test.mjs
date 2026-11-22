import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeBatchEligibleSummary,
  createBatchKeepAliveStore,
  hasEnabledKeepAliveSwitch,
  hasPaidSubscription,
  planBatchKeepAliveRun,
} from '../src/batch-keepalive.mjs';

test('hasPaidSubscription and hasEnabledKeepAliveSwitch validate plan and switches cleanly', () => {
  assert.equal(hasPaidSubscription({ planName: 'Pro' }), true);
  assert.equal(hasPaidSubscription({ planName: 'Ultra 5x' }), true);
  assert.equal(hasPaidSubscription({ planName: 'Ultra 20x' }), true);
  assert.equal(hasPaidSubscription({ planName: 'Free' }), false);
  assert.equal(hasPaidSubscription({ planName: 'standard' }), false);
  assert.equal(hasPaidSubscription({ planName: '' }), false);

  assert.equal(hasEnabledKeepAliveSwitch(null), false);
  assert.equal(hasEnabledKeepAliveSwitch({ pools: { 'gemini models': { enabled: false } } }), false);
  assert.equal(hasEnabledKeepAliveSwitch({ pools: { 'gemini models': { enabled: true } } }), true);
});

test('planBatchKeepAliveRun queues subscribed accounts with enabled switches regardless of snapshot and skips Free or switch-off accounts', () => {
  const accounts = [
    { id: 'free-1', email: 'free@example.com', planName: 'Free', active: false },
    { id: 'pro-off', email: 'off@example.com', planName: 'Pro', active: false },
    { id: 'pro-1', email: 'a@example.com', planName: 'Pro', active: false },
    { id: 'ultra-1', email: 'b@example.com', planName: 'Ultra 5x', active: true },
    { id: 'pro-2', email: 'c@example.com', planName: 'Pro', active: false },
  ];
  const switchMap = {
    'free@example.com': { pools: { 'gemini models': { enabled: true } } },
    'off@example.com': { pools: { 'gemini models': { enabled: false } } },
    'a@example.com': { pools: { 'gemini models': { enabled: true } } },
    'b@example.com': { pools: { 'claude models': { enabled: true } } },
    'c@example.com': { pools: { 'gemini models': { enabled: true } } },
  };
  const getKeepAliveState = (email) => switchMap[email] || { pools: {} };

  const plan = planBatchKeepAliveRun({ accounts, activeEmail: 'b@example.com', getKeepAliveState });
  assert.equal(plan.ok, true);
  assert.equal(plan.originAccount.id, 'ultra-1');
  assert.deepEqual(
    plan.targets.map((t) => ({ id: t.accountId, isOrigin: t.isOrigin })),
    [
      { id: 'ultra-1', isOrigin: true },
      { id: 'pro-1', isOrigin: false },
      { id: 'pro-2', isOrigin: false },
    ]
  );

  const summary = computeBatchEligibleSummary({ accounts, activeEmail: 'b@example.com', getKeepAliveState });
  assert.equal(summary.eligibleCount, 3);
  assert.equal(summary.paidCount, 4);
  assert.equal(summary.skippedFreeCount, 1);

  const noSwitchPlan = planBatchKeepAliveRun({
    accounts: [{ id: 'pro-off', email: 'off@example.com', planName: 'Pro', active: true }],
    activeEmail: 'off@example.com',
    getKeepAliveState,
  });
  assert.equal(noSwitchPlan.ok, false);
  assert.match(noSwitchPlan.error, /开启唤醒开关/);

  const onlyFree = planBatchKeepAliveRun({
    accounts: [{ id: 'free-1', email: 'free@example.com', planName: 'Free', active: true }],
    activeEmail: 'free@example.com',
    getKeepAliveState,
  });
  assert.equal(onlyFree.ok, false);
  assert.match(onlyFree.error, /有订阅/);
});

test('createBatchKeepAliveStore tracks progress, stop-in-place cancellation, and completion summary', () => {
  const store = createBatchKeepAliveStore();
  const s1 = store.start({
    originAccount: { id: 'pro-1', email: 'a@example.com' },
    targets: [
      { accountId: 'pro-1', email: 'a@example.com', isOrigin: true },
      { accountId: 'pro-2', email: 'b@example.com', isOrigin: false },
    ],
    nowMs: 1000,
  });
  assert.equal(s1.active, true);
  assert.equal(s1.visible, true);
  assert.equal(s1.phase, 'waiting_ready');
  assert.equal(s1.items[0].status, 'waiting_ready');
  assert.equal(s1.items[1].status, 'pending');

  const raw = store.getRaw();
  raw.items[0].status = 'done';
  raw.items[0].detail = '已唤醒 1 组';
  const cancelled = store.markCancelled();
  assert.equal(cancelled.active, false);
  assert.equal(cancelled.phase, 'cancelled');
  assert.equal(cancelled.items[0].status, 'done');
  assert.equal(cancelled.items[1].status, 'cancelled');
  assert.match(cancelled.statusText, /停留在当前账号/);

  const dismissed = store.dismiss();
  assert.equal(dismissed.visible, false);
  assert.equal(dismissed.phase, 'idle');
});

test('createBatchKeepAliveStore marks completion metadata for all-success and partial-failure runs', () => {
  const store = createBatchKeepAliveStore();
  store.start({
    originAccount: { id: 'pro-1', email: 'a@example.com' },
    targets: [
      { accountId: 'pro-1', email: 'a@example.com', isOrigin: true },
      { accountId: 'pro-2', email: 'b@example.com', isOrigin: false },
    ],
    nowMs: 1000,
  });
  const raw = store.getRaw();
  raw.items[0].status = 'done';
  raw.items[0].detail = '已唤醒 1 组';
  raw.items[1].status = 'skipped';
  raw.items[1].detail = '已在计时中';

  const done = store.markFinished();
  assert.equal(done.active, false);
  assert.equal(done.visible, true);
  assert.equal(done.phase, 'done');
  assert.equal(done.allSucceeded, true);
  assert.equal(done.finishedAt > 0, true);
  assert.equal(done.summaryText, '已唤醒 1 个 · 跳过 1 个');
  assert.match(done.statusText, /已全部完成并切回起始账号 a@example\.com/);

  raw.items[1].status = 'failed';
  const partialFail = store.markFinished();
  assert.equal(partialFail.phase, 'done');
  assert.equal(partialFail.allSucceeded, false);
  assert.match(partialFail.statusText, /1 个失败/);
});
