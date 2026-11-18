/**
 * Pure formatting and quota matching helpers shared between tests and injected browser script.
 */

export function formatTokenCount(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return '0.00M';
  return `${(num / 1_000_000).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 3,
  })}M`;
}

export function formatDurationMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1_000;
  const digits = seconds >= 100 ? 0 : 1;
  return `${seconds.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}s`;
}

export function formatRate(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  const digits = num >= 100 ? 0 : num >= 10 ? 1 : 2;
  return `${num.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })} tok/s`;
}

export function formatCacheHitRate(cachedTokens, inputTokens) {
  const input = Number(inputTokens);
  const cached = Number(cachedTokens);
  if (!Number.isFinite(input) || input <= 0 || !Number.isFinite(cached) || cached < 0) {
    return '—';
  }
  return `${((cached / input) * 100).toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`;
}

export function formatTurnSummary(turn) {
  if (!turn || Number(turn.totalTokens) <= 0) {
    return turn?.completed ? '本轮未获取到 Token 数据' : '等待 Token 数据…';
  }
  const cacheHit = formatCacheHitRate(turn.cachedInputTokens, turn.inputTokens);
  const firstToken = formatDurationMs(turn.firstTokenLatencyMs);
  const speed = formatRate(turn.outputSpeed);

  return [
    `本轮 Token ${formatTokenCount(turn.totalTokens)}`,
    `缓存命中率 ${cacheHit}`,
    `累计 ${formatTokenCount(turn.cumulativeTotalTokens)}`,
    ...(firstToken ? [`首字 ${firstToken}`] : []),
    ...(speed ? [`速率 ${speed}`] : []),
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
    .replace(/\((?:low|medium|high|xhigh|max)(?:\s+thinking)?\)/gi, '')
    .replace(/\b(?:low|medium|high|xhigh|max)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
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

export function formatResetCountdown(resetTimeIso, nowMs = Date.now()) {
  if (!resetTimeIso) return '';
  const ts = Date.parse(resetTimeIso);
  if (!Number.isFinite(ts)) return '';
  const diffMs = ts - nowMs;
  if (diffMs <= 0) return '即将重置';
  const totalMins = Math.floor(diffMs / 60_000);
  const days = Math.floor(totalMins / 1440);
  const hours = Math.floor((totalMins % 1440) / 60);
  const mins = totalMins % 60;
  if (days > 0) return hours > 0 ? `${days}天${hours}小时后重置` : `${days}天后重置`;
  if (hours > 0) return mins > 0 ? `${hours}小时${mins}分后重置` : `${hours}小时后重置`;
  return mins > 0 ? `${mins}分钟后重置` : '<1分钟后重置';
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
