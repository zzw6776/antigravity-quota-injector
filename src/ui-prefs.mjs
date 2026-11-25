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

export function sanitizeThinkingSourcePref(raw) {
  const clean = String(raw || '').trim().toLowerCase();
  const mapped = LEGACY_THINKING_SOURCE_ALIASES[clean] || clean;
  return VALID_THINKING_SOURCES.has(mapped) ? mapped : 'auto';
}

export function sanitizeFileOpenDefaultPref(raw) {
  const clean = String(raw || '').trim().toLowerCase();
  return VALID_FILE_OPEN_DEFAULTS.has(clean) ? clean : 'builtin';
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
}) {
  const cleanThinking = sanitizeThinkingSourcePref(thinkingSource);
  const cleanFileOpen = sanitizeFileOpenDefaultPref(fileOpenDefault);
  return {
    version: STORE_VERSION,
    ...conv,
    ...(cleanThinking !== 'auto' ? { thinkingTranslateSource: cleanThinking } : {}),
    ...(showCollapsedGroupCount === false ? { showCollapsedGroupCount: false } : {}),
    ...(cleanFileOpen !== 'builtin' ? { fileOpenDefault: cleanFileOpen } : {}),
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
  });
  if (filePath) {
    atomicWriteJson(filePath, next);
  }
  return next;
}
