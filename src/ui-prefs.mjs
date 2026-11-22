import fs from 'node:fs';
import path from 'node:path';

const STORE_VERSION = 1;
export const MIN_CONV_WIDTH = 560;
export const MAX_CONV_WIDTH = 8192;
export const DEFAULT_CONV_WIDTH = 768;

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
    return {
      version: STORE_VERSION,
      ...conv,
    };
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
  const next = {
    ...current,
    version: STORE_VERSION,
    ...conv,
  };
  if (filePath) {
    atomicWriteJson(filePath, next);
  }
  return next;
}
