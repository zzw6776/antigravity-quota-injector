import fs from 'node:fs';
import path from 'node:path';

const STORE_VERSION = 1;
export const MIN_CONV_WIDTH = 560;
export const MAX_CONV_WIDTH = 8192;
export const DEFAULT_CONV_WIDTH = 768;
const LEGACY_THINKING_SOURCE_ALIASES = {
  'easydict-ai-brief': 'ai-brief',
  'easydict-builtin-ai': 'ai-translate',
  'easydict-google': 'google',
  'web-google': 'google',
  'easydict-deepl': 'deepl',
  'easydict-bing': 'bing',
  'easydict-youdao': 'youdao',
};

export const VALID_THINKING_SOURCES = new Set([
  'auto',
  'ai-brief',
  'ai-translate',
  'google',
  'deepl',
  'bing',
  'youdao',
]);

export const VALID_FILE_OPEN_DEFAULTS = new Set([
  'builtin',
  'idea-project',
  'idea-light',
  'vscode',
  'cursor',
  'notepad--',
  'notepad++',
  'sublime',
  'zed',
  'system-text',
]);

export const DEFAULT_QUOTA_COLOR_THEME = 'macos';
export const VALID_QUOTA_COLOR_THEMES = new Set([
  'native',
  'macos',
  'slate-rose',
  'morandi',
  'mono-crit',
]);
const UUID_RE = /^[0-9a-f-]{36}$/i;
const MAX_SAVED_DETACHED_BOUNDS = 48;

export function sanitizeWindowBounds(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const width = Math.round(Number(raw.width ?? raw.w));
  const height = Math.round(Number(raw.height ?? raw.h));
  const x = Math.round(Number(raw.x));
  const y = Math.round(Number(raw.y));
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isFinite(x) ||
    !Number.isFinite(y)
  ) {
    return null;
  }
  if (width < 360 || width > 8192 || height < 280 || height > 8192) {
    return null;
  }
  if (Math.abs(x) > 16384 || Math.abs(y) > 16384) {
    return null;
  }
  return {
    x,
    y,
    width,
    height,
    maximized: Boolean(raw.maximized ?? raw.m),
  };
}

export function sanitizeDetachedWindowBoundsStore(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { last: null, byCid: {} };
  }
  const last = sanitizeWindowBounds(raw.last);
  const rawByCid = raw.byCid && typeof raw.byCid === 'object' && !Array.isArray(raw.byCid) ? raw.byCid : {};
  const entries = [];
  for (const [key, val] of Object.entries(rawByCid)) {
    const cidLower = String(key || '').trim().toLowerCase();
    if (!UUID_RE.test(cidLower)) continue;
    const clean = sanitizeWindowBounds(val);
    if (!clean) continue;
    const updatedAt = Number(val?.updatedAt);
    entries.push([
      cidLower,
      {
        ...clean,
        updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? Math.round(updatedAt) : 0,
      },
    ]);
  }
  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  const byCid = {};
  for (let i = 0; i < Math.min(entries.length, MAX_SAVED_DETACHED_BOUNDS); i += 1) {
    byCid[entries[i][0]] = entries[i][1];
  }
  return { last, byCid };
}

export function resolveSavedDetachedBounds(store, cascadeId) {
  const saved = store?.detachedWindowBounds;
  if (!saved || typeof saved !== 'object') return null;
  const cidLower = String(cascadeId || '').trim().toLowerCase();
  if (UUID_RE.test(cidLower) && saved.byCid?.[cidLower]) {
    const exact = sanitizeWindowBounds(saved.byCid[cidLower]);
    if (exact) {
      return { bounds: exact, applyPosition: true };
    }
  }
  const fallback = sanitizeWindowBounds(saved.last);
  if (fallback) {
    return { bounds: fallback, applyPosition: false };
  }
  return null;
}

export function sanitizeThinkingSourcePref(raw) {
  const clean = String(raw || '').trim().toLowerCase();
  const mapped = LEGACY_THINKING_SOURCE_ALIASES[clean] || clean;
  return VALID_THINKING_SOURCES.has(mapped) ? mapped : 'auto';
}

export function sanitizeFileOpenDefaultPref(raw) {
  const clean = String(raw || '').trim().toLowerCase();
  return VALID_FILE_OPEN_DEFAULTS.has(clean) ? clean : 'builtin';
}

export function sanitizeQuotaColorThemePref(raw) {
  const clean = String(raw || '').trim().toLowerCase();
  return VALID_QUOTA_COLOR_THEMES.has(clean) ? clean : DEFAULT_QUOTA_COLOR_THEME;
}

function atomicWriteJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') {
    fs.chmodSync(tmpPath, 0o600);
  }
  fs.renameSync(tmpPath, filePath);
}

function emptyStore() {
  return {
    version: STORE_VERSION,
    convWidthMode: 'unset',
    convMaxWidth: 0,
  };
}

/**
 * 归一化会话宽度偏好，显式区分未设置（unset）、铺满（full）与固定像素宽度（custom）。
 */
export function sanitizeConvWidthPref({ mode, width } = {}) {
  const cleanMode = String(mode || '').trim().toLowerCase();
  if (cleanMode === 'full') {
    return { convWidthMode: 'full', convMaxWidth: 0 };
  }
  if (cleanMode === 'unset') {
    return { convWidthMode: 'unset', convMaxWidth: 0 };
  }
  const numeric = Number(width);
  if (cleanMode === 'custom' || (!cleanMode && width !== null && width !== '' && Number.isFinite(numeric))) {
    if (Number.isFinite(numeric) && numeric >= MIN_CONV_WIDTH) {
      return {
        convWidthMode: 'custom',
        convMaxWidth: Math.min(MAX_CONV_WIDTH, Math.round(numeric)),
      };
    }
  }
  return { convWidthMode: 'unset', convMaxWidth: 0 };
}

function buildStoreObject({
  conv,
  thinkingSource = 'auto',
  showCollapsedGroupCount = true,
  fileOpenDefault = 'builtin',
  quotaColorTheme = DEFAULT_QUOTA_COLOR_THEME,
  detachedWindowBounds = null,
}) {
  const cleanThinking = sanitizeThinkingSourcePref(thinkingSource);
  const cleanFileOpen = sanitizeFileOpenDefaultPref(fileOpenDefault);
  const cleanQuotaTheme = sanitizeQuotaColorThemePref(quotaColorTheme);
  const cleanBounds = sanitizeDetachedWindowBoundsStore(detachedWindowBounds);
  const hasBounds = Boolean(cleanBounds.last || Object.keys(cleanBounds.byCid).length > 0);
  return {
    version: STORE_VERSION,
    ...conv,
    ...(cleanThinking !== 'auto' ? { thinkingTranslateSource: cleanThinking } : {}),
    ...(showCollapsedGroupCount === false ? { showCollapsedGroupCount: false } : {}),
    ...(cleanFileOpen !== 'builtin' ? { fileOpenDefault: cleanFileOpen } : {}),
    ...(cleanQuotaTheme !== DEFAULT_QUOTA_COLOR_THEME ? { quotaColorTheme: cleanQuotaTheme } : {}),
    ...(hasBounds ? { detachedWindowBounds: cleanBounds } : {}),
  };
}

/**
 * 读取守护进程本地持久化的 UI 偏好，文件缺失或损坏时回退为空状态。
 */
export function readUiPrefsStore(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return emptyStore();
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return emptyStore();
    }
    const conv = sanitizeConvWidthPref({
      mode: parsed.convWidthMode,
      width: parsed.convMaxWidth,
    });
    return buildStoreObject({
      conv,
      thinkingSource: parsed.thinkingTranslateSource,
      showCollapsedGroupCount: parsed.showCollapsedGroupCount !== false,
      fileOpenDefault: parsed.fileOpenDefault,
      quotaColorTheme: parsed.quotaColorTheme,
      detachedWindowBounds: parsed.detachedWindowBounds,
    });
  } catch {
    return emptyStore();
  }
}

/**
 * 更新并原子落盘会话最大宽度设置，用于跨端口与多窗口持久化同步。
 */
export function updateConversationWidthPref(filePath, { mode, width } = {}) {
  const current = readUiPrefsStore(filePath);
  const conv = sanitizeConvWidthPref({ mode, width });
  const next = buildStoreObject({
    conv,
    thinkingSource: current.thinkingTranslateSource,
    showCollapsedGroupCount: current.showCollapsedGroupCount !== false,
    fileOpenDefault: current.fileOpenDefault,
    quotaColorTheme: current.quotaColorTheme,
    detachedWindowBounds: current.detachedWindowBounds,
  });
  if (filePath) {
    atomicWriteJson(filePath, next);
  }
  return next;
}

/**
 * 更新并原子落盘运行中 Thinking 翻译来源偏好。
 */
export function updateThinkingSourcePref(filePath, source) {
  const current = readUiPrefsStore(filePath);
  const next = buildStoreObject({
    conv: { convWidthMode: current.convWidthMode, convMaxWidth: current.convMaxWidth },
    thinkingSource: source,
    showCollapsedGroupCount: current.showCollapsedGroupCount !== false,
    fileOpenDefault: current.fileOpenDefault,
    quotaColorTheme: current.quotaColorTheme,
    detachedWindowBounds: current.detachedWindowBounds,
  });
  if (filePath) {
    atomicWriteJson(filePath, next);
  }
  return next;
}

/**
 * 更新并原子落盘收起文件夹右侧是否展示对话数量偏好（默认开启）。
 */
export function updateShowCollapsedGroupCountPref(filePath, show) {
  const current = readUiPrefsStore(filePath);
  const next = buildStoreObject({
    conv: { convWidthMode: current.convWidthMode, convMaxWidth: current.convMaxWidth },
    thinkingSource: current.thinkingTranslateSource,
    showCollapsedGroupCount: show !== false,
    fileOpenDefault: current.fileOpenDefault,
    quotaColorTheme: current.quotaColorTheme,
    detachedWindowBounds: current.detachedWindowBounds,
  });
  if (filePath) {
    atomicWriteJson(filePath, next);
  }
  return next;
}

/**
 * 更新并原子落盘点击文件名的默认打开方式偏好（默认 builtin 内置预览）。
 */
export function updateFileOpenDefaultPref(filePath, target) {
  const current = readUiPrefsStore(filePath);
  const next = buildStoreObject({
    conv: { convWidthMode: current.convWidthMode, convMaxWidth: current.convMaxWidth },
    thinkingSource: current.thinkingTranslateSource,
    showCollapsedGroupCount: current.showCollapsedGroupCount !== false,
    fileOpenDefault: target,
    quotaColorTheme: current.quotaColorTheme,
    detachedWindowBounds: current.detachedWindowBounds,
  });
  if (filePath) {
    atomicWriteJson(filePath, next);
  }
  return next;
}

/**
 * 更新并原子落盘底栏配额百分比配色方案偏好（默认 macos）。
 */
export function updateQuotaColorThemePref(filePath, theme) {
  const current = readUiPrefsStore(filePath);
  const next = buildStoreObject({
    conv: { convWidthMode: current.convWidthMode, convMaxWidth: current.convMaxWidth },
    thinkingSource: current.thinkingTranslateSource,
    showCollapsedGroupCount: current.showCollapsedGroupCount !== false,
    fileOpenDefault: current.fileOpenDefault,
    quotaColorTheme: theme,
    detachedWindowBounds: current.detachedWindowBounds,
  });
  if (filePath) {
    atomicWriteJson(filePath, next);
  }
  return next;
}

/**
 * 记录独立聊天窗最近的位置与尺寸（同时保留按 cascadeId 的精确映射，最多 48 条 LRU）。
 */
export function updateDetachedWindowBoundsPref(filePath, { cascadeId = '', bounds = null } = {}) {
  const cleanBounds = sanitizeWindowBounds(bounds);
  if (!cleanBounds) return readUiPrefsStore(filePath);
  const current = readUiPrefsStore(filePath);
  const saved = sanitizeDetachedWindowBoundsStore(current.detachedWindowBounds);
  const cidLower = String(cascadeId || '').trim().toLowerCase();
  const sameRect = (a, b) =>
    Boolean(
      a &&
        b &&
        a.x === b.x &&
        a.y === b.y &&
        a.width === b.width &&
        a.height === b.height &&
        Boolean(a.maximized) === Boolean(b.maximized)
    );
  const prevCid = UUID_RE.test(cidLower) ? saved.byCid[cidLower] : null;
  if (sameRect(saved.last, cleanBounds) && (!UUID_RE.test(cidLower) || sameRect(prevCid, cleanBounds))) {
    return current;
  }
  const nextByCid = { ...saved.byCid };
  if (UUID_RE.test(cidLower)) {
    nextByCid[cidLower] = { ...cleanBounds, updatedAt: Date.now() };
  }
  const next = buildStoreObject({
    conv: { convWidthMode: current.convWidthMode, convMaxWidth: current.convMaxWidth },
    thinkingSource: current.thinkingTranslateSource,
    showCollapsedGroupCount: current.showCollapsedGroupCount !== false,
    fileOpenDefault: current.fileOpenDefault,
    quotaColorTheme: current.quotaColorTheme,
    detachedWindowBounds: { last: cleanBounds, byCid: nextByCid },
  });
  if (filePath) {
    atomicWriteJson(filePath, next);
  }
  return next;
}
