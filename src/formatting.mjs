/**
 * Pure formatting and quota matching helpers shared between tests and injected browser script.
 */

const numberFormatCache = new Map();

function formatLocaleFixed(value, minDigits, maxDigits = minDigits) {
  const key = `${minDigits}:${maxDigits}`;
  let fmt = numberFormatCache.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat(undefined, {
      minimumFractionDigits: minDigits,
      maximumFractionDigits: maxDigits,
    });
    numberFormatCache.set(key, fmt);
  }
  return fmt.format(value);
}

export function formatTokenCount(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return '0 tok';
  const rounded = Math.round(num);
  if (rounded < 1_000) return `${rounded} tok`;
  if (num < 100_000) return `${formatLocaleFixed(num / 1_000, 1, 2)}K`;
  return `${formatLocaleFixed(num / 1_000_000, 2, 3)}M`;
}

export function formatDurationMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1_000;
  const digits = seconds >= 100 ? 0 : 1;
  return `${formatLocaleFixed(seconds, digits)}s`;
}

/**
 * Format end-to-end turn elapsed duration cleanly (seconds under 1m, min/sec above 1m).
 */
export function formatElapsedDuration(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const totalSec = Math.max(1, Math.round(ms / 1_000));
  if (totalSec < 60) return `${totalSec}秒`;
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hours > 0) {
    return `${hours}小时${mins > 0 ? `${mins}分` : ''}${secs > 0 ? `${secs}秒` : ''}`;
  }
  return `${mins}分${secs > 0 ? `${secs}秒` : ''}`;
}

export function formatRate(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  const digits = num >= 100 ? 0 : num >= 10 ? 1 : 2;
  return `${formatLocaleFixed(num, digits)} tok/s`;
}

export function formatCacheHitRate(cachedTokens, inputTokens) {
  const input = Number(inputTokens);
  const cached = Number(cachedTokens);
  if (!Number.isFinite(input) || input <= 0 || !Number.isFinite(cached) || cached < 0) {
    return '—';
  }
  return `${formatLocaleFixed((cached / input) * 100, 1)}%`;
}

export function formatCny(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return '¥0.000000';
  const digits = num >= 1 ? 2 : num >= 0.01 ? 4 : 6;
  return `¥${formatLocaleFixed(num, digits)}`;
}

export function formatExchangeRate(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num.toFixed(4) : '未知';
}

export function formatContextTier(value) {
  return value === 'short' ? '短' : value === 'long' ? '长' : '标准';
}

export function formatUnitPrice(cost, component) {
  if (!cost?.available) return '未知';
  if (
    cost.normalizedModel === 'multiple' ||
    (Array.isArray(cost.contextTiers) && cost.contextTiers.length > 1)
  ) {
    return '未知';
  }
  const rate = Number(cost.rates?.[component]);
  const exchangeRate = cost.currency === 'USD' ? Number(cost.exchangeRate?.rate) : 1;
  if (!Number.isFinite(rate) || rate < 0 || !Number.isFinite(exchangeRate) || exchangeRate <= 0) {
    return '未知';
  }
  return `${formatCny(rate * exchangeRate)}/M`;
}

export function formatPricingSourceNote(cost) {
  if (!cost?.available) {
    return cost?.reason || '当前模型没有可用价格';
  }
  const providers = Array.isArray(cost.providers) && cost.providers.length > 0
    ? cost.providers
    : cost.provider
      ? [cost.provider]
      : [];
  const labelMap = {
    google: 'Google Gemini 标准 API 价格',
    anthropic: 'Anthropic Claude 标准 API 价格',
    'vertex-maas': 'Google Vertex AI 标准 API 价格',
  };
  const baseLabel =
    providers.length === 1
      ? labelMap[providers[0]] || '标准 API 价格'
      : '多供应商标准 API 价格';

  if (cost.hasTieredContext) {
    const tiers = Array.isArray(cost.contextTiers) ? cost.contextTiers : [];
    const hasShort = tiers.includes('short');
    const hasLong = tiers.includes('long');
    const tierText = hasShort && hasLong ? '混合上下文' : hasLong ? '长上下文' : '短上下文';
    return `${baseLabel} · ${tierText}`;
  }
  return baseLabel;
}

export function resolveTurnElapsedMs(
  turn,
  { liveRunning = false, nowMs = 0, minWallDurationMs = 0 } = {}
) {
  if (!turn) return 0;
  const recordedWallMs = Number(turn.wallDurationMs) > 0 ? Number(turn.wallDurationMs) : 0;
  const floorWallMs = Math.max(
    recordedWallMs,
    Number(minWallDurationMs) > 0 ? Number(minWallDurationMs) : 0
  );
  if (liveRunning) {
    const startMs = Number(turn.startTsMs);
    const liveWallMs =
      startMs > 0 && Number.isFinite(nowMs) && nowMs > startMs
        ? Math.round(nowMs - startMs)
        : 0;
    const activeWallMs = Math.max(floorWallMs, liveWallMs);
    if (activeWallMs > 0) return activeWallMs;
  }
  if (floorWallMs > 0) return floorWallMs;
  const totalDurMs = Number(turn.totalDurationMs);
  return Number.isFinite(totalDurMs) && totalDurMs > 0 ? totalDurMs : 0;
}

export function formatTurnSummary(turn, options = {}) {
  const liveRunning = Boolean(options?.liveRunning);
  const effectiveCompleted = liveRunning ? false : Boolean(turn?.completed);
  const elapsedMs = resolveTurnElapsedMs(turn, options);
  const elapsed = formatElapsedDuration(elapsedMs);
  if (!turn || Number(turn.totalTokens) <= 0) {
    if (effectiveCompleted) {
      return '本轮未获取到 Token 数据 · 价格无法计算';
    }
    return elapsed
      ? `本轮耗时 ${elapsed} · 等待 Token 数据 · 价格待计算`
      : '等待 Token 数据 · 价格待计算';
  }
  const cacheHit = formatCacheHitRate(turn.cachedInputTokens, turn.inputTokens);
  const firstToken = formatDurationMs(turn.firstTokenLatencyMs);
  const speed = formatRate(turn.outputSpeed);
  const cost = turn.cost;
  const priceText = cost?.available ? `价格 ${formatCny(cost.totalCny)}` : '价格暂不可算';

  return [
    ...(elapsed ? [`本轮耗时 ${elapsed}`] : []),
    `Token ${formatTokenCount(turn.totalTokens)}`,
    `缓存命中率 ${cacheHit}`,
    ...(firstToken ? [`首字 ${firstToken}`] : []),
    ...(speed ? [`速率 ${speed}`] : []),
    priceText,
  ].join(' · ');
}

/**
 * Format a Codex-style request title from tool calls or planner output flags.
 */
export function formatCallDetailTitle(detail, isLatestCompleted = false) {
  const calls = Array.isArray(detail?.toolCalls) ? detail.toolCalls : [];
  if (calls.length > 0) {
    const counts = new Map();
    for (const c of calls) {
      const name = String(c?.toolName || '').trim() || '工具调用';
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    return [...counts]
      .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
      .join('、');
  }
  if (isLatestCompleted && detail?.hasVisibleText) return '最终回复';
  if (detail?.followsToolResult) return detail?.hasVisibleText ? '生成回复' : '处理工具结果';
  return detail?.hasVisibleText ? '生成回复' : '模型请求';
}

/**
 * Strip effort/mode suffixes like "(High)", "High", "Medium", "Low", "Thinking" for model matching.
 */
export function normalizeModelLabel(label) {
  return String(label || '')
    .replace(/\((?:low|medium|high|xhigh|max)(?:\s+(?:thinking|思考))?\)/gi, '')
    .replace(/\((?:thinking|思考)\)/gi, '')
    .replace(/\b(?:low|medium|high|xhigh|max|thinking)\b/gi, '')
    .replace(/思考/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Compute starting index into DB turns when older DOM turns are paginated at the top.
 */
export function computeTurnPairingOffset(domTurnCount, dbTurnCount) {
  const dom = Number(domTurnCount) || 0;
  const db = Number(dbTurnCount) || 0;
  if (dom <= 0 || db <= 0) return 0;
  return db >= dom ? db - dom : 0;
}

/**
 * Pick the quota group matching the currently selected model name, falling back to the first group with buckets.
 */
export function matchQuotaGroup(groups, selectedModelLabel = '') {
  const list = Array.isArray(groups) ? groups.filter((g) => Array.isArray(g?.buckets) && g.buckets.length > 0) : [];
  if (list.length === 0) return null;
  const baseModel = normalizeModelLabel(selectedModelLabel);
  if (!baseModel) return list[0];

  // Exact/substring match against group displayName or description (e.g. "Gemini 4 Argon" or "Models within this group: Gemini 4 Hydrogen, ...")
  const direct = list.find((g) => {
    const hay = `${g.displayName || ''} ${g.description || ''}`.toLowerCase();
    return hay.includes(baseModel);
  });
  if (direct) return direct;

  // Fallback keyword match for Claude / GPT / Gemini
  if (/\b(?:claude|gpt|opus|sonnet|haiku)\b/i.test(baseModel)) {
    const thirdParty = list.find((g) => /claude|gpt/i.test(`${g.displayName || ''} ${g.description || ''}`));
    if (thirdParty) return thirdParty;
  }
  if (/argon/i.test(baseModel)) {
    const argon = list.find((g) => /argon/i.test(`${g.displayName || ''} ${g.description || ''}`));
    if (argon) return argon;
  }
  if (/gemini/i.test(baseModel)) {
    const gemini = list.find((g) => /gemini\s*models/i.test(g.displayName || '')) || list.find((g) => /gemini/i.test(g.displayName || ''));
    if (gemini) return gemini;
  }

  return list[0];
}

export function extractQuotaBuckets(group) {
  const buckets = Array.isArray(group?.buckets) ? group.buckets : [];
  let fiveHour = null;
  let weekly = null;

  for (const b of buckets) {
    if (b?.disabled) continue;
    const win = String(b?.window || '').toLowerCase();
    const id = String(b?.bucketId || '').toLowerCase();
    if (!fiveHour && (win === '5h' || id.endsWith('-5h') || /5\s*h|five\s*hour/i.test(b?.displayName || ''))) {
      fiveHour = b;
    } else if (!weekly && (win === 'weekly' || id.endsWith('-weekly') || /weekly/i.test(b?.displayName || ''))) {
      weekly = b;
    }
  }
  return { fiveHour, weekly };
}

export function orderQuotaBuckets(buckets) {
  const list = Array.isArray(buckets) ? buckets.filter((b) => b && !b.disabled) : [];
  const rank = (b) => {
    const win = String(b?.window || '').toLowerCase();
    const id = String(b?.bucketId || '').toLowerCase();
    const name = String(b?.displayName || '');
    if (win === '5h' || id.endsWith('-5h') || /5\s*h|five\s*hour/i.test(name)) return 0;
    if (win === 'weekly' || id.endsWith('-weekly') || /weekly/i.test(name)) return 1;
    return 2;
  };
  return list.slice().sort((a, b) => rank(a) - rank(b));
}

export function formatRemainingPercent(fraction) {
  const n = Number(fraction);
  if (!Number.isFinite(n)) return '--';
  const pct = Math.max(0, Math.min(100, Math.round(n * 100)));
  return `${pct}%`;
}

export function quotaLevelClass(fraction) {
  const n = Number(fraction);
  if (!Number.isFinite(n)) return 'aq-lvl-muted';
  if (n < 0.1) return 'aq-lvl-crit';
  if (n < 0.25) return 'aq-lvl-warn';
  return 'aq-lvl-ok';
}

export function formatResetCountdownParts(
  resetTimeIso,
  nowMs = Date.now(),
  { includeDate = false } = {}
) {
  if (!resetTimeIso) return { countdown: '', targetStr: '', text: '' };
  const ts = Date.parse(resetTimeIso);
  if (!Number.isFinite(ts)) return { countdown: '', targetStr: '', text: '' };
  const diffMs = ts - nowMs;
  if (diffMs <= 0) {
    return { countdown: '即将重置', targetStr: '', text: '即将重置' };
  }
  const pad2 = (n) => String(n).padStart(2, '0');
  const totalMins = Math.floor(diffMs / 60_000);
  const days = Math.floor(totalMins / 1440);
  const hours = Math.floor((totalMins % 1440) / 60);
  const mins = totalMins % 60;
  let countdown = '';
  if (totalMins <= 0) {
    countdown = '<1m';
  } else if (days > 0) {
    countdown = `${days}d${pad2(hours)}h`;
  } else {
    countdown = `${hours}h${pad2(mins)}m`;
  }
  const nowDate = new Date(nowMs);
  const targetDate = new Date(ts);
  const hhmm = `${pad2(targetDate.getHours())}:${pad2(targetDate.getMinutes())}`;
  const mmdd = `${pad2(targetDate.getMonth() + 1)}/${pad2(targetDate.getDate())}`;
  const sameDay =
    nowDate.getFullYear() === targetDate.getFullYear() &&
    nowDate.getMonth() === targetDate.getMonth() &&
    nowDate.getDate() === targetDate.getDate();
  const targetStr = sameDay && !includeDate ? hhmm : `${mmdd} ${hhmm}`;
  return { countdown, targetStr, text: `${countdown} (${targetStr})` };
}

export function formatResetCountdown(resetTimeIso, nowMs = Date.now(), { includeDate = false } = {}) {
  return formatResetCountdownParts(resetTimeIso, nowMs, { includeDate }).text;
}

export function formatContextCompact(tokens) {
  const n = Number(tokens);
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return `${Math.round(n)}`;
}

export function formatContextK(tokens) {
  const n = Number(tokens);
  if (!Number.isFinite(n) || n < 0) return '0k';
  return `${Math.round(n / 1000)}k`;
}

export function contextLevelClass(usedTokens, maxTokens) {
  const used = Number(usedTokens);
  const max = Number(maxTokens);
  if (!Number.isFinite(used) || !Number.isFinite(max) || max <= 0) return 'aq-lvl-muted';
  const ratio = used / max;
  if (ratio >= 0.9) return 'aq-lvl-crit';
  if (ratio >= 0.75) return 'aq-lvl-warn';
  return 'aq-lvl-ok';
}

/**
 * Choose quota/context chip presentation based on available footer width:
 * wide -> quota pill + context ring, squeezed -> dual progress rings, cramped -> single merged ring.
 */
export function resolveComposerChipMode({
  footerWidth = 0,
  nativeRightWidth = 0,
  hasContextChip = true,
} = {}) {
  const totalW = Number(footerWidth);
  if (!Number.isFinite(totalW) || totalW <= 0) return 'pill';
  const rightW = Number.isFinite(nativeRightWidth) && nativeRightWidth > 0 ? nativeRightWidth : 0;
  const available = totalW - rightW;
  if (!hasContextChip) {
    return available >= 255 ? 'pill' : 'single';
  }
  if (available >= 280) return 'pill';
  if (available >= 200) return 'rings';
  return 'single';
}

/**
 * Resolve a concise subscription label from Antigravity GetUserStatus payload.
 * Prefers `userTier` over legacy `planStatus.planInfo.planName`, which frequently stays "Pro".
 */
export function resolveUserPlanLabel(userStatus) {
  const tier =
    userStatus?.userTier && typeof userStatus.userTier === 'object' ? userStatus.userTier : null;
  if (tier) {
    const id = String(tier.id || '').trim().toLowerCase();
    const rawName = String(tier.description || tier.name || '').trim();
    const upgradeText = String(tier.upgradeSubscriptionText || '').trim();

    if (id === 'g1-ultra-lite-tier') return 'Ultra 5x';
    if (id === 'g1-ultra-tier') return 'Ultra 20x';
    if (id === 'g1-pro-tier') return 'Pro';
    if (id === 'free-tier' || id === 'standard-tier') return 'Free';

    if (id.includes('ultra')) {
      if (
        id.includes('lite') ||
        /5x/i.test(id) ||
        /higher\s+google\s+ai\s+ultra/i.test(upgradeText)
      ) {
        return 'Ultra 5x';
      }
      if (/20x/i.test(id)) {
        return 'Ultra 20x';
      }
      if (rawName) {
        return rawName.replace(/^Google\s+AI\s+/i, '').trim() || 'Ultra';
      }
      return 'Ultra';
    }

    if (rawName) {
      if (
        /^Google\s+AI\s+Ultra$/i.test(rawName) &&
        /higher\s+google\s+ai\s+ultra/i.test(upgradeText)
      ) {
        return 'Ultra 5x';
      }
      const compact = rawName.replace(/^Google\s+AI\s+/i, '').trim();
      return compact || rawName;
    }

    if (id) {
      return id.replace(/-tier$/i, '');
    }
  }

  return String(userStatus?.planStatus?.planInfo?.planName || '').trim();
}

/**
 * Determine whether an account's primary Gemini model quota is currently available
 * (considering resetTime expiration for cached snapshots of non-active accounts)
 * and compute a concise countdown text for next availability or quota reset.
 */
export function resolveGeminiQuotaAvailability(quota, { isCurrent = false, nowMs = Date.now() } = {}) {
  const groups = Array.isArray(quota?.groups) ? quota.groups : [];
  if (groups.length === 0) {
    return {
      state: 'unknown',
      dotTone: 'unknown',
      unstarted: false,
      label: '暂无 Gemini 额度记录',
      nextAvailableAt: null,
      nextResetAt: null,
      countdownText: '暂无 Gemini 额度记录',
      timeText: '',
      bucketBadges: [],
    };
  }

  const pickValidBuckets = (group) =>
    orderQuotaBuckets(
      (Array.isArray(group?.buckets) ? group.buckets : []).filter(
        (b) => b && !b.disabled && Number.isFinite(Number(b.remainingFraction))
      )
    );

  const primary =
    groups.find((g) => {
      const name = String(g?.displayName || '').trim();
      if (/^gemini\s*models$/i.test(name)) return pickValidBuckets(g).length > 0;
      const buckets = pickValidBuckets(g);
      return buckets.some((b) => /^gemini-(?:5h|weekly)$/i.test(String(b.bucketId || '').trim()));
    }) ||
    groups.find((g) => {
      const name = String(g?.displayName || '').trim();
      return /gemini/i.test(name) && !/argon/i.test(name) && pickValidBuckets(g).length > 0;
    }) ||
    groups.find((g) => /gemini/i.test(String(g?.displayName || '')) && pickValidBuckets(g).length > 0);

  if (!primary) {
    return {
      state: 'unknown',
      dotTone: 'unknown',
      unstarted: false,
      label: '暂无 Gemini 额度记录',
      nextAvailableAt: null,
      nextResetAt: null,
      countdownText: '暂无 Gemini 额度记录',
      timeText: '',
      bucketBadges: [],
    };
  }

  const buckets = pickValidBuckets(primary);
  if (buckets.length === 0) {
    return {
      state: 'unknown',
      dotTone: 'unknown',
      unstarted: false,
      label: '暂无 Gemini 额度记录',
      nextAvailableAt: null,
      nextResetAt: null,
      countdownText: '暂无 Gemini 额度记录',
      timeText: '',
      bucketBadges: [],
    };
  }

  let allAvailable = true;
  let anyInferredReset = false;
  let latestDepletedResetTs = 0;
  let latestDepletedResetIso = '';
  let fiveHourInfo = null;
  let weeklyInfo = null;
  let firstInfo = null;
  const parts = [];
  for (const b of buckets) {
    const win = String(b.window || '').toLowerCase();
    const winLabel = win === '5h' ? '5h' : win === 'weekly' ? '周' : String(b.displayName || b.bucketId || '配额');
    const resetIso = String(b.resetTime || '').trim();
    const resetTs = Date.parse(resetIso);
    const hasReset = Number.isFinite(resetTs);
    const expired = !isCurrent && hasReset && resetTs <= nowMs;
    const frac = Number(b.remainingFraction);
    const info = { b, win, winLabel, resetIso, resetTs: hasReset ? resetTs : null, expired, frac };
    if (!firstInfo) firstInfo = info;
    if (win === '5h' && !fiveHourInfo) fiveHourInfo = info;
    if (win === 'weekly' && !weeklyInfo) weeklyInfo = info;

    if (expired) {
      anyInferredReset = true;
      parts.push(`${winLabel} 已重置`);
    } else {
      // Exhausted Antigravity quotas often leave <= 1% residual fraction (< 0.015 after % rounding).
      if (frac < 0.015) {
        allAvailable = false;
        if (hasReset && resetTs > latestDepletedResetTs) {
          latestDepletedResetTs = resetTs;
          latestDepletedResetIso = resetIso;
        }
      }
      parts.push(`${winLabel} ${formatRemainingPercent(frac)}`);
    }
  }

  const formatCountdownOnly = (iso, ts) => {
    if (!iso || !Number.isFinite(ts)) return '';
    if (ts - nowMs <= 0) return '<1m';
    return formatResetCountdownParts(iso, nowMs, { includeDate: false }).countdown;
  };

  const formatBucketPct = (info) =>
    info ? formatRemainingPercent(info.expired ? 1 : info.frac) : '';
  const displayedInfos = [fiveHourInfo, weeklyInfo].filter(Boolean);
  const badgeInfos = displayedInfos.length > 0 ? displayedInfos : firstInfo ? [firstInfo] : [];
  const bucketBadges = badgeInfos.map((info) => {
    const effectiveFrac = info.expired ? 1 : info.frac;
    const lvl = quotaLevelClass(effectiveFrac);
    const tone = lvl === 'aq-lvl-crit' ? 'crit' : lvl === 'aq-lvl-warn' ? 'warn' : 'ok';
    return {
      text: formatRemainingPercent(effectiveFrac),
      tone,
    };
  });
  const dotTone =
    !allAvailable || bucketBadges.some((b) => b.tone === 'crit')
      ? 'crit'
      : bucketBadges.some((b) => b.tone === 'warn')
        ? 'warn'
        : 'ok';
  const quotaParts = [
    formatBucketPct(fiveHourInfo),
    formatBucketPct(weeklyInfo),
    ...(fiveHourInfo || weeklyInfo ? [] : parts),
  ].filter(Boolean);

  const detail = parts.join(' / ');
  if (allAvailable) {
    const isBucketInfoUnstarted = (info) => {
      if (!info) return false;
      if (info.expired) return true;
      const cadence = info.win === '5h' ? '5h' : info.win === 'weekly' ? 'weekly' : 'bucket';
      return isCurrent
        ? isQuotaBucketUnstarted(info.b, cadence, nowMs)
        : info.frac >= 0.999999 && !/used\s+some|consumed/i.test(String(info.b?.description || ''));
    };
    const countdownTarget =
      [fiveHourInfo, weeklyInfo].find(
        (info) => info && !info.expired && !isBucketInfoUnstarted(info) && info.resetTs && info.resetTs > nowMs
      ) || null;
    const primaryInfo = fiveHourInfo || weeklyInfo || firstInfo || null;
    const unstarted = isBucketInfoUnstarted(primaryInfo);
    const nextResetAt =
      countdownTarget?.resetTs || (primaryInfo && !primaryInfo.expired ? primaryInfo.resetTs : null);
    const timeText = countdownTarget
      ? formatCountdownOnly(countdownTarget.resetIso, countdownTarget.resetTs)
      : '';
    const countdownText = [...quotaParts, timeText].filter(Boolean).join(' · ') || '100%';

    return {
      state: 'available',
      dotTone,
      unstarted,
      label: anyInferredReset ? `Gemini 预计可用（${detail}）` : `Gemini 可用（${detail}）`,
      nextAvailableAt: null,
      nextResetAt,
      countdownText,
      timeText,
      bucketBadges,
    };
  }

  const nextAvailableAt = latestDepletedResetTs > 0 ? latestDepletedResetTs : null;
  const depletedTimeText = latestDepletedResetIso
    ? formatCountdownOnly(latestDepletedResetIso, latestDepletedResetTs)
    : '';
  const countdownText = [...quotaParts, depletedTimeText].filter(Boolean).join(' · ') || '0%';
  return {
    state: 'depleted',
    dotTone: 'crit',
    unstarted: false,
    label: `Gemini 已用完（${detail}）`,
    nextAvailableAt,
    nextResetAt: nextAvailableAt,
    countdownText,
    timeText: depletedTimeText,
    bucketBadges,
  };
}

export function resolveQuotaPoolKey(group) {
  const name = String(group?.displayName || '').trim().toLowerCase();
  if (name) return name;
  const buckets = orderQuotaBuckets(group?.buckets);
  if (buckets.length > 0) {
    return `pool:${buckets.map((b) => String(b.bucketId || '').trim().toLowerCase()).filter(Boolean).sort().join('+')}`;
  }
  return '';
}

export function classifyQuotaGroupKeepAlive(group) {
  const poolKey = resolveQuotaPoolKey(group);
  if (!poolKey) return null;
  const buckets = orderQuotaBuckets(group?.buckets);
  if (buckets.length === 0) return null;

  const { fiveHour, weekly } = extractQuotaBuckets({ buckets });
  if (fiveHour) {
    return {
      poolKey,
      cadence: '5h',
      cadenceLabel: '唤醒',
      targetBucket: fiveHour,
      guardWeeklyBucket: weekly || null,
    };
  }
  if (weekly) {
    return {
      poolKey,
      cadence: 'weekly',
      cadenceLabel: '唤醒',
      targetBucket: weekly,
      guardWeeklyBucket: null,
    };
  }
  return {
    poolKey,
    cadence: 'bucket',
    cadenceLabel: '唤醒',
    targetBucket: buckets[0],
    guardWeeklyBucket: null,
  };
}

function parseGroupModelPrefixes(group) {
  const desc = String(group?.description || '');
  const m = desc.match(/Models within this group:\s*([^\n]+)/i);
  if (m && m[1]) {
    return m[1]
      .replace(/\.\s*$/, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const name = String(group?.displayName || '').trim();
  return name ? [name] : [];
}

function scoreKeepAliveModelCost(label, quotaInfo) {
  let score = 0;
  const text = String(label || '');
  const hasQuota =
    quotaInfo &&
    (Number.isFinite(Number(quotaInfo.remainingFraction)) || Boolean(quotaInfo.resetTime));
  if (!hasQuota) score += 200;
  if (/\bOrchestrator\b/i.test(text)) score += 100;

  if (/\b(flash|lite|mini)\b/i.test(text)) score -= 30;
  else if (/\bgpt-oss\b/i.test(text)) score -= 20;
  else if (/\bsonnet\b/i.test(text)) score -= 10;
  else if (/\bneon\b/i.test(text)) score += 5;
  else if (/\bopus\b/i.test(text)) score += 25;

  if (/\blow\b/i.test(text)) score += 0;
  else if (/\bmedium\b/i.test(text)) score += 1;
  else if (/\bhigh\b/i.test(text)) score += 2;
  else if (/\bxhigh\b/i.test(text)) score += 3;
  else score += 4;
  return score;
}

export function listModelsForQuotaGroup(group, clientModelConfigs) {
  const configs = Array.isArray(clientModelConfigs) ? clientModelConfigs : [];
  if (configs.length === 0) return [];
  const plan = classifyQuotaGroupKeepAlive(group);
  const prefixes = parseGroupModelPrefixes(group).map((p) => p.toLowerCase());
  const groupName = String(group?.displayName || '').trim().toLowerCase();
  const isArgonPool = /\bargon\b/.test(groupName);
  const targetResetTs = Date.parse(String(plan?.targetBucket?.resetTime || ''));

  const byId = new Map();
  const addMatch = (cfg) => {
    const modelId = String(cfg?.modelOrAlias?.model || cfg?.model || '').trim();
    const label = String(cfg?.label || '').trim();
    if (!modelId || !label || byId.has(modelId)) return;
    byId.set(modelId, {
      modelId,
      label,
      remainingFraction: Number.isFinite(Number(cfg?.quotaInfo?.remainingFraction))
        ? Number(cfg.quotaInfo.remainingFraction)
        : null,
      resetTime: String(cfg?.quotaInfo?.resetTime || '').trim(),
      score: scoreKeepAliveModelCost(label, cfg?.quotaInfo),
    });
  };

  for (const cfg of configs) {
    const label = String(cfg?.label || '').trim();
    const low = label.toLowerCase();
    if (!low) continue;
    const prefixHit = prefixes.some((p) => low === p || low.startsWith(`${p} (`) || low.startsWith(`${p} `));
    const argonHit = isArgonPool && /\bargon\b/i.test(label);
    if (prefixHit || argonHit) {
      addMatch(cfg);
    }
  }

  // Fallback by matching quota bucket resetTime + family when description doesn't enumerate model names
  if (byId.size === 0 && Number.isFinite(targetResetTs)) {
    const isGeminiPool = /gemini/.test(groupName) && !isArgonPool;
    const isThirdPartyPool = /claude|gpt/.test(groupName);
    for (const cfg of configs) {
      const label = String(cfg?.label || '').trim();
      const mResetTs = Date.parse(String(cfg?.quotaInfo?.resetTime || ''));
      if (!Number.isFinite(mResetTs) || Math.abs(mResetTs - targetResetTs) > 5000) continue;
      if (isArgonPool && !/\bargon\b/i.test(label)) continue;
      if (isGeminiPool && (/claude|gpt/i.test(label) || /\bargon\b/i.test(label))) continue;
      if (isThirdPartyPool && !/claude|gpt/i.test(label)) continue;
      addMatch(cfg);
    }
  }

  return [...byId.values()].sort((a, b) => a.score - b.score || a.label.localeCompare(b.label));
}

export function pickKeepAliveModelForGroup(group, clientModelConfigs, preferredModelId = '') {
  const models = listModelsForQuotaGroup(group, clientModelConfigs);
  if (models.length === 0) return null;
  const pref = String(preferredModelId || '').trim();
  if (pref) {
    const matched = models.find((m) => m.modelId === pref);
    if (matched) return matched;
  }
  return models[0];
}

export function isQuotaBucketUnstarted(bucket, cadence = '5h', nowMs = Date.now()) {
  if (!bucket || typeof bucket !== 'object') return false;
  const frac = Number(bucket.remainingFraction);
  if (!Number.isFinite(frac) || frac < 0.999999) return false;
  if (/used\s+some|consumed/i.test(String(bucket.description || ''))) {
    return false;
  }
  const resetTs = Date.parse(String(bucket.resetTime || ''));
  const windowMs =
    cadence === '5h'
      ? 5 * 3600_000
      : cadence === 'weekly'
        ? 7 * 24 * 3600_000
        : 0;
  if (windowMs > 0 && Number.isFinite(resetTs)) {
    const remainMs = resetTs - nowMs;
    // Unstarted buckets float near the full window length (now + 5h or now + 7d).
    // Once consumed, resetTime locks and counts down below windowMs - 3min.
    if (remainMs > 0 && remainMs < windowMs - 180_000) {
      return false;
    }
  }
  return true;
}

export const KEEP_ALIVE_COOLDOWN_MS = 300_000;

export function evaluateQuotaPoolKeepAlive({
  group,
  enabled = false,
  poolState = null,
  nowMs = Date.now(),
  cooldownMs = KEEP_ALIVE_COOLDOWN_MS,
} = {}) {
  const plan = classifyQuotaGroupKeepAlive(group);
  if (!plan) return { eligible: false, reason: 'no_bucket', plan: null };
  if (!enabled) return { eligible: false, reason: 'disabled', plan };
  if (poolState?.inFlight) return { eligible: false, reason: 'in_flight', plan };
  if (poolState?.backoffUntil && nowMs < Number(poolState.backoffUntil)) {
    return { eligible: false, reason: 'backoff', plan };
  }
  if (poolState?.lastTriggeredAt && nowMs - Number(poolState.lastTriggeredAt) < cooldownMs) {
    return { eligible: false, reason: 'cooldown', plan };
  }
  if (
    plan.guardWeeklyBucket &&
    Number(plan.guardWeeklyBucket.remainingFraction) < 0.02
  ) {
    return { eligible: false, reason: 'weekly_depleted', plan };
  }
  if (!isQuotaBucketUnstarted(plan.targetBucket, plan.cadence, nowMs)) {
    return { eligible: false, reason: 'already_active', plan };
  }
  return { eligible: true, reason: 'unstarted', plan };
}
