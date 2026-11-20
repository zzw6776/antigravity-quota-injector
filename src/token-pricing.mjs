import fs from 'node:fs/promises';
import path from 'node:path';

const MILLION = 1_000_000;
export const LONG_CONTEXT_THRESHOLD = 200_000;

const EXCHANGE_RATE_REFRESH_MS = 6 * 60 * 60 * 1000;
const EXCHANGE_RATE_RETRY_MS = 30 * 60 * 1000;
const EXCHANGE_RATE_URL = 'https://www.safe.gov.cn/AppStructured/hlw/RMBQuery.do';
const EXCHANGE_RATE_SOURCE = '国家外汇管理局人民币汇率中间价';

export const FALLBACK_EXCHANGE_RATE = Object.freeze({
  rate: 6.7118,
  date: '2026-11-18',
  fetchedAt: 0,
  source: EXCHANGE_RATE_SOURCE,
  sourceUrl: EXCHANGE_RATE_URL,
  fallback: true,
});

const USAGE_FIELDS = [
  'inputTokens',
  'uncachedInputTokens',
  'cachedInputTokens',
  'outputTokens',
  'thinkingTokens',
  'responseTokens',
  'totalTokens',
];

function priceTier(ordinaryInput, cachedInput, output) {
  return Object.freeze({ ordinaryInput, cachedInput, output });
}

function modelEntry(provider, short, long = null) {
  return Object.freeze({ provider, short, long });
}

/**
 * Official standard API USD rates per 1M tokens, checked 2026-11-19:
 * - Google Gemini API / Vertex AI Global: https://ai.google.dev/gemini-api/docs/pricing
 * - Anthropic Claude API: https://docs.anthropic.com/en/docs/about-claude/pricing
 * - Google Cloud Vertex AI MaaS (GPT-OSS 120B): https://cloud.google.com/vertex-ai/generative-ai/pricing
 *
 * Introductory rates published for Nov–Dec 2026:
 * - Gemini 4 Carbon & Argon: $2.00 input / $0.10 cache read / $10.00 output (through 2026-11-30)
 * - Gemini 3.8 Flash & 3.7 Flash: $0.75 input / $0.075 cache read / $3.75 output (through 2026-12-31)
 */
export const MODEL_PRICES = Object.freeze({
  'gemini-4-neon': modelEntry('google', priceTier(3.0, 0.15, 15.0)),
  'gemini-4-carbon': modelEntry('google', priceTier(2.0, 0.1, 10.0)),
  'gemini-4-argon': modelEntry('google', priceTier(2.0, 0.1, 10.0)),
  'gemini-4-hydrogen': modelEntry('google', priceTier(1.5, 0.075, 7.5)),
  'gemini-3.8-flash': modelEntry('google', priceTier(0.75, 0.075, 3.75)),
  'gemini-3.7-flash': modelEntry('google', priceTier(0.75, 0.075, 3.75)),
  'gemini-3.6-flash': modelEntry('google', priceTier(0.75, 0.075, 3.75)),
  'gemini-3.5-flash': modelEntry('google', priceTier(1.5, 0.15, 9.0)),
  'gemini-3.1-pro': modelEntry(
    'google',
    priceTier(2.0, 0.2, 12.0),
    priceTier(4.0, 0.4, 18.0)
  ),
  'gemini-2.5-pro': modelEntry(
    'google',
    priceTier(1.25, 0.125, 10.0),
    priceTier(2.5, 0.25, 15.0)
  ),
  'gemini-2.5-flash': modelEntry('google', priceTier(0.3, 0.03, 2.5)),
  'claude-opus-5.5': modelEntry('anthropic', priceTier(4.0, 0.2, 20.0)),
  'claude-sonnet-5.5': modelEntry('anthropic', priceTier(2.0, 0.1, 10.0)),
  'claude-opus-4.6': modelEntry('anthropic', priceTier(5.0, 0.5, 25.0)),
  'claude-sonnet-4.6': modelEntry('anthropic', priceTier(3.0, 0.3, 15.0)),
  'claude-opus-4.5': modelEntry('anthropic', priceTier(5.0, 0.5, 25.0)),
  'claude-sonnet-4.5': modelEntry('anthropic', priceTier(3.0, 0.3, 15.0)),
  'gpt-oss-120b': modelEntry('vertex-maas', priceTier(0.09, 0.09, 0.36)),
});

const GENERIC_SLUGS = new Set([
  '',
  'gemini-default',
  'gemini-pro-default',
  'gemini-pro-orchestrator-g1-pro',
  'gemini-flash-worker-agy',
]);

function matchSingleModelToken(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  if (MODEL_PRICES[s]) return s;

  if (/gemini[-\s]*4[-\s]*neon|orchestrator\s*\(\s*neon\s*\)/.test(s)) return 'gemini-4-neon';
  if (/gemini[-\s]*4[-\s]*carbon|orchestrator\s*\(\s*carbon\s*\)/.test(s)) return 'gemini-4-carbon';
  if (/gemini[-\s]*4[-\s]*argon|orchestrator\s*\(\s*argon\s*\)|gemini-pro-orchestrator/.test(s)) {
    return 'gemini-4-argon';
  }
  if (/gemini[-\s]*4[-\s]*hydrogen|gemini-flash-worker-agy/.test(s)) return 'gemini-4-hydrogen';

  if (/gemini[-\s]*3\.8[-\s]*flash/.test(s)) return 'gemini-3.8-flash';
  if (/gemini[-\s]*3\.7[-\s]*flash/.test(s)) return 'gemini-3.7-flash';
  if (/gemini[-\s]*3\.6[-\s]*flash/.test(s)) return 'gemini-3.6-flash';
  if (/gemini[-\s]*3(?:\.5)?[-\s]*flash/.test(s)) return 'gemini-3.5-flash';
  if (/gemini[-\s]*3\.1[-\s]*pro/.test(s)) return 'gemini-3.1-pro';
  if (/gemini[-\s]*2\.5[-\s]*pro/.test(s)) return 'gemini-2.5-pro';
  if (/gemini[-\s]*2\.5[-\s]*flash/.test(s)) return 'gemini-2.5-flash';

  if (/claude[-\s]*opus[-\s]*5[.-]5/.test(s)) return 'claude-opus-5.5';
  if (/claude[-\s]*sonnet[-\s]*5[.-]5/.test(s)) return 'claude-sonnet-5.5';
  if (/claude[-\s]*opus[-\s]*4[.-]6/.test(s)) return 'claude-opus-4.6';
  if (/claude[-\s]*sonnet[-\s]*4[.-]6/.test(s)) return 'claude-sonnet-4.6';
  if (/claude[-\s]*opus[-\s]*4[.-]5/.test(s)) return 'claude-opus-4.5';
  if (/claude[-\s]*sonnet[-\s]*4[.-]5/.test(s)) return 'claude-sonnet-4.5';

  if (/gpt[-_\s]*oss[-_\s]*120b/.test(s)) return 'gpt-oss-120b';

  if (s === 'gemini-pro-default') return 'gemini-3.1-pro';
  if (s === 'gemini-default') return 'gemini-3.5-flash';
  return '';
}

/**
 * Normalize raw protobuf model slug (`chat[19]`) and display label (`chat[21]`) to a canonical pricing key.
 */
export function normalizePricingModel(model = '', modelLabel = '') {
  const slug = String(model || '').trim();
  const label = String(modelLabel || '').trim();

  const slugLower = slug.toLowerCase();
  if ((GENERIC_SLUGS.has(slugLower) || slugLower.includes('orchestrator')) && label) {
    const fromLabel = matchSingleModelToken(label);
    if (fromLabel) return fromLabel;
  }
  const fromSlug = matchSingleModelToken(slug);
  if (fromSlug) return fromSlug;
  return matchSingleModelToken(label);
}

export function resolveContextTier(model, inputTokens, modelLabel = '') {
  const canonical = normalizePricingModel(model, modelLabel);
  const entry = MODEL_PRICES[canonical];
  if (!entry?.long) return 'standard';
  return positiveNumber(inputTokens) > LONG_CONTEXT_THRESHOLD ? 'long' : 'short';
}

export class TokenPricingManager {
  constructor({
    stateDir,
    fetchImpl = globalThis.fetch,
    refreshOnInitialize = true,
  } = {}) {
    this.cachePath = stateDir ? path.join(stateDir, 'usd-cny-exchange-rate.json') : '';
    this.fetchImpl = fetchImpl;
    this.refreshOnInitialize = Boolean(refreshOnInitialize);
    this.exchangeRate = { ...FALLBACK_EXCHANGE_RATE };
    this.lastRefreshAttemptAt = 0;
    this.refreshPromise = null;
    this.changeListeners = new Set();
  }

  onChange(listener) {
    if (typeof listener !== 'function') return () => {};
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  getRateSignature() {
    return `${this.exchangeRate.rate}:${this.exchangeRate.date}:${this.exchangeRate.fallback ? 1 : 0}`;
  }

  async initialize() {
    if (this.cachePath) {
      const cached = normalizeExchangeRate(await readJson(this.cachePath));
      if (cached) this.exchangeRate = cached;
    }
    if (this.refreshOnInitialize) {
      const isFresh =
        !this.exchangeRate.fallback &&
        this.exchangeRate.fetchedAt > 0 &&
        Date.now() - this.exchangeRate.fetchedAt < EXCHANGE_RATE_REFRESH_MS;
      if (!isFresh) {
        void this.refreshExchangeRate({ force: true }).catch(() => {});
      }
    }
    return this.exchangeRate;
  }

  async refreshExchangeRate({ force = false } = {}) {
    if (this.refreshPromise) return this.refreshPromise;
    const now = Date.now();
    const retryAfter = this.exchangeRate.fallback
      ? EXCHANGE_RATE_RETRY_MS
      : EXCHANGE_RATE_REFRESH_MS;
    if (!force && now - this.lastRefreshAttemptAt < retryAfter) return this.exchangeRate;
    this.lastRefreshAttemptAt = now;
    const task = this.#fetchExchangeRate()
      .catch(() => this.exchangeRate)
      .finally(() => {
        if (this.refreshPromise === task) this.refreshPromise = null;
      });
    this.refreshPromise = task;
    return task;
  }

  calculate(model, usage, options = {}) {
    const requestedModel = String(model || options?.modelLabel || '').trim();
    const normalizedModel = normalizePricingModel(model, options?.modelLabel);
    const entry = MODEL_PRICES[normalizedModel];
    if (!entry) {
      return unavailableCost(requestedModel, '当前模型没有对应的官方价格配置');
    }

    const inputTokens = positiveNumber(usage?.inputTokens);
    const cachedInputTokens = Math.min(inputTokens, positiveNumber(usage?.cachedInputTokens));
    const uncachedInputTokens =
      usage?.uncachedInputTokens != null
        ? positiveNumber(usage.uncachedInputTokens)
        : Math.max(0, inputTokens - cachedInputTokens);
    const outputTokens = positiveNumber(usage?.outputTokens);
    const thinkingTokens = Math.min(outputTokens, positiveNumber(usage?.thinkingTokens));
    const responseTokens = positiveNumber(usage?.responseTokens);

    const explicitTier = options?.contextTier;
    const hasTieredContext = Boolean(entry.long);
    const isLong =
      hasTieredContext &&
      (explicitTier === 'long' || (explicitTier !== 'short' && inputTokens > LONG_CONTEXT_THRESHOLD));
    const contextTier = hasTieredContext ? (isLong ? 'long' : 'short') : 'standard';
    const rates = isLong ? entry.long : entry.short;

    const components = {
      ordinaryInput: (uncachedInputTokens / MILLION) * rates.ordinaryInput,
      cachedInput: (cachedInputTokens / MILLION) * rates.cachedInput,
      output: (outputTokens / MILLION) * rates.output,
      reasoningOutput: (thinkingTokens / MILLION) * rates.output,
    };

    return {
      available: true,
      requestedModel,
      normalizedModel,
      provider: entry.provider,
      providers: [entry.provider],
      currency: 'USD',
      label: '本轮费用',
      hasTieredContext,
      contextTier,
      contextTiers: [contextTier],
      rates: { ...rates },
      tokenUsage: {
        inputTokens: uncachedInputTokens + cachedInputTokens,
        uncachedInputTokens,
        cachedInputTokens,
        outputTokens,
        thinkingTokens,
        responseTokens,
        totalTokens: uncachedInputTokens + cachedInputTokens + outputTokens,
      },
      components,
      total: components.ordinaryInput + components.cachedInput + components.output,
    };
  }

  calculateTurnCost(turn) {
    const segments = Array.isArray(turn?.segments) ? turn.segments : [];
    if (segments.length === 0) {
      if (positiveNumber(turn?.totalTokens) <= 0) {
        return unavailableCost(turn?.model || turn?.modelLabel || '', '等待 Token 数据');
      }
      return this.calculate(turn.model, turn, { modelLabel: turn.modelLabel });
    }

    let aggregate = null;
    const tierMap = new Map();
    for (const seg of segments) {
      const segCost = this.calculate(seg.model || turn.model, seg.usage, {
        modelLabel: seg.modelLabel || turn.modelLabel,
        contextTier: seg.contextTier,
      });
      aggregate = accumulateTokenCost(aggregate, segCost);
      if (!segCost.available) continue;
      const tierKey = `${segCost.normalizedModel}|${segCost.contextTier}`;
      tierMap.set(tierKey, accumulateTokenCost(tierMap.get(tierKey), segCost));
    }
    if (aggregate?.available) {
      aggregate.tiers = [...tierMap.values()];
    }
    return aggregate;
  }

  toViewModel(cost) {
    if (!cost) return unavailableCost('', '没有获取到本轮模型价格信息');
    if (!cost.available) return { ...cost };
    const rate = cost.currency === 'USD' ? this.exchangeRate.rate : 1;
    const convert = (val) => positiveNumber(val) * rate;
    const viewModel = {
      ...cost,
      totalCny: convert(cost.total),
      componentsCny: {
        ordinaryInput: convert(cost.components?.ordinaryInput),
        cachedInput: convert(cost.components?.cachedInput),
        output: convert(cost.components?.output),
        reasoningOutput: convert(cost.components?.reasoningOutput),
      },
      exchangeRate: cost.currency === 'USD' ? { ...this.exchangeRate } : null,
    };
    if (Array.isArray(cost.tiers)) {
      viewModel.tiers = cost.tiers.map((t) => this.toViewModel(t));
    }
    return viewModel;
  }

  enrichConversationPayload(payload) {
    if (!payload || !Array.isArray(payload.turns)) return payload;
    let runningCny = 0;
    let pendingTurns = 0;

    const turns = payload.turns.map((turn) => {
      const hasUsage = positiveNumber(turn?.totalTokens) > 0;
      const rawCost = hasUsage ? this.calculateTurnCost(turn) : null;
      const viewCost = hasUsage
        ? this.toViewModel(rawCost)
        : unavailableCost(turn?.model || turn?.modelLabel || '', '本轮未获取到 Token 数据');

      if (hasUsage && viewCost.available) {
        runningCny += positiveNumber(viewCost.totalCny);
      } else if (hasUsage && !viewCost.available) {
        pendingTurns += 1;
      }

      const { segments: _segments, ...publicTurn } = turn;
      return {
        ...publicTurn,
        cost: {
          ...viewCost,
          cumulativeAvailable: pendingTurns === 0 && (runningCny > 0 || hasUsage),
          cumulativeCny: runningCny,
          cumulativePendingTurns: pendingTurns,
        },
      };
    });

    return {
      ...payload,
      turns,
    };
  }

  async #fetchExchangeRate() {
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('当前 Node.js 环境不支持获取汇率');
    }
    const response = await this.fetchImpl(EXCHANGE_RATE_URL, {
      headers: { 'User-Agent': 'Antigravity-Quota-Injector/1.0' },
      signal: AbortSignal.timeout(6_000),
    });
    if (!response.ok) throw new Error(`汇率请求失败：HTTP ${response.status}`);
    const html = await response.text();
    const match = html.match(
      /<tr\s+class=["']first["'][^>]*>[\s\S]*?<td[^>]*>\s*(\d{4}-\d{2}-\d{2})\s*<\/td>\s*<td[^>]*>\s*([\d.]+)\s*<\/td>/i
    );
    if (!match) throw new Error('无法从国家外汇管理局页面识别最新美元汇率');
    const rate = Number(match[2]) / 100;
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error('国家外汇管理局返回了无效美元汇率');
    }
    const next = {
      rate,
      date: match[1],
      fetchedAt: Date.now(),
      source: EXCHANGE_RATE_SOURCE,
      sourceUrl: EXCHANGE_RATE_URL,
      fallback: false,
    };
    this.exchangeRate = next;
    if (this.cachePath) {
      await writeJsonAtomic(this.cachePath, next).catch(() => {});
    }
    for (const listener of this.changeListeners) {
      try {
        listener(next);
      } catch {}
    }
    return next;
  }
}

export function accumulateTokenCost(current, next) {
  if (!next?.available) {
    if (current?.available) {
      return unavailableCost(
        current.requestedModel || next?.requestedModel,
        next?.reason || '本轮部分请求无法计算费用'
      );
    }
    return current ? { ...current } : { ...next };
  }
  if (current && !current.available) return { ...current };
  if (!current) return cloneCost(next);
  if (current.currency !== next.currency) {
    return unavailableCost(next.requestedModel, '同一轮包含不同计价币种，无法合并费用');
  }

  const providers = [...new Set([...(current.providers || [current.provider]), ...(next.providers || [next.provider])].filter(Boolean))];
  const contextTiers = [...new Set([...(current.contextTiers || []), ...(next.contextTiers || [next.contextTier])].filter(Boolean))];

  return {
    ...current,
    normalizedModel: current.normalizedModel === next.normalizedModel ? current.normalizedModel : 'multiple',
    provider: providers.length === 1 ? providers[0] : 'multiple',
    providers,
    hasTieredContext: Boolean(current.hasTieredContext || next.hasTieredContext),
    total: current.total + next.total,
    components: {
      ordinaryInput: positiveNumber(current.components?.ordinaryInput) + positiveNumber(next.components?.ordinaryInput),
      cachedInput: positiveNumber(current.components?.cachedInput) + positiveNumber(next.components?.cachedInput),
      output: positiveNumber(current.components?.output) + positiveNumber(next.components?.output),
      reasoningOutput: positiveNumber(current.components?.reasoningOutput) + positiveNumber(next.components?.reasoningOutput),
    },
    tokenUsage: Object.fromEntries(
      USAGE_FIELDS.map((f) => [f, positiveNumber(current.tokenUsage?.[f]) + positiveNumber(next.tokenUsage?.[f])])
    ),
    contextTiers,
  };
}

function unavailableCost(requestedModel, reason) {
  return {
    available: false,
    requestedModel: String(requestedModel || ''),
    reason,
  };
}

function cloneCost(cost) {
  return {
    ...cost,
    providers: [...(cost.providers || [cost.provider]).filter(Boolean)],
    rates: { ...cost.rates },
    components: { ...cost.components },
    tokenUsage: { ...cost.tokenUsage },
    contextTiers: [...(cost.contextTiers || [])],
  };
}

function positiveNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

function normalizeExchangeRate(value) {
  const rate = Number(value?.rate);
  const date = String(value?.date || '');
  if (!Number.isFinite(rate) || rate <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return {
    rate,
    date,
    fetchedAt: positiveNumber(value?.fetchedAt),
    source: EXCHANGE_RATE_SOURCE,
    sourceUrl: EXCHANGE_RATE_URL,
    fallback: false,
  };
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT' || err instanceof SyntaxError) return null;
    throw err;
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}
