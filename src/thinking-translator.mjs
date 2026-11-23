import crypto from 'node:crypto';

export const DEFAULT_AI_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
export const DEFAULT_AI_MODEL = 'glm-4-flash-250414';

const MAX_SOURCE_CHARS = 12_000;
const MAX_BRIEF_INPUT_CHARS = 1_400;
const CACHE_LIMIT = 48;

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DEEPL_ONESHOT_URL = 'https://oneshot-free.www.deepl.com/v1/translate';
const DEEPL_APPSTORE_LOOKUP_URL = 'https://itunes.apple.com/lookup?id=1552407475&country=us';
const DEEPL_OS_VERSION = '26.0';
const DEEPL_APP_BUILD = '5443737';
const DEEPL_FALLBACK_APP_VERSION = '26.52';
const DEEPL_VERSION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEEPL_VERSION_RETRY_DELAY_MS = 15 * 60 * 1000;

const BING_DEFAULT_HOST = 'cn.bing.com';
const BING_MAX_CHUNK_CHARS = 950;
const BING_DEFAULT_TOKEN_TTL_MS = 30 * 60 * 1000;

const YOUDAO_DICT_BASE_URL = 'https://dict.youdao.com';
const YOUDAO_TRANSLATE_REFERER = 'https://fanyi.youdao.com/';
const YOUDAO_KEY_GETTER_SECRET = 'asdjnjfenknafdfsdfsd';
const YOUDAO_CLIENT = 'fanyideskweb';
const YOUDAO_PRODUCT = 'webfanyi';
const YOUDAO_KEY_TTL_MS = 30 * 60 * 1000;
const WEB_MAX_CHUNK_CHARS = 4_500;

export const DEFAULT_AI_BRIEF_SYSTEM_PROMPT = [
  '请把下面这段生硬的英文 AI 思考记录，彻底嚼碎后用 1～2 句自然大白话讲出来（25～60 字），就像程序员在工位上扭头跟同事随口说“我正弄啥呢”。',
  '硬性要求：',
  '1. 彻底扔掉英文翻译腔和书面公文词（严禁出现“涉及、旨在、表明、意味着、机制、特定、以确保、潜在的、套件”这类词；比如把“执行测试套件验证集成以确保不引入意外行为”直接说成“跑一下测试，看改动有没有把别的地方搞坏”）。',
  '2. 如果输入标了【当前最新想法】，只讲这一部分正在干的事和结论，前面翻篇的旧段落直接忽略。',
  '3. 代码里的文件名、函数名、配置字段或端口号原样保留；不要任何前缀，不要分点或换行。',
].join('\n');

export const DEFAULT_AI_BRIEF_USER_PROMPT =
  '${{queryText}}\n\n直接用一两句大白话说它现在在干嘛：';

export const DEFAULT_AI_TRANSLATE_SYSTEM_PROMPT = [
  '你是专业的技术翻译助手，只负责把输入的英文 AI 思考过程准确、自然、流畅地翻译成简体中文。',
  '保留代码标识符、文件路径、函数名、命令行参数与端口号原样不变；只输出译文正文，不要额外解释、引号或前缀。',
].join('\n');

export const THINKING_TRANSLATE_SOURCES = [
  { id: 'auto', label: 'auto' },
  { id: 'ai-brief', label: 'AI 简述' },
  { id: 'ai-translate', label: 'AI 翻译' },
  { id: 'google', label: 'Google 翻译' },
  { id: 'deepl', label: 'DeepL 翻译' },
  { id: 'bing', label: 'Bing 翻译' },
  { id: 'youdao', label: '有道翻译' },
];

export const LEGACY_THINKING_SOURCE_ALIASES = {
  'easydict-ai-brief': 'ai-brief',
  'easydict-builtin-ai': 'ai-translate',
  'easydict-google': 'google',
  'web-google': 'google',
  'easydict-deepl': 'deepl',
  'easydict-bing': 'bing',
  'easydict-youdao': 'youdao',
};

const VALID_SOURCE_IDS = new Set(THINKING_TRANSLATE_SOURCES.map((s) => s.id));

const SOURCE_LABELS = Object.fromEntries(
  THINKING_TRANSLATE_SOURCES.map((s) => [s.id, s.label])
);

export function normalizeThinkingTranslateSource(raw) {
  const clean = String(raw || '').trim().toLowerCase();
  const mapped = LEGACY_THINKING_SOURCE_ALIASES[clean] || clean;
  return VALID_SOURCE_IDS.has(mapped) ? mapped : 'auto';
}

export function normalizeAiEndpoint(rawEndpoint) {
  const clean = String(rawEndpoint || '').trim();
  if (!clean) return DEFAULT_AI_ENDPOINT;
  const trimmed = clean.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

export function buildAiExtraRequestFields(endpoint, model) {
  const ep = String(endpoint || '').toLowerCase();
  const m = String(model || '').trim().toLowerCase();
  if (
    (ep.includes('bigmodel.cn') || ep.includes('z.ai')) &&
    /^(?:thudm\/)?glm-(?:4\.[5-9]|5|z)/i.test(m)
  ) {
    return { thinking: { type: 'disabled' } };
  }
  if (
    (ep.includes('siliconflow.') || ep.includes('aliyuncs.com')) &&
    /(?:^|\/)qwen3\b/i.test(m) &&
    !m.includes('thinking')
  ) {
    return { enable_thinking: false };
  }
  return {};
}

function stripReasoningTags(raw) {
  return String(raw || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
}

export function parseSseContentPayload(rawBody) {
  const lines = String(rawBody || '').split(/\r?\n/);
  let output = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (parsed?.error) {
      const errMsg =
        typeof parsed.error === 'string'
          ? parsed.error
          : String(parsed.error?.message || 'AI stream error');
      throw new Error(errMsg);
    }
    const delta =
      parsed?.choices?.[0]?.delta?.content ??
      parsed?.choices?.[0]?.message?.content ??
      parsed?.content ??
      '';
    if (typeof delta === 'string' && delta.length > 0) {
      output += delta;
    }
  }
  return stripReasoningTags(output);
}

async function fetchBodyWithTimeout(url, options, timeoutMs, fetchFn, mode = 'text') {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { ...options, signal: ctrl.signal });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { ok: false, status: res.status, body: null, errText, headers: res.headers, url: res.url };
    }
    const body = mode === 'json' ? await res.json() : await res.text();
    return { ok: true, status: res.status, body, errText: '', headers: res.headers, url: res.url };
  } finally {
    clearTimeout(timer);
  }
}

export function compactThinkingText(raw) {
  const lines = String(raw || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd());
  const nonEmpty = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    nonEmpty.push(line);
  }
  return nonEmpty.join('\n').trim();
}

export function sliceThinkingForBrief(raw, maxChars = MAX_BRIEF_INPUT_CHARS) {
  const normalized = String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\$\{\{/g, '$ {{')
    .trim();
  if (!normalized) return '';
  const paras = normalized
    .split(/\n{2,}/)
    .map((p) => compactThinkingText(p))
    .filter(Boolean);
  if (paras.length <= 1) {
    const single = paras[0] || compactThinkingText(normalized);
    if (single.length <= maxChars) return single;
    const firstLine = single.slice(0, 140);
    const tail = single.slice(-(maxChars - 180)).trimStart();
    return `[早期背景] ${firstLine}\n[当前最新想法]\n${tail}`;
  }
  const tailBudget = Math.max(400, maxChars - 180);
  const lastTwo = paras.slice(-2).join('\n');
  const latestChunk =
    lastTwo.length <= tailBudget ? lastTwo : lastTwo.slice(-tailBudget).trimStart();
  if (paras.length === 2 && lastTwo.length <= tailBudget) {
    return `[早期背景] ${paras[0].slice(0, 160)}\n[当前最新想法]\n${paras[1]}`;
  }
  return `[早期背景] ${paras[0].slice(0, 140)}\n[当前最新想法]\n${latestChunk}`;
}

export function truncateThinkingInput(raw) {
  const clean = compactThinkingText(raw);
  if (clean.length <= MAX_SOURCE_CHARS) return clean;
  const headBudget = 2400;
  const tailBudget = MAX_SOURCE_CHARS - headBudget - 16;
  return `${clean.slice(0, headBudget).trimEnd()}\n…\n${clean.slice(-tailBudget).trimStart()}`;
}

export function splitTextIntoChunks(raw, maxChars = WEB_MAX_CHUNK_CHARS) {
  const text = String(raw || '').trim();
  if (!text) return [];
  if (text.length <= maxChars) return [text];

  const lines = text.split('\n');
  const chunks = [];
  let current = '';

  const flushCurrent = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > maxChars) {
      flushCurrent();
      for (let offset = 0; offset < line.length; offset += maxChars) {
        const piece = line.slice(offset, offset + maxChars).trim();
        if (piece) chunks.push(piece);
      }
      continue;
    }
    const next = current ? `${current}\n${line}` : line;
    if (next.length > maxChars) {
      flushCurrent();
      current = line;
    } else {
      current = next;
    }
  }
  flushCurrent();
  return chunks;
}

function md5Hex(input) {
  return crypto.createHash('md5').update(String(input), 'utf8').digest('hex');
}

function md5Bytes(input) {
  return crypto.createHash('md5').update(String(input), 'utf8').digest();
}

function buildYoudaoSign(timestamp, key) {
  return md5Hex(
    `client=${YOUDAO_CLIENT}&mysticTime=${timestamp}&product=${YOUDAO_PRODUCT}&key=${key}`
  );
}

export function decryptYoudaoPayload(encryptedText, aesKey, aesIv) {
  const normalizedBase64 = String(encryptedText || '')
    .trim()
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  if (!normalizedBase64) {
    throw new Error('Youdao 返回空密文');
  }
  const padLen = (4 - (normalizedBase64.length % 4)) % 4;
  const padded = normalizedBase64 + '='.repeat(padLen);
  const encryptedBuf = Buffer.from(padded, 'base64');
  const decipher = crypto.createDecipheriv('aes-128-cbc', md5Bytes(aesKey), md5Bytes(aesIv));
  const decrypted = Buffer.concat([decipher.update(encryptedBuf), decipher.final()]);
  return decrypted.toString('utf8');
}

export function encryptYoudaoPayload(plainText, aesKey, aesIv) {
  const cipher = crypto.createCipheriv('aes-128-cbc', md5Bytes(aesKey), md5Bytes(aesIv));
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  return encrypted.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

function isValidAppVersion(version) {
  const parts = String(version || '').split('.');
  return (
    parts.length >= 2 &&
    parts.length <= 4 &&
    parts.every((p) => p.length > 0 && /^\d+$/.test(p))
  );
}

function extractResponseCookies(headers) {
  if (!headers) return '';
  if (typeof headers.getSetCookie === 'function') {
    const list = headers.getSetCookie();
    if (Array.isArray(list) && list.length > 0) {
      return list
        .map((item) => String(item || '').split(';')[0].trim())
        .filter(Boolean)
        .join('; ');
    }
  }
  if (typeof headers.get === 'function') {
    const raw = headers.get('set-cookie');
    if (raw) {
      return String(raw)
        .split(/,(?=\s*[A-Za-z0-9_-]+=)/)
        .map((item) => item.split(';')[0].trim())
        .filter(Boolean)
        .join('; ');
    }
  }
  return '';
}

export function createThinkingTranslator({
  fetchFn = fetch,
  env = process.env,
  nowFn = Date.now,
  getAiConfig = () => ({}),
  getAiBriefPrompt = null,
} = {}) {
  const translationCache = new Map();
  const deepLInstanceId = crypto.randomUUID();
  const deepLSessionId = crypto.randomUUID();

  let deepLVersionState = {
    version: DEEPL_FALLBACK_APP_VERSION,
    fetchedAt: 0,
    lastAttemptAt: 0,
    inflight: null,
  };

  let bingTokenState = {
    host: BING_DEFAULT_HOST,
    ig: '',
    iid: '',
    key: '',
    token: '',
    cookie: '',
    expiresAt: 0,
    inflight: null,
  };

  let youdaoKeyState = {
    secretKey: '',
    aesKey: '',
    aesIv: '',
    expiresAt: 0,
    inflight: null,
  };

  function resolveAiSettings() {
    const rawCfg = getAiConfig?.() || {};
    const apiKey = String(
      rawCfg.apiKey || env?.AQ_AI_API_KEY || env?.ZHIPU_API_KEY || ''
    ).trim();
    const endpoint = normalizeAiEndpoint(rawCfg.endpoint || env?.AQ_AI_ENDPOINT || '');
    const model = String(rawCfg.model || env?.AQ_AI_MODEL || DEFAULT_AI_MODEL).trim() || DEFAULT_AI_MODEL;
    const customBrief = String(
      rawCfg.briefPrompt ?? (typeof getAiBriefPrompt === 'function' ? getAiBriefPrompt() : '') ?? ''
    ).trim();
    return {
      apiKey,
      endpoint,
      model,
      briefSystemPrompt: customBrief || DEFAULT_AI_BRIEF_SYSTEM_PROMPT,
      briefUserPrompt: DEFAULT_AI_BRIEF_USER_PROMPT,
    };
  }

  function prepareInput(rawText, source = 'auto') {
    const text = truncateThinkingInput(rawText);
    const sourceId = normalizeThinkingTranslateSource(source);
    const ai = resolveAiSettings();
    const aiKeyTag = ai.apiKey
      ? crypto.createHash('sha256').update(ai.apiKey).digest('hex').slice(0, 12)
      : 'nokey';
    const briefInput = sourceId === 'ai-brief' ? sliceThinkingForBrief(rawText) : '';
    let hashPayload = text;
    if (sourceId === 'ai-brief') {
      hashPayload = `${aiKeyTag}\0${ai.endpoint}\0${ai.model}\0${ai.briefSystemPrompt}\0${briefInput}`;
    } else if (sourceId === 'ai-translate' || sourceId === 'auto') {
      hashPayload = `${aiKeyTag}\0${ai.endpoint}\0${ai.model}\0${text}`;
    }
    const cacheKey = text
      ? `${sourceId}:${crypto.createHash('sha256').update(hashPayload).digest('hex')}`
      : '';
    return { text, sourceId, ai, briefInput, cacheKey };
  }

  // ---- 1. Google Translate (Direct GTX) ----

  async function translateChunkViaGoogleEndpoint(endpoint, chunk) {
    const { ok, status, body: data } = await fetchBodyWithTimeout(
      endpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'User-Agent': 'Mozilla/5.0',
        },
        body: new URLSearchParams({ q: chunk }).toString(),
      },
      8500,
      fetchFn,
      'json'
    );
    if (!ok) {
      throw new Error(`Google Translate HTTP ${status}`);
    }
    const translated = Array.isArray(data?.[0])
      ? data[0]
          .map((seg) => (Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : ''))
          .join('')
          .trim()
      : '';
    if (!translated) {
      throw new Error('Google 翻译返回空译文');
    }
    return translated;
  }

  async function translateViaGoogle(text) {
    const endpoints = [
      'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t',
      'https://translate.google.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t',
    ];
    const chunks = splitTextIntoChunks(text, WEB_MAX_CHUNK_CHARS);
    const out = [];
    for (let c = 0; c < chunks.length; c++) {
      let lastErr = null;
      let chunkDone = '';
      for (let i = 0; i < endpoints.length; i++) {
        try {
          chunkDone = await translateChunkViaGoogleEndpoint(endpoints[i], chunks[c]);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
        }
      }
      if (lastErr || !chunkDone) {
        throw lastErr || new Error('Google 翻译请求失败');
      }
      out.push(chunkDone);
    }
    return {
      translatedText: out.join('\n'),
      provider: 'google',
      providerLabel: SOURCE_LABELS.google,
    };
  }

  // ---- 2. DeepL Translate (Direct Oneshot Web API) ----

  async function refreshDeepLAppVersion() {
    const now = nowFn();
    if (
      deepLVersionState.fetchedAt > 0 &&
      now - deepLVersionState.fetchedAt < DEEPL_VERSION_CACHE_TTL_MS
    ) {
      return deepLVersionState.version;
    }
    if (deepLVersionState.inflight) {
      return deepLVersionState.inflight;
    }
    if (
      deepLVersionState.lastAttemptAt > 0 &&
      now - deepLVersionState.lastAttemptAt < DEEPL_VERSION_RETRY_DELAY_MS
    ) {
      return deepLVersionState.version;
    }
    deepLVersionState.lastAttemptAt = now;
    const task = (async () => {
      try {
        const { ok, body } = await fetchBodyWithTimeout(
          DEEPL_APPSTORE_LOOKUP_URL,
          { method: 'GET' },
          3000,
          fetchFn,
          'json'
        );
        const app = ok && body?.resultCount === 1 ? body?.results?.[0] : null;
        if (
          app &&
          app.trackId === 1552407475 &&
          app.bundleId === 'com.linguee.DeepLMobileTranslator' &&
          isValidAppVersion(app.version)
        ) {
          deepLVersionState.version = app.version;
          deepLVersionState.fetchedAt = nowFn();
        }
      } catch {}
      return deepLVersionState.version;
    })().finally(() => {
      if (deepLVersionState.inflight === task) {
        deepLVersionState.inflight = null;
      }
    });
    deepLVersionState.inflight = task;
    return task;
  }

  async function postDeepLOneshot(chunks, appVersion) {
    const { ok, status, body, errText } = await fetchBodyWithTimeout(
      DEEPL_ONESHOT_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'None',
          'User-Agent': `DeepL/${appVersion} CFNetwork/3826.600.41 Darwin/25.0.0`,
          'x-app-os-version': DEEPL_OS_VERSION,
          'x-app-instance-id': deepLInstanceId,
          'x-app-session-id': deepLSessionId,
        },
        body: JSON.stringify({
          text: chunks,
          target_lang: 'zh-Hans',
          usage_type: 'translate',
          app_information: {
            os: 'iOS',
            os_version: DEEPL_OS_VERSION,
            app_version: appVersion,
            app_build: DEEPL_APP_BUILD,
            instance_id: deepLInstanceId,
          },
        }),
      },
      9000,
      fetchFn,
      'json'
    );
    return { ok, status, body, errText };
  }

  async function translateViaDeepL(text) {
    const chunks = splitTextIntoChunks(text, WEB_MAX_CHUNK_CHARS);
    let res = await postDeepLOneshot(chunks, deepLVersionState.version);
    if (!res.ok && (res.status === 400 || res.status === 403 || res.status === 426)) {
      const prevVer = deepLVersionState.version;
      const nextVer = await refreshDeepLAppVersion();
      if (nextVer !== prevVer) {
        res = await postDeepLOneshot(chunks, nextVer);
      }
    }
    if (!res.ok) {
      throw new Error(
        `DeepL HTTP ${res.status}${res.errText ? `: ${res.errText.slice(0, 120)}` : ''}`
      );
    }
    const items = Array.isArray(res.body?.translations) ? res.body.translations : [];
    const translatedText = items
      .map((item) => String(item?.text || '').trim())
      .filter(Boolean)
      .join('\n')
      .trim();
    if (!translatedText) {
      throw new Error('DeepL 返回空译文');
    }
    return {
      translatedText,
      provider: 'deepl',
      providerLabel: SOURCE_LABELS.deepl,
    };
  }

  // ---- 3. Bing Translate (Direct Web Token + ttranslatev3) ----

  function resetBingToken() {
    bingTokenState = {
      host: BING_DEFAULT_HOST,
      ig: '',
      iid: '',
      key: '',
      token: '',
      cookie: '',
      expiresAt: 0,
      inflight: null,
    };
  }

  async function ensureBingToken() {
    const now = nowFn();
    if (
      bingTokenState.token &&
      bingTokenState.key &&
      bingTokenState.ig &&
      now < bingTokenState.expiresAt
    ) {
      return bingTokenState;
    }
    if (bingTokenState.inflight) {
      return bingTokenState.inflight;
    }

    const task = (async () => {
      const { ok, status, body: html, headers, url } = await fetchBodyWithTimeout(
        `https://${BING_DEFAULT_HOST}/translator`,
        {
          method: 'GET',
          headers: { 'User-Agent': BROWSER_USER_AGENT },
        },
        7500,
        fetchFn,
        'text'
      );
      if (!ok) {
        throw new Error(`Bing token HTTP ${status}`);
      }
      let resolvedHost = BING_DEFAULT_HOST;
      if (url) {
        try {
          resolvedHost = new URL(url).host || BING_DEFAULT_HOST;
        } catch {}
      }
      const ig = String(html || '').match(/IG:\s*"([^"]+)"/)?.[1] || '';
      const iid = String(html || '').match(/data-iid\s*=\s*"([^"]+)"/)?.[1] || 'translator.5029';
      const abuseMatch = String(html || '').match(
        /params_AbusePreventionHelper\s*=\s*\[([^\]]+)\]/
      )?.[1];
      if (!ig || !abuseMatch) {
        throw new Error('Bing 页面解析令牌失败');
      }
      const parts = abuseMatch
        .replace(/"/g, '')
        .split(',')
        .map((s) => s.trim());
      const [key = '', token = '', rawDuration = '3600000'] = parts;
      if (!key || !token) {
        throw new Error('Bing 密钥为空');
      }
      const ttlMs = Math.max(
        60_000,
        Math.min(BING_DEFAULT_TOKEN_TTL_MS, Math.floor((Number(rawDuration) || 3_600_000) / 2))
      );
      bingTokenState = {
        host: resolvedHost,
        ig,
        iid,
        key,
        token,
        cookie: extractResponseCookies(headers),
        expiresAt: nowFn() + ttlMs,
        inflight: null,
      };
      return bingTokenState;
    })();

    bingTokenState.inflight = task;
    try {
      return await task;
    } catch (err) {
      if (bingTokenState.inflight === task) {
        bingTokenState.inflight = null;
      }
      throw err;
    }
  }

  async function translateSingleBingChunk(chunk, allowTokenRetry = true) {
    const auth = await ensureBingToken();
    const url = `https://${auth.host}/ttranslatev3?isVertical=1&IG=${encodeURIComponent(auth.ig)}&IID=${encodeURIComponent(auth.iid)}`;
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'User-Agent': BROWSER_USER_AGENT,
    };
    if (auth.cookie) {
      headers.Cookie = auth.cookie;
    }
    const { ok, status, body: rawText } = await fetchBodyWithTimeout(
      url,
      {
        method: 'POST',
        headers,
        body: new URLSearchParams({
          fromLang: 'auto-detect',
          text: chunk,
          to: 'zh-Hans',
          token: auth.token,
          key: auth.key,
          tryFetchingGenderDebiasedTranslations: 'true',
        }).toString(),
      },
      8500,
      fetchFn,
      'text'
    );
    if (!ok) {
      throw new Error(`Bing Translate HTTP ${status}`);
    }
    if (!String(rawText || '').trim()) {
      if (allowTokenRetry) {
        resetBingToken();
        return translateSingleBingChunk(chunk, false);
      }
      throw new Error('Bing 返回空内容');
    }
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new Error('Bing 响应 JSON 解析失败');
    }
    if (!Array.isArray(parsed)) {
      if (allowTokenRetry && Number(parsed?.statusCode) === 205) {
        resetBingToken();
        return translateSingleBingChunk(chunk, false);
      }
      throw new Error(`Bing 接口错误 (${parsed?.statusCode || 'unknown'})`);
    }
    const translated = Array.isArray(parsed[0]?.translations)
      ? parsed[0].translations
          .map((item) => String(item?.text || '').trim())
          .filter(Boolean)
          .join('\n')
      : '';
    if (!translated) {
      throw new Error('Bing 返回空译文');
    }
    return translated;
  }

  async function translateViaBing(text) {
    const chunks = splitTextIntoChunks(text, BING_MAX_CHUNK_CHARS);
    const out = [];
    for (let i = 0; i < chunks.length; i++) {
      out.push(await translateSingleBingChunk(chunks[i], true));
    }
    return {
      translatedText: out.join('\n'),
      provider: 'bing',
      providerLabel: SOURCE_LABELS.bing,
    };
  }

  // ---- 4. Youdao Translate (Direct Web Key + AES-128-CBC) ----

  function resetYoudaoKey() {
    youdaoKeyState = {
      secretKey: '',
      aesKey: '',
      aesIv: '',
      expiresAt: 0,
      inflight: null,
    };
  }

  async function ensureYoudaoKey() {
    const now = nowFn();
    if (
      youdaoKeyState.secretKey &&
      youdaoKeyState.aesKey &&
      youdaoKeyState.aesIv &&
      now < youdaoKeyState.expiresAt
    ) {
      return youdaoKeyState;
    }
    if (youdaoKeyState.inflight) {
      return youdaoKeyState.inflight;
    }

    const task = (async () => {
      const ts = String(nowFn());
      const params = new URLSearchParams({
        client: YOUDAO_CLIENT,
        mysticTime: ts,
        product: YOUDAO_PRODUCT,
        keyfrom: 'fanyi.web',
        vendor: 'web',
        pointParam: 'client,mysticTime,product',
        appVersion: '1.0.0',
        keyid: 'webfanyi-key-getter',
        sign: buildYoudaoSign(ts, YOUDAO_KEY_GETTER_SECRET),
      });
      const { ok, status, body } = await fetchBodyWithTimeout(
        `${YOUDAO_DICT_BASE_URL}/webtranslate/key?${params.toString()}`,
        {
          method: 'GET',
          headers: {
            'User-Agent': BROWSER_USER_AGENT,
            Referer: YOUDAO_TRANSLATE_REFERER,
            Origin: 'https://fanyi.youdao.com',
            Cookie: 'OUTFOX_SEARCH_USER_ID=1796239350@10.110.96.157;',
          },
        },
        7500,
        fetchFn,
        'json'
      );
      if (!ok) {
        throw new Error(`Youdao key HTTP ${status}`);
      }
      const keyData = body?.data;
      if (
        Number(body?.code) !== 0 ||
        !keyData?.secretKey ||
        !keyData?.aesKey ||
        !keyData?.aesIv
      ) {
        throw new Error(`Youdao 获取密钥失败 (${body?.code ?? 'invalid'})`);
      }
      youdaoKeyState = {
        secretKey: String(keyData.secretKey),
        aesKey: String(keyData.aesKey),
        aesIv: String(keyData.aesIv),
        expiresAt: nowFn() + YOUDAO_KEY_TTL_MS,
        inflight: null,
      };
      return youdaoKeyState;
    })();

    youdaoKeyState.inflight = task;
    try {
      return await task;
    } catch (err) {
      if (youdaoKeyState.inflight === task) {
        youdaoKeyState.inflight = null;
      }
      throw err;
    }
  }

  async function translateSingleYoudaoChunk(chunk, allowKeyRetry = true) {
    const keyInfo = await ensureYoudaoKey();
    const ts = String(nowFn());
    const bodyParams = new URLSearchParams({
      i: chunk,
      from: 'auto',
      to: 'zh-CHS',
      dictResult: 'false',
      keyid: 'webfanyi',
      sign: buildYoudaoSign(ts, keyInfo.secretKey),
      client: YOUDAO_CLIENT,
      product: YOUDAO_PRODUCT,
      appVersion: '1.0.0',
      vendor: 'web',
      pointParam: 'client,mysticTime,product',
      mysticTime: ts,
      keyfrom: 'fanyi.web',
    });

    const { ok, status, body: rawEncrypted } = await fetchBodyWithTimeout(
      `${YOUDAO_DICT_BASE_URL}/webtranslate`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'User-Agent': BROWSER_USER_AGENT,
          Referer: YOUDAO_TRANSLATE_REFERER,
          Origin: 'https://fanyi.youdao.com',
          Cookie: 'OUTFOX_SEARCH_USER_ID=1796239350@10.110.96.157;',
        },
        body: bodyParams.toString(),
      },
      8500,
      fetchFn,
      'text'
    );
    if (!ok) {
      throw new Error(`Youdao HTTP ${status}`);
    }

    let parsed;
    try {
      const decryptedJson = decryptYoudaoPayload(rawEncrypted, keyInfo.aesKey, keyInfo.aesIv);
      parsed = JSON.parse(decryptedJson);
    } catch (err) {
      if (allowKeyRetry) {
        resetYoudaoKey();
        return translateSingleYoudaoChunk(chunk, false);
      }
      throw err;
    }

    if (Number(parsed?.code) !== 0 || !Array.isArray(parsed?.translateResult)) {
      if (allowKeyRetry) {
        resetYoudaoKey();
        return translateSingleYoudaoChunk(chunk, false);
      }
      throw new Error(`Youdao 翻译失败 (code=${parsed?.code ?? 'unknown'})`);
    }

    const groups = parsed.translateResult.map((group) =>
      Array.isArray(group) ? group.map((item) => String(item?.tgt || '')).join('') : ''
    );
    const translated = groups.join('\n').trim();
    if (!translated) {
      throw new Error('Youdao 返回空译文');
    }
    return translated;
  }

  async function translateViaYoudao(text) {
    const chunks = splitTextIntoChunks(text, WEB_MAX_CHUNK_CHARS);
    const out = [];
    for (let i = 0; i < chunks.length; i++) {
      out.push(await translateSingleYoudaoChunk(chunks[i], true));
    }
    return {
      translatedText: out.join('\n'),
      provider: 'youdao',
      providerLabel: SOURCE_LABELS.youdao,
    };
  }

  // ---- 5. Direct AI (Zhipu GLM / OpenAI-Compatible Chat Completions) ----

  async function requestAiChatCompletion({
    ai,
    systemPrompt,
    userContent,
    temperature = 0.2,
    providerId,
    providerLabel,
  }) {
    if (!ai.apiKey) {
      const noKeyErr = new Error('未配置 AI API Key（请在 config.json 中设置 aiApiKey）');
      noKeyErr.code = 'AI_KEY_MISSING';
      throw noKeyErr;
    }

    const { ok, status, body: rawBody, errText, headers } = await fetchBodyWithTimeout(
      ai.endpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ai.apiKey}`,
        },
        body: JSON.stringify({
          model: ai.model,
          stream: false,
          temperature,
          ...buildAiExtraRequestFields(ai.endpoint, ai.model),
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
        }),
      },
      18_000,
      fetchFn,
      'text'
    );

    if (!ok) {
      let detail = errText;
      try {
        const errJson = JSON.parse(errText);
        detail = String(errJson?.error?.message || errJson?.message || errText);
      } catch {}
      throw new Error(
        `${providerLabel} HTTP ${status}${detail ? `: ${detail.slice(0, 120)}` : ''}`
      );
    }

    const contentType = String(headers?.get?.('content-type') || '').toLowerCase();
    const trimmedBody = String(rawBody || '').trim();
    let content = '';
    if (contentType.includes('text/event-stream') || trimmedBody.startsWith('data:')) {
      content = parseSseContentPayload(trimmedBody);
    } else {
      let parsed;
      try {
        parsed = JSON.parse(trimmedBody);
      } catch {
        throw new Error(`${providerLabel} 响应解析失败`);
      }
      if (parsed?.error) {
        const msg =
          typeof parsed.error === 'string'
            ? parsed.error
            : String(parsed.error?.message || `${providerLabel} 接口错误`);
        throw new Error(msg);
      }
      content = stripReasoningTags(
        parsed?.choices?.[0]?.message?.content ??
          parsed?.choices?.[0]?.delta?.content ??
          parsed?.content ??
          ''
      );
    }

    if (!content) {
      throw new Error(`${providerLabel} 返回空内容`);
    }

    return {
      translatedText: content,
      provider: providerId,
      providerLabel,
    };
  }

  async function translateViaAiTranslate(text, ai) {
    return requestAiChatCompletion({
      ai,
      systemPrompt: DEFAULT_AI_TRANSLATE_SYSTEM_PROMPT,
      userContent: `请将以下内容翻译为简体中文：\n\n${text}`,
      temperature: 0.1,
      providerId: 'ai-translate',
      providerLabel: SOURCE_LABELS['ai-translate'],
    });
  }

  async function translateViaAiBrief(briefInput, ai) {
    const userContent = ai.briefUserPrompt.includes('${{queryText}}')
      ? ai.briefUserPrompt.replaceAll('${{queryText}}', briefInput)
      : `${briefInput}\n\n${ai.briefUserPrompt}`;
    return requestAiChatCompletion({
      ai,
      systemPrompt: ai.briefSystemPrompt,
      userContent,
      temperature: 0.2,
      providerId: 'ai-brief',
      providerLabel: SOURCE_LABELS['ai-brief'],
    });
  }

  // ---- Routing & Resilient Fallback Chains ----

  const DIRECT_RUNNERS = {
    google: (text) => translateViaGoogle(text),
    deepl: (text) => translateViaDeepL(text),
    bing: (text) => translateViaBing(text),
    youdao: (text) => translateViaYoudao(text),
    'ai-translate': (text, ai) => translateViaAiTranslate(text, ai),
  };

  async function runFallbackTranslators(text, ai, { skipId = '', suffix = '' } = {}) {
    if (!/[A-Za-z]/.test(text)) {
      return {
        translatedText: text,
        provider: 'passthrough',
        providerLabel: suffix ? `原文（${suffix}）` : '原文已为中文',
      };
    }

    const order = ai.apiKey
      ? ['google', 'ai-translate', 'deepl', 'bing', 'youdao']
      : ['google', 'deepl', 'bing', 'youdao'];

    let lastErr = null;
    for (let i = 0; i < order.length; i++) {
      const candidateId = order[i];
      if (candidateId === skipId) continue;
      try {
        const res = await DIRECT_RUNNERS[candidateId](text, ai);
        if (suffix) {
          return {
            ...res,
            providerLabel: `${res.providerLabel}（${suffix}）`,
          };
        }
        return res;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('所有翻译渠道均请求失败');
  }

  async function runAutoChain(text, ai) {
    return runFallbackTranslators(text, ai);
  }

  async function runExplicitSource(text, sourceId, ai, briefInput) {
    if (sourceId === 'ai-brief') {
      try {
        return await translateViaAiBrief(briefInput || text, ai);
      } catch (err) {
        const reason = err?.code === 'AI_KEY_MISSING' ? '未配 AI Key 回退' : '简述异常回退';
        return runFallbackTranslators(text, ai, { suffix: reason });
      }
    }

    const runner = DIRECT_RUNNERS[sourceId];
    if (!runner) {
      return runAutoChain(text, ai);
    }

    try {
      return await runner(text, ai);
    } catch (primaryErr) {
      const reason =
        sourceId === 'ai-translate' && primaryErr?.code === 'AI_KEY_MISSING'
          ? '未配 AI Key 回退'
          : '回退';
      try {
        return await runFallbackTranslators(text, ai, {
          skipId: sourceId,
          suffix: reason,
        });
      } catch {
        throw primaryErr;
      }
    }
  }

  function getEffectiveKey(rawText, { source = 'auto' } = {}) {
    const { text, sourceId, cacheKey } = prepareInput(rawText, source);
    return { sourceId, text, effectiveKey: cacheKey };
  }

  async function translate(rawText, { source = 'auto' } = {}) {
    const { text, sourceId, ai, briefInput, cacheKey } = prepareInput(rawText, source);
    if (!text) {
      throw new Error('思考内容为空');
    }
    const hasLatin = /[A-Za-z]/.test(text);
    if (!hasLatin && (sourceId !== 'ai-brief' || text.length <= 90)) {
      return {
        sourceText: text,
        translatedText: text,
        provider: 'passthrough',
        providerLabel: '原文已为中文',
        effectiveKey: cacheKey,
      };
    }

    const hit = translationCache.get(cacheKey);
    if (hit) {
      translationCache.delete(cacheKey);
      translationCache.set(cacheKey, hit);
      return { sourceText: text, effectiveKey: cacheKey, ...hit };
    }

    const rawResult =
      sourceId === 'auto'
        ? await runAutoChain(text, ai)
        : await runExplicitSource(text, sourceId, ai, briefInput);
    const result = {
      ...rawResult,
      translatedText: compactThinkingText(rawResult.translatedText),
    };

    const isDegradedFallback =
      sourceId === 'auto'
        ? Boolean(result.providerLabel?.includes('回退'))
        : result.provider !== sourceId;
    if (!isDegradedFallback) {
      if (translationCache.size >= CACHE_LIMIT) {
        const oldestKey = translationCache.keys().next().value;
        if (oldestKey) translationCache.delete(oldestKey);
      }
      translationCache.set(cacheKey, result);
    }
    return { sourceText: text, effectiveKey: cacheKey, ...result };
  }

  return {
    translate,
    getEffectiveKey,
  };
}
