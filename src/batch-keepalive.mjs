import crypto from 'node:crypto';

export function hasPaidSubscription(account) {
  const plan = String(account?.planName || '').trim();
  if (!plan) return false;
  return !/^(?:free|standard|none)$/i.test(plan);
}

export function hasEnabledKeepAliveSwitch(keepAliveState) {
  const pools = keepAliveState?.pools && typeof keepAliveState.pools === 'object' ? keepAliveState.pools : {};
  return Object.values(pools).some((cfg) => Boolean(cfg?.enabled));
}

/**
 * Plan a batch switch-and-wake queue covering subscribed accounts that have at least one
 * keep-alive switch enabled, without pre-filtering by local quota snapshots.
 */
export function planBatchKeepAliveRun({
  accounts = [],
  activeEmail = '',
  liveProfile = null,
  getKeepAliveState,
} = {}) {
  const list = Array.isArray(accounts) ? accounts : [];
  const normActive = String(activeEmail || '').trim().toLowerCase();
  const originAccount =
    list.find((a) => Boolean(a?.active)) ||
    (normActive ? list.find((a) => String(a?.email || '').trim().toLowerCase() === normActive) : null) ||
    null;

  if (!originAccount) {
    return {
      ok: false,
      error: '请先等待当前账号完成快照保存再执行一键唤醒',
      originAccount: null,
      targets: [],
    };
  }

  const originTargets = [];
  const otherTargets = [];
  let paidCount = 0;

  for (let i = 0; i < list.length; i++) {
    const acct = list[i];
    if (!acct?.id || !acct?.email) continue;
    const isOrigin = acct.id === originAccount.id;
    const effectivePlanName =
      isOrigin && liveProfile?.planName ? liveProfile.planName : acct.planName;
    if (!hasPaidSubscription({ ...acct, planName: effectivePlanName })) {
      continue;
    }
    paidCount += 1;
    const kaState = typeof getKeepAliveState === 'function' ? getKeepAliveState(acct.email) : null;
    if (!hasEnabledKeepAliveSwitch(kaState)) {
      continue;
    }
    const target = {
      accountId: acct.id,
      email: acct.email,
      planName: effectivePlanName,
      isOrigin,
    };
    if (isOrigin) {
      originTargets.push(target);
    } else {
      otherTargets.push(target);
    }
  }

  const targets = [...originTargets, ...otherTargets];
  if (targets.length === 0) {
    const error =
      paidCount === 0
        ? '暂无有订阅的账号可执行唤醒（Free/无订阅账号已自动跳过）'
        : '没有已开启唤醒开关的账号，请先在对应账号中开启唤醒开关';
    return { ok: false, error, originAccount, targets: [] };
  }

  return { ok: true, error: '', originAccount, targets };
}

export function computeBatchEligibleSummary({
  accounts = [],
  activeEmail = '',
  getKeepAliveState,
} = {}) {
  const list = Array.isArray(accounts) ? accounts : [];
  const normActive = String(activeEmail || '').trim().toLowerCase();
  let eligibleCount = 0;
  let paidCount = 0;
  let skippedFreeCount = 0;

  for (let i = 0; i < list.length; i++) {
    const acct = list[i];
    if (!acct?.email) continue;
    if (!hasPaidSubscription(acct)) {
      skippedFreeCount += 1;
      continue;
    }
    paidCount += 1;
    const kaState = typeof getKeepAliveState === 'function' ? getKeepAliveState(acct.email) : null;
    if (hasEnabledKeepAliveSwitch(kaState)) {
      eligibleCount += 1;
    }
  }

  const originExists = Boolean(
    list.find((a) => Boolean(a?.active)) ||
      (normActive ? list.find((a) => String(a?.email || '').trim().toLowerCase() === normActive) : null)
  );

  const note =
    eligibleCount > 0
      ? `依次切换 ${eligibleCount} 个已开唤醒开关的订阅账号，逐一实查并唤醒后切回当前账号`
      : paidCount === 0
        ? `暂无有订阅的账号可执行一键唤醒${skippedFreeCount > 0 ? `（已跳过 ${skippedFreeCount} 个无订阅账号）` : ''}`
        : '请先在订阅账号的配额面板中开启至少一个「唤醒」开关';

  return { eligibleCount, paidCount, skippedFreeCount, originExists, note };
}

export function createBatchKeepAliveStore() {
  const reset = () => ({
    active: false,
    visible: false,
    runId: '',
    phase: 'idle',
    originAccountId: '',
    originEmail: '',
    currentIndex: -1,
    stepSeq: 0,
    stepPhaseStartedAt: 0,
    assignedSessionId: '',
    assignedStepToken: '',
    cancelRequested: false,
    switchedAwayOnce: false,
    activePoolLabel: '',
    statusText: '',
    summaryText: '',
    items: [],
  });

  let state = reset();

  const getPublicState = (sessionTargetId = '') => {
    const currentItem = state.currentIndex >= 0 ? state.items[state.currentIndex] || null : null;
    return {
      active: state.active,
      visible: state.visible,
      runId: state.runId,
      phase: state.phase,
      originAccountId: state.originAccountId,
      originEmail: state.originEmail,
      currentIndex: state.currentIndex,
      stepSeq: state.stepSeq,
      currentTargetEmail: currentItem?.email || '',
      assignedStepToken: state.assignedStepToken,
      isAssignedExecutor: Boolean(
        state.active &&
          sessionTargetId &&
          state.assignedSessionId &&
          sessionTargetId === state.assignedSessionId
      ),
      cancelRequested: state.cancelRequested,
      activePoolLabel: state.activePoolLabel,
      statusText: state.statusText,
      summaryText: state.summaryText,
      items: state.items.map((it) => ({ ...it })),
    };
  };

  const start = ({ originAccount, targets, nowMs = Date.now() }) => {
    state = {
      active: true,
      visible: true,
      runId: crypto.randomUUID(),
      phase: targets[0]?.isOrigin ? 'waiting_ready' : 'switching',
      originAccountId: originAccount.id,
      originEmail: originAccount.email,
      currentIndex: 0,
      stepSeq: 1,
      stepPhaseStartedAt: nowMs,
      assignedSessionId: '',
      assignedStepToken: '',
      cancelRequested: false,
      switchedAwayOnce: false,
      activePoolLabel: '',
      statusText: targets[0]?.isOrigin
        ? `准备原地唤醒 ${targets[0].email}…`
        : `正在切换至 ${targets[0]?.email || ''}…`,
      summaryText: '',
      items: targets.map((t, idx) => ({
        accountId: t.accountId,
        email: t.email,
        planName: t.planName || '',
        isOrigin: Boolean(t.isOrigin),
        status: idx === 0 ? (t.isOrigin ? 'waiting_ready' : 'switching') : 'pending',
        detail: idx === 0 ? (t.isOrigin ? '等待配额就绪' : '正在切号重启') : '等待中',
      })),
    };
    return getPublicState();
  };

  const markCancelled = () => {
    state.active = false;
    state.phase = 'cancelled';
    state.assignedSessionId = '';
    state.assignedStepToken = '';
    state.activePoolLabel = '';
    for (let i = 0; i < state.items.length; i++) {
      const it = state.items[i];
      if (it.status === 'pending' || it.status === 'switching' || it.status === 'waiting_ready' || it.status === 'waking') {
        it.status = 'cancelled';
        it.detail = '已取消';
      }
    }
    const doneCount = state.items.filter((it) => it.status === 'done').length;
    state.statusText = '已中途停止，停留在当前账号';
    state.summaryText = `已取消（已唤醒 ${doneCount}/${state.items.length}）`;
    return getPublicState();
  };

  const markFinished = ({ failedReturnError = '', skippedReturn = false } = {}) => {
    state.active = false;
    state.assignedSessionId = '';
    state.assignedStepToken = '';
    state.activePoolLabel = '';
    const doneCount = state.items.filter((it) => it.status === 'done').length;
    const failCount = state.items.filter((it) => it.status === 'failed').length;
    const skipCount = state.items.filter((it) => it.status === 'skipped').length;
    if (failedReturnError) {
      state.phase = 'failed';
      state.statusText = `唤醒结束，但切回原账号失败：${failedReturnError}`;
    } else {
      state.phase = 'done';
      state.statusText = skippedReturn
        ? `已完成，当前处于原账号 ${state.originEmail}`
        : `已全部完成并切回起始账号 ${state.originEmail}`;
    }
    const parts = [`已唤醒 ${doneCount} 个`];
    if (skipCount > 0) parts.push(`跳过 ${skipCount} 个`);
    if (failCount > 0) parts.push(`失败 ${failCount} 个`);
    state.summaryText = parts.join(' · ');
    return getPublicState();
  };

  return {
    getRaw: () => state,
    getPublicState,
    start,
    markCancelled,
    markFinished,
    dismiss: () => {
      if (state.active) return getPublicState();
      state = reset();
      return getPublicState();
    },
  };
}
