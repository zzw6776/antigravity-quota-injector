import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAsset, isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';

import {
  deleteAccount,
  getAccountSwitchSupport,
  listAccounts,
  prepareNewAccountWithRestart,
  readLastLoginEmail,
  reorderAccounts,
  snapshotCurrentAccount,
  switchAccountWithRestart,
  updateAccountQuotaSnapshot,
} from './accounts.mjs';
import {
  addConversationToGroup,
  createConversationGroup,
  deleteConversationGroup,
  moveConversationBetweenGroups,
  moveConversationGroup,
  readConversationGroupsStore,
  removeConversationFromGroup,
  renameConversationGroup,
  reorderConversationGroupItems,
  reorderConversationGroups,
  syncConversationMetadata,
  toggleConversationGroupCollapse,
} from './conversation-groups.mjs';
import {
  createFollowAppController,
  isAntigravityProcessRunning,
  stopDaemonPid,
} from './platform.mjs';
import {
  computeBatchEligibleSummary,
  createBatchKeepAliveStore,
  planBatchKeepAliveRun,
} from './batch-keepalive.mjs';
import { createKeepAliveManager } from './keepalive.mjs';
import {
  extractLatestTurnThinking,
  getDbSignature,
  parseConversationTurns,
  resolveConversationDbPath,
} from './proto-metrics.mjs';
import {
  createThinkingTranslator,
  normalizeThinkingTranslateSource,
} from './thinking-translator.mjs';
import {
  detectExternalEditors,
  executeExternalFileAction,
} from './external-editors.mjs';
import {
  buildEarlyDetachedBootstrapExpression,
  createDetachedWindowCoordinator,
  formatShortcutHint,
  openMacAccessibilitySettings,
  raiseAntigravityWindowByTitle,
  triggerNativeNewWindowViaCdp,
} from './detached-window.mjs';
import { TokenPricingManager } from './token-pricing.mjs';
import {
  readUiPrefsStore,
  updateConversationWidthPref,
  updateFileOpenDefaultPref,
  updateShowCollapsedGroupCountPref,
  updateThinkingSourcePref,
} from './ui-prefs.mjs';

function sendSystemNotification({ title = '', message = '' } = {}) {
  if (process.platform !== 'darwin' || process.env.NODE_TEST_CONTEXT) return;
  const cleanTitle = String(title || '').trim();
  const cleanMsg = String(message || '').trim();
  if (!cleanTitle || !cleanMsg) return;
  try {
    execFile(
      'osascript',
      [
        '-e',
        'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run',
        cleanTitle,
        cleanMsg,
      ],
      { timeout: 3000 },
      () => {}
    );
  } catch {}
}

function resolveSrcDir() {
  if (typeof __dirname === 'string') return __dirname;
  return path.dirname(fileURLToPath(import.meta.url));
}

export function readAssetText(assetName) {
  if (isSea()) {
    return String(getAsset(assetName, 'utf8'));
  }
  return fs.readFileSync(path.join(resolveSrcDir(), assetName), 'utf8');
}

export function readPackageVersion() {
  try {
    if (isSea()) {
      return String(JSON.parse(getAsset('package.json', 'utf8')).version || '0.0.0');
    }
    const pkgPath = path.resolve(resolveSrcDir(), '..', 'package.json');
    return String(JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

const UUID_RE = /^[0-9a-f-]{36}$/i;
const ALLOWED_ORIGIN_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/i;

export function getAppDataPaths(channel = 'stable') {
  const home = os.homedir();
  const isInsiders = channel === 'insiders';
  const appDirName = isInsiders ? 'Antigravity - Insiders' : 'Antigravity';
  const geminiSubDir = isInsiders ? '.gemini/antigravity-insiders' : '.gemini/antigravity';

  let portFile;
  if (process.platform === 'darwin') {
    portFile = path.join(home, 'Library', 'Application Support', appDirName, 'DevToolsActivePort');
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    portFile = path.join(appData, appDirName, 'DevToolsActivePort');
  } else {
    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    portFile = path.join(xdgConfig, appDirName, 'DevToolsActivePort');
  }

  const stateDir = path.join(home, '.gemini', 'antigravity', 'quota-injector');
  return {
    channel,
    portFile,
    appSupportDir: path.dirname(portFile),
    conversationsDir: path.join(home, geminiSubDir, 'conversations'),
    stateDir,
    accountsFile: path.join(stateDir, 'accounts.json'),
    groupsFile: path.join(stateDir, 'conversation-groups.json'),
    uiPrefsFile: path.join(stateDir, 'ui-prefs.json'),
  };
}

export function readDebugPort(portFile) {
  try {
    if (!fs.existsSync(portFile)) return null;
    const raw = fs.readFileSync(portFile, 'utf8').trim();
    const firstLine = raw.split(/\r?\n/)[0]?.trim();
    const port = Number.parseInt(firstLine, 10);
    return Number.isFinite(port) && port > 0 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

export async function fetchCdpTargets(port) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: ctrl.signal });
    if (!res.ok) return [];
    const list = await res.json();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

const DEFAULT_USER_CONFIG = {
  codexTheme: true,
  zhUi: true,
  antigravityExe: '',
  aiApiKey: '',
  aiEndpoint: '',
  aiModel: '',
  aiBriefPrompt: '',
  ideaPath: '',
  notepadPath: '',
};

export function maskSecretKey(rawKey) {
  const clean = String(rawKey || '').trim();
  if (!clean) return '';
  if (clean.length <= 8) return `${clean.slice(0, 2)}****`;
  return `${clean.slice(0, 4)}****${clean.slice(-4)}`;
}

export function readUserConfig(stateDir) {
  try {
    const cfgPath = path.join(stateDir, 'config.json');
    if (!fs.existsSync(cfgPath)) {
      return { ...DEFAULT_USER_CONFIG };
    }
    const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return {
      codexTheme: parsed?.codexTheme !== false,
      zhUi: parsed?.zhUi !== false,
      antigravityExe: typeof parsed?.antigravityExe === 'string' ? parsed.antigravityExe.trim() : '',
      aiApiKey: typeof parsed?.aiApiKey === 'string' ? parsed.aiApiKey.trim() : '',
      aiEndpoint: typeof parsed?.aiEndpoint === 'string' ? parsed.aiEndpoint.trim() : '',
      aiModel: typeof parsed?.aiModel === 'string' ? parsed.aiModel.trim() : '',
      aiBriefPrompt: typeof parsed?.aiBriefPrompt === 'string' ? parsed.aiBriefPrompt.trim() : '',
      ideaPath: typeof parsed?.ideaPath === 'string' ? parsed.ideaPath.trim() : '',
      notepadPath: typeof parsed?.notepadPath === 'string' ? parsed.notepadPath.trim() : '',
    };
  } catch {
    return { ...DEFAULT_USER_CONFIG };
  }
}

export function writeUserConfig(stateDir, patch = {}) {
  if (!stateDir) return { ...DEFAULT_USER_CONFIG };
  fs.mkdirSync(stateDir, { recursive: true });
  const cfgPath = path.join(stateDir, 'config.json');
  let rawObj = {};
  try {
    if (fs.existsSync(cfgPath)) {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        rawObj = { ...parsed };
      }
    }
  } catch {}

  const stringFields = ['aiApiKey', 'aiEndpoint', 'aiModel', 'aiBriefPrompt', 'antigravityExe', 'ideaPath', 'notepadPath'];
  for (let i = 0; i < stringFields.length; i++) {
    const key = stringFields[i];
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      const val = String(patch[key] ?? '').trim();
      if (val) {
        rawObj[key] = val;
      } else {
        delete rawObj[key];
      }
    }
  }

  const tmpPath = `${cfgPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(rawObj, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') {
    fs.chmodSync(tmpPath, 0o600);
  }
  fs.renameSync(tmpPath, cfgPath);
  return readUserConfig(stateDir);
}

const CLIENT_SCRIPT_ASSETS = ['formatting.mjs', 'i18n-zh.mjs', 'codex-theme.css', 'client-inject.js'];
let cachedClientBuild = null;

function getClientAssetsSignature() {
  if (isSea()) return 'sea';
  const srcDir = resolveSrcDir();
  const parts = [];
  for (let i = 0; i < CLIENT_SCRIPT_ASSETS.length; i++) {
    try {
      const st = fs.statSync(path.join(srcDir, CLIENT_SCRIPT_ASSETS[i]), { throwIfNoEntry: false });
      parts.push(st ? `${st.mtimeMs}:${st.size}` : '0:0');
    } catch {
      parts.push('0:0');
    }
  }
  return parts.join('|');
}

export function buildClientScript({ codexTheme = true, zhUi = true } = {}) {
  const normTheme = Boolean(codexTheme);
  const normZh = Boolean(zhUi);
  const cacheKey = `${normTheme ? 1 : 0}|${normZh ? 1 : 0}|${getClientAssetsSignature()}`;
  if (cachedClientBuild && cachedClientBuild.cacheKey === cacheKey) {
    return { version: cachedClientBuild.version, script: cachedClientBuild.script };
  }
  const fmtSource = readAssetText('formatting.mjs').replace(
    /^\s*export\s+(?=(?:function|const|let|var)\b)/gm,
    ''
  );
  const i18nSource = normZh
    ? readAssetText('i18n-zh.mjs').replace(/^\s*export\s+(?=(?:function|const|let|var)\b)/gm, '')
    : 'function translateUiText() { return null; }';
  const themeCss = normTheme ? readAssetText('codex-theme.css') : '';
  const clientTemplate = readAssetText('client-inject.js');
  const hash = crypto
    .createHash('sha256')
    .update(fmtSource)
    .update(i18nSource)
    .update(themeCss)
    .update(clientTemplate)
    .digest('hex')
    .slice(0, 10);
  const version = `aq-${hash}`;
  const script = clientTemplate
    .replaceAll('__AQ_VERSION__', () => version)
    .replace('__AQ_CODEX_THEME_CSS__', () => JSON.stringify(themeCss))
    .replace('// __AQ_FORMATTING_HELPERS__', () => fmtSource)
    .replace('// __AQ_I18N_HELPERS__', () => i18nSource);
  cachedClientBuild = { cacheKey, version, script };
  return { version, script };
}

function createCdpClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    const bindingListeners = new Set();
    const closeListeners = new Set();

    const connectTimer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error('CDP WebSocket connect timeout'));
    }, 2500);

    ws.addEventListener('open', () => {
      clearTimeout(connectTimer);
      resolve({
        send(method, params = {}) {
          return new Promise((res) => {
            if (ws.readyState !== WebSocket.OPEN) return res(null);
            const id = nextId++;
            const t = setTimeout(() => {
              pending.delete(id);
              res(null);
            }, 3000);
            pending.set(id, (msg) => {
              clearTimeout(t);
              res(msg);
            });
            try {
              ws.send(JSON.stringify({ id, method, params }));
            } catch {
              clearTimeout(t);
              pending.delete(id);
              res(null);
            }
          });
        },
        onBinding(fn) {
          bindingListeners.add(fn);
        },
        onClose(fn) {
          closeListeners.add(fn);
        },
        isOpen() {
          return ws.readyState === WebSocket.OPEN;
        },
        close() {
          try {
            ws.close();
          } catch {}
        },
      });
    });

    ws.addEventListener('error', (err) => {
      clearTimeout(connectTimer);
      reject(err);
    });

    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.id && pending.has(msg.id)) {
          const cb = pending.get(msg.id);
          pending.delete(msg.id);
          cb(msg);
          return;
        }
        if (msg.method === 'Runtime.bindingCalled') {
          for (const fn of bindingListeners) fn(msg.params);
        }
      } catch {}
    });

    ws.addEventListener('close', () => {
      for (const [, cb] of pending) cb(null);
      pending.clear();
      for (const fn of closeListeners) fn();
    });
  });
}

export async function cleanupOpenTargets(channel = 'stable') {
  const { portFile } = getAppDataPaths(channel);
  const port = readDebugPort(portFile);
  if (!port) return 0;
  const targets = await fetchCdpTargets(port);
  let cleaned = 0;
  for (const t of targets) {
    if (t.type !== 'page' || !ALLOWED_ORIGIN_RE.test(String(t.url || '')) || !t.webSocketDebuggerUrl) continue;
    try {
      const client = await createCdpClient(t.webSocketDebuggerUrl);
      await client.send('Runtime.evaluate', {
        expression: 'window.__aqCleanup && window.__aqCleanup()',
        returnByValue: true,
      });
      client.close();
      cleaned += 1;
    } catch {}
  }
  return cleaned;
}

export async function stopRunningDaemon(channel = 'stable') {
  const { stateDir } = getAppDataPaths(channel);
  const pidFile = path.join(stateDir, `daemon-${channel}.pid`);
  if (!fs.existsSync(pidFile)) return false;
  const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
  const stopped = pid > 0 && pid !== process.pid ? await stopDaemonPid(pid) : false;
  try {
    if (fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() === String(pid)) {
      fs.unlinkSync(pidFile);
    }
  } catch {}
  return stopped;
}

const TARGET_PROBE_BACKOFF_MS = [0, 0, 2_000, 3_000, 5_000, 10_000, 60_000];
const TARGET_LOADING_GRACE_LIMIT = 20;

export function createTargetAttachTracker({
  nowFn = () => Date.now(),
  backoffScheduleMs = TARGET_PROBE_BACKOFF_MS,
  loadingGraceLimit = TARGET_LOADING_GRACE_LIMIT,
} = {}) {
  const states = new Map(); // targetId -> { fails, loadingPolls, until }

  return {
    shouldSkip(targetId) {
      const entry = states.get(targetId);
      return Boolean(entry && entry.until > nowFn());
    },
    markSuccess(targetId) {
      states.delete(targetId);
    },
    markFailure(targetId, { readyState = '' } = {}) {
      const prev = states.get(targetId) || { fails: 0, loadingPolls: 0, until: 0 };
      const isLoading = Boolean(readyState && readyState !== 'complete');
      if (isLoading && prev.loadingPolls < loadingGraceLimit) {
        const next = {
          fails: prev.fails,
          loadingPolls: prev.loadingPolls + 1,
          until: 0,
        };
        states.set(targetId, next);
        return next;
      }
      const nextFails = prev.fails + 1;
      const idx = Math.min(nextFails - 1, backoffScheduleMs.length - 1);
      const delayMs = Math.max(0, Number(backoffScheduleMs[idx] ?? 60_000));
      const next = {
        fails: nextFails,
        loadingPolls: prev.loadingPolls,
        until: delayMs > 0 ? nowFn() + delayMs : 0,
      };
      states.set(targetId, next);
      return next;
    },
    prune(liveIds) {
      for (const tid of states.keys()) {
        if (!liveIds.has(tid)) states.delete(tid);
      }
    },
    reset() {
      states.clear();
    },
    getState(targetId) {
      return states.get(targetId) || null;
    },
  };
}

export async function runDaemon({
  once = false,
  channel = 'stable',
  followApp = false,
  startupGraceMs = 60_000,
  exitConfirmTicks = 3,
  skipKillExistingPid = false,
  updateManager = null,
  onRegisterControls = null,
  log = console.log,
} = {}) {
  const paths = getAppDataPaths(channel);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const pidFile = path.join(paths.stateDir, `daemon-${channel}.pid`);

  if (!once) {
    try {
      if (!skipKillExistingPid && fs.existsSync(pidFile)) {
        const existingPid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
        if (existingPid > 0 && existingPid !== process.pid) {
          await stopDaemonPid(existingPid);
        }
      }
      fs.writeFileSync(pidFile, `${process.pid}\n`, 'utf8');
    } catch {}
  }

  let userCfg = readUserConfig(paths.stateDir);
  let { version, script } = buildClientScript(userCfg);
  const accountSupport = getAccountSwitchSupport();
  const followController = followApp
    ? createFollowAppController({ startupGraceMs, exitConfirmTicks })
    : null;
  const keepAliveManager = createKeepAliveManager({ stateDir: paths.stateDir });
  const thinkingTranslator = createThinkingTranslator({
    getAiConfig: () => ({
      apiKey: userCfg.aiApiKey,
      endpoint: userCfg.aiEndpoint,
      model: userCfg.aiModel,
      briefPrompt: userCfg.aiBriefPrompt,
    }),
  });
  const batchStore = createBatchKeepAliveStore();
  let batchDriverInFlight = false;
  const attached = new Map(); // targetId -> session state
  const attachingIds = new Set(); // in-flight attachTarget guard
  const focusInFlight = new Map(); // targetId -> Promise<focusRes>
  const targetAttachTracker = createTargetAttachTracker();
  const detachedWindows = createDetachedWindowCoordinator();
  let pendingDetachedRestore = null;
  let batchSavedDetachedItems = [];
  let lastDetachedBroadcastSig = '';
  let lastAccessibilityPromptAt = 0;
  const turnsCache = new Map(); // dbPath -> { sig, payload }
  let stopping = false;
  let switchInFlight = false;
  let externalRestartInFlight = false;
  let wakeLoop = null;
  let sleepTimer = null;

  const wakeDaemonLoop = () => {
    if (sleepTimer) {
      clearTimeout(sleepTimer);
      sleepTimer = null;
    }
    if (wakeLoop) {
      const fn = wakeLoop;
      wakeLoop = null;
      fn();
    }
  };

  const pricingManager = new TokenPricingManager({
    stateDir: paths.stateDir,
    refreshOnInitialize: !once,
  });
  await pricingManager.initialize();
  const unsubscribePricing = pricingManager.onChange(() => {
    wakeDaemonLoop();
  });

  const pushUpdateToSession = async (session) => {
    if (!session?.client?.isOpen() || !session.hostConfirmed) return;
    const payload = updateManager
      ? updateManager.getState()
      : {
          currentVersion: readPackageVersion(),
          mode: isSea() ? 'formal' : 'dev',
          enabled: false,
          canAutoUpdate: false,
          available: false,
          opening: false,
          status: 'idle',
        };
    try {
      await session.client.send('Runtime.evaluate', {
        expression: `window.__aqRenderUpdate && window.__aqRenderUpdate(${JSON.stringify(payload)})`,
        returnByValue: false,
      });
    } catch {}
  };

  const pushUpdateToAllSessions = async () => {
    for (const s of attached.values()) {
      await pushUpdateToSession(s);
    }
  };

  const handleUpdateAction = async (rawPayload) => {
    if (!updateManager) return;
    let msg;
    try {
      msg = JSON.parse(String(rawPayload || '{}'));
    } catch {
      return;
    }
    const type = String(msg?.type || '');
    if (type === 'check') {
      await updateManager.checkNow({ manual: false });
    } else if (type === 'open') {
      await updateManager.openUpdate?.({ requestId: msg?.requestId ?? null });
    } else if (type === 'install') {
      await updateManager.installUpdate();
    } else if (type === 'open-release') {
      updateManager.openReleasePage();
    }
  };

  const unsubscribeUpdate = updateManager?.subscribe?.(() => {
    void pushUpdateToAllSessions();
  });

  const resolveSessionEmail = (session, preferred = '') => {
    const clean = String(preferred || session?.activeEmail || '').trim();
    if (clean) return clean;
    const stored = readLastLoginEmail(paths.appSupportDir);
    if (stored && session) session.activeEmail = stored;
    return stored;
  };

  const pushAccountsToSession = async (session, extra = {}) => {
    if (!session?.client?.isOpen() || !session.hostConfirmed) return;
    const activeEmail = extra.resolvedEmail !== undefined
      ? extra.resolvedEmail
      : resolveSessionEmail(session, extra.activeEmail);
    const accountsList = Array.isArray(extra.accounts)
      ? extra.accounts
      : accountSupport.supported
        ? listAccounts(paths.accountsFile, activeEmail)
        : [];
    const batchSummary = extra.batchSummary || (
      accountSupport.supported
        ? computeBatchEligibleSummary({
            accounts: accountsList,
            activeEmail,
            getKeepAliveState: (email) => keepAliveManager.getState(email),
          })
        : { eligibleCount: 0, hasEnabledSwitch: false, note: accountSupport.reason || '' }
    );
    const payload = {
      supported: accountSupport.supported,
      unsupportedReason: accountSupport.reason,
      accounts: accountsList,
      batchSummary,
      busy: Boolean(extra.busy ?? (switchInFlight || batchStore.getRaw().active)),
      status: String(extra.status || ''),
      error: String(extra.error || ''),
    };
    try {
      await session.client.send('Runtime.evaluate', {
        expression: `window.__aqRenderAccounts && window.__aqRenderAccounts(${JSON.stringify(payload)})`,
        returnByValue: false,
      });
    } catch {}
  };

  const pushAccountsToAllSessions = async (extra = {}) => {
    const sessions = [...attached.values()];
    if (sessions.length === 0) return;
    let fallbackEmail;
    let baseList = null;
    const accountsByEmail = new Map();
    const summaryByEmail = new Map();
    if (accountSupport.supported && !Array.isArray(extra.accounts)) {
      baseList = listAccounts(paths.accountsFile, '');
    }
    const resolveSharedAccounts = (email) => {
      if (Array.isArray(extra.accounts)) return extra.accounts;
      if (!accountSupport.supported || !baseList) return [];
      const key = String(email || '').trim().toLowerCase();
      if (!accountsByEmail.has(key)) {
        accountsByEmail.set(
          key,
          baseList.map((item) => ({
            ...item,
            active: Boolean(key && item.email.toLowerCase() === key),
          }))
        );
      }
      return accountsByEmail.get(key);
    };
    const resolveSharedSummary = (email, accountsForEmail) => {
      if (extra.batchSummary) return extra.batchSummary;
      if (!accountSupport.supported) {
        return { eligibleCount: 0, hasEnabledSwitch: false, note: accountSupport.reason || '' };
      }
      const key = String(email || '').trim().toLowerCase();
      if (!summaryByEmail.has(key)) {
        summaryByEmail.set(
          key,
          computeBatchEligibleSummary({
            accounts: accountsForEmail,
            activeEmail: email,
            getKeepAliveState: (acctEmail) => keepAliveManager.getState(acctEmail),
          })
        );
      }
      return summaryByEmail.get(key);
    };
    await Promise.allSettled(
      sessions.map((s) => {
        let resolvedEmail = String(extra.activeEmail || s?.activeEmail || '').trim();
        if (!resolvedEmail) {
          if (fallbackEmail === undefined) {
            fallbackEmail = readLastLoginEmail(paths.appSupportDir);
          }
          resolvedEmail = fallbackEmail;
          if (resolvedEmail && s) s.activeEmail = resolvedEmail;
        }
        const accountsForEmail = resolveSharedAccounts(resolvedEmail);
        return pushAccountsToSession(s, {
          ...extra,
          resolvedEmail,
          accounts: accountsForEmail,
          batchSummary: resolveSharedSummary(resolvedEmail, accountsForEmail),
        });
      })
    );
  };

  const pushGroupsToSession = async (session, extra = {}) => {
    if (!session?.client?.isOpen() || !session.hostConfirmed) return;
    const store = extra.store || readConversationGroupsStore(paths.groupsFile);
    const payload = {
      collapsedSection: Boolean(store.collapsedSection),
      groups: Array.isArray(store.groups) ? store.groups : [],
      error: String(extra.error || ''),
    };
    try {
      await session.client.send('Runtime.evaluate', {
        expression: `window.__aqRenderGroups && window.__aqRenderGroups(${JSON.stringify(payload)})`,
        returnByValue: false,
      });
    } catch {}
  };

  const pushGroupsToAllSessions = async (extra = {}) => {
    const store = extra.store || readConversationGroupsStore(paths.groupsFile);
    for (const s of attached.values()) {
      await pushGroupsToSession(s, { ...extra, store });
    }
  };

  let cachedEditors = null;
  let cachedEditorsAt = 0;
  let cachedEditorsKey = '';
  const getDetectedEditors = (force = false) => {
    const now = Date.now();
    const key = `${userCfg.ideaPath || ''}\0${userCfg.notepadPath || ''}`;
    if (!force && cachedEditors && cachedEditorsKey === key && now - cachedEditorsAt < 15_000) {
      return cachedEditors;
    }
    cachedEditors = detectExternalEditors({
      customIdeaPath: userCfg.ideaPath || '',
      customNotepadPath: userCfg.notepadPath || '',
    });
    cachedEditorsAt = now;
    cachedEditorsKey = key;
    return cachedEditors;
  };

  const pushUiPrefsToSession = async (session, extra = {}) => {
    if (!session?.client?.isOpen() || !session.hostConfirmed) return;
    const store = extra.store || readUiPrefsStore(paths.uiPrefsFile);
    const editors = getDetectedEditors(Boolean(extra.refreshEditors));
    const envAiKey = String(process.env.AQ_AI_API_KEY || process.env.ZHIPU_API_KEY || '').trim();
    const effectiveAiKey = userCfg.aiApiKey || envAiKey;
    const payload = {
      convWidthMode: store.convWidthMode,
      convMaxWidth: store.convMaxWidth,
      thinkingTranslateSource: store.thinkingTranslateSource || 'auto',
      showCollapsedGroupCount: store.showCollapsedGroupCount !== false,
      fileOpenDefault: store.fileOpenDefault || 'builtin',
      externalEditors: {
        platform: editors.platform || process.platform,
        options: Array.isArray(editors.options) ? editors.options : [],
      },
      aiKeyConfigured: Boolean(effectiveAiKey),
      aiApiKey: userCfg.aiApiKey || '',
      hasEnvAiKey: Boolean(envAiKey),
      aiKeySource: userCfg.aiApiKey ? 'config' : envAiKey ? 'env' : '',
      aiEndpoint: userCfg.aiEndpoint || '',
      aiModel: userCfg.aiModel || '',
      ...(extra.aiSavedRequestId ? { aiSavedRequestId: String(extra.aiSavedRequestId) } : {}),
      ...(extra.aiSaveError ? { aiSaveError: String(extra.aiSaveError) } : {}),
    };
    try {
      await session.client.send('Runtime.evaluate', {
        expression: `window.__aqRenderUiPrefs && window.__aqRenderUiPrefs(${JSON.stringify(payload)})`,
        returnByValue: false,
      });
    } catch {}
  };

  const pushUiPrefsToAllSessions = async (extra = {}) => {
    const store = extra.store || readUiPrefsStore(paths.uiPrefsFile);
    for (const s of attached.values()) {
      await pushUiPrefsToSession(s, { ...extra, store });
    }
  };

  const handleUiPrefsAction = async (session, rawPayload) => {
    let msg;
    try {
      msg = JSON.parse(String(rawPayload || '{}'));
    } catch {
      return;
    }
    const type = String(msg?.type || '');
    if (type === 'get') {
      userCfg = readUserConfig(paths.stateDir);
      await pushUiPrefsToSession(session, { refreshEditors: true });
      return;
    }
    if (type === 'set-conv-width') {
      const store = updateConversationWidthPref(paths.uiPrefsFile, {
        mode: msg?.mode,
        width: msg?.width,
      });
      await pushUiPrefsToAllSessions({ store });
      return;
    }
    if (type === 'set-thinking-source') {
      const store = updateThinkingSourcePref(paths.uiPrefsFile, msg?.source);
      await pushUiPrefsToAllSessions({ store });
      return;
    }
    if (type === 'set-show-collapsed-group-count') {
      const store = updateShowCollapsedGroupCountPref(paths.uiPrefsFile, msg?.show !== false);
      await pushUiPrefsToAllSessions({ store });
      return;
    }
    if (type === 'set-file-open-default') {
      const store = updateFileOpenDefaultPref(paths.uiPrefsFile, msg?.target);
      await pushUiPrefsToAllSessions({ store });
      return;
    }
    if (type === 'set-ai-config') {
      const reqId = typeof msg?.requestId === 'string' ? msg.requestId : '';
      const patch = {};
      if (msg?.clearKey === true) {
        patch.aiApiKey = '';
      } else if (typeof msg?.apiKey === 'string') {
        patch.aiApiKey = msg.apiKey.trim();
      }
      if (typeof msg?.endpoint === 'string') {
        patch.aiEndpoint = msg.endpoint.trim();
      }
      if (typeof msg?.model === 'string') {
        patch.aiModel = msg.model.trim();
      }
      try {
        userCfg = writeUserConfig(paths.stateDir, patch);
        for (const s of attached.values()) {
          s.lastThinkingPushSig = '';
        }
        await pushUiPrefsToAllSessions({ aiSavedRequestId: reqId });
      } catch (err) {
        await pushUiPrefsToSession(session, {
          aiSavedRequestId: reqId,
          aiSaveError: String(err?.message || '保存本地配置失败'),
        });
      }
    }
  };

  const handleFileAction = async (session, rawPayload) => {
    let msg;
    try {
      msg = JSON.parse(String(rawPayload || '{}'));
    } catch {
      return;
    }
    const action = msg?.type === 'reveal' ? 'reveal' : 'open';
    const res = await executeExternalFileAction(
      {
        action,
        mode: String(msg?.mode || 'idea-project'),
        uri: String(msg?.uri || ''),
        line: msg?.line ?? null,
        column: msg?.column ?? null,
        customIdeaPath: userCfg.ideaPath || '',
        customNotepadPath: userCfg.notepadPath || '',
      },
      { editors: getDetectedEditors() }
    );
    if (!res?.ok && res?.error && session?.client?.isOpen()) {
      try {
        await session.client.send('Runtime.evaluate', {
          expression: `window.__aqShowFileToast && window.__aqShowFileToast(${JSON.stringify({
            ok: false,
            message: String(res.error),
          })})`,
          returnByValue: false,
        });
      } catch {}
    }
  };

  const pushDetachedWindowState = async (session, payload) => {
    if (!session?.client?.isOpen() || !session.hostConfirmed) return;
    try {
      await session.client.send('Runtime.evaluate', {
        expression: `window.__aqApplyDetachedWindow && window.__aqApplyDetachedWindow(${JSON.stringify(payload)})`,
        returnByValue: false,
      });
    } catch {}
  };

  const pushWindowActionStatus = async (session, payload) => {
    if (!session?.client?.isOpen() || !session.hostConfirmed) return;
    try {
      await session.client.send('Runtime.evaluate', {
        expression: `window.__aqWindowActionStatus && window.__aqWindowActionStatus(${JSON.stringify(payload)})`,
        returnByValue: false,
      });
    } catch {}
  };

  const snapshotPageTargetIds = async () => {
    const port = readDebugPort(paths.portFile);
    if (!port) return new Set(attached.keys());
    const targets = await fetchCdpTargets(port);
    const ids = new Set(attached.keys());
    for (let i = 0; i < targets.length; i += 1) {
      const t = targets[i];
      if (t?.type === 'page' && ALLOWED_ORIGIN_RE.test(String(t.url || '')) && t.id) {
        ids.add(t.id);
      }
    }
    return ids;
  };

  const waitForDetachedClaim = async (requestId, baselineTargetIds) => {
    const initialDeadline = Date.now() + 1_200;
    let deadline = initialDeadline;
    let sawNewTarget = false;

    while (!stopping && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, sawNewTarget ? 80 : 60));
      if (stopping) return { claimed: false, sawNewTarget };
      if (!detachedWindows.hasRequest(requestId)) {
        return { claimed: true, sawNewTarget };
      }
      const port = readDebugPort(paths.portFile);
      if (port) {
        const targets = await fetchCdpTargets(port);
        const newTargets = [];
        for (let i = 0; i < targets.length; i += 1) {
          const t = targets[i];
          if (
            t?.type === 'page' &&
            ALLOWED_ORIGIN_RE.test(String(t.url || '')) &&
            t.id &&
            !baselineTargetIds.has(t.id)
          ) {
            newTargets.push(t);
          }
        }
        if (newTargets.length > 0) {
          if (!sawNewTarget) {
            sawNewTarget = true;
            deadline = Math.max(deadline, Date.now() + 5_000);
          }
          const unattached = newTargets.filter((t) => !attached.has(t.id) && !attachingIds.has(t.id));
          if (unattached.length > 0) {
            await Promise.allSettled(unattached.map((t) => attachTarget(t)));
          }
        }
      }
      if (!detachedWindows.hasRequest(requestId)) {
        return { claimed: true, sawNewTarget };
      }
    }
    return {
      claimed: !detachedWindows.hasRequest(requestId),
      sawNewTarget,
    };
  };

  const collectActiveDetachedCascadeIds = () => {
    const seen = new Set();
    const list = [];
    for (const s of attached.values()) {
      if (!s?.client?.isOpen() || !s.hostConfirmed) continue;
      if (!detachedWindows.isDetachedTarget(s.targetId)) continue;
      const cid = String(s.pendingDetach?.cascadeId || s.activeCascadeId || '').trim();
      if (!UUID_RE.test(cid)) continue;
      const key = cid.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(key);
    }
    list.sort();
    return list;
  };

  const pushDetachedWindowsToSession = async (session, cascadeIds = null) => {
    if (!session?.client?.isOpen() || !session.hostConfirmed) return;
    const list = Array.isArray(cascadeIds) ? cascadeIds : collectActiveDetachedCascadeIds();
    try {
      await session.client.send('Runtime.evaluate', {
        expression: `window.__aqRenderDetachedWindows && window.__aqRenderDetachedWindows(${JSON.stringify({
          cascadeIds: list,
        })})`,
        returnByValue: false,
      });
    } catch {}
  };

  const pushDetachedWindowsToAllSessions = async ({ force = false } = {}) => {
    const list = collectActiveDetachedCascadeIds();
    const sig = list.join(',');
    if (!force && sig === lastDetachedBroadcastSig) return;
    lastDetachedBroadcastSig = sig;
    await Promise.allSettled(
      [...attached.values()].map((s) => pushDetachedWindowsToSession(s, list))
    );
  };

  const findExistingDetachedSessionByCid = (cid, { excludeTargetId = '' } = {}) => {
    const cidLower = String(cid || '').trim().toLowerCase();
    if (!cidLower) return null;
    for (const s of attached.values()) {
      if (!s?.client?.isOpen() || !s.hostConfirmed) continue;
      if (excludeTargetId && s.targetId === excludeTargetId) continue;
      if (!detachedWindows.isDetachedTarget(s.targetId)) continue;
      const sCid = String(s.pendingDetach?.cascadeId || s.activeCascadeId || '').trim().toLowerCase();
      if (sCid === cidLower) return s;
    }
    return null;
  };

  const snapshotOpenDetachedWindows = async () => {
    const sessions = [...attached.values()].filter((s) => s?.client?.isOpen() && s.hostConfirmed);
    if (sessions.length === 0) return [];
    const results = await Promise.allSettled(
      sessions.map(async (s) => {
        const evalRes = await s.client.send('Runtime.evaluate', {
          expression: `(() => {
            const detached = document.documentElement?.getAttribute?.('data-aq-detached-chat') === '1';
            const watched = window.__aqGetWatchedCascadeId ? window.__aqGetWatchedCascadeId() : '';
            const urlMatch = String(window.location?.pathname || '').match(/\\/c\\/([0-9a-f-]{36})/i);
            const cid = watched || (urlMatch ? urlMatch[1] : '');
            const title = String(document.title || '').replace(/\\s*-\\s*Antigravity$/i, '').trim();
            return { detached, cid, title };
          })()`,
          returnByValue: true,
        });
        const val = evalRes?.result?.result?.value;
        const detached = typeof val?.detached === 'boolean' ? val.detached : detachedWindows.isDetachedTarget(s.targetId);
        const cid = String(val?.cid || s.pendingDetach?.cascadeId || s.activeCascadeId || '').trim();
        const title = String(val?.title || '').trim();
        return { detached, cid, title };
      })
    );
    const seen = new Set();
    const items = [];
    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value?.detached) continue;
      const cid = r.value.cid;
      if (!UUID_RE.test(cid)) continue;
      const key = cid.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ cascadeId: cid, title: r.value.title || '' });
      if (items.length >= 8) break;
    }
    return items;
  };

  const scheduleDetachedRestoreAfterRestart = (items, prevTargetIds) => {
    const list = Array.isArray(items)
      ? items.filter((it) => UUID_RE.test(String(it?.cascadeId || '').trim()))
      : [];
    if (list.length === 0) {
      pendingDetachedRestore = null;
      return;
    }
    pendingDetachedRestore = {
      items: list,
      prevTargetIds: new Set(prevTargetIds || []),
      armedAt: Date.now(),
      expiresAt: Date.now() + 35_000,
      running: false,
    };
    log(`[detached-window] scheduled auto-restore for ${list.length} detached window(s) after account switch`);
    wakeDaemonLoop();
  };

  const focusDetachedSession = async (targetSession, { promptIfUntrusted = true } = {}) => {
    if (!targetSession?.client?.isOpen() || !targetSession.hostConfirmed) {
      return { ok: false, reason: 'target-closed' };
    }
    const existingInFlight = focusInFlight.get(targetSession.targetId);
    if (existingInFlight) {
      return existingInFlight;
    }
    const runFocus = (async () => {
      const titleRes = await targetSession.client.send('Runtime.evaluate', {
        expression: 'String(document.title || "")',
        returnByValue: true,
      });
      const title = String(titleRes?.result?.result?.value || '').trim();
      const canPromptNow =
        promptIfUntrusted &&
        process.platform === 'darwin' &&
        Date.now() - lastAccessibilityPromptAt >= 60_000;
      const [raiseRes] = await Promise.all([
        raiseAntigravityWindowByTitle({ title, channel, promptIfUntrusted: canPromptNow }),
        targetSession.client.send('Page.bringToFront', {}),
      ]);
      await new Promise((r) => setTimeout(r, 90));
      const focusCheck = await targetSession.client.send('Runtime.evaluate', {
        expression: 'Boolean(document.hasFocus && document.hasFocus())',
        returnByValue: true,
      });
      const hasFocus = focusCheck?.result?.result?.value === true;
      if (hasFocus || raiseRes?.ok === true) {
        return { ok: true, hasFocus };
      }
      const permissionDenied = Boolean(raiseRes?.permissionDenied);
      if (permissionDenied && canPromptNow) {
        lastAccessibilityPromptAt = Date.now();
        void openMacAccessibilitySettings();
      }
      return {
        ok: false,
        permissionDenied,
        reason: String(raiseRes?.reason || 'focus-not-verified'),
      };
    })().finally(() => {
      if (focusInFlight.get(targetSession.targetId) === runFocus) {
        focusInFlight.delete(targetSession.targetId);
      }
    });
    focusInFlight.set(targetSession.targetId, runFocus);
    return runFocus;
  };

  const detachConversationFromSession = async (
    session,
    { cascadeId, title = '', silent = false, allowManualFallback = true } = {}
  ) => {
    const cid = String(cascadeId || '').trim();
    const cleanTitle = String(title || '').trim();
    if (!UUID_RE.test(cid)) {
      if (!silent) {
        await pushWindowActionStatus(session, {
          status: 'error',
          message: '未识别到有效的会话 ID',
        });
      }
      return { ok: false, reason: 'invalid-cid' };
    }

    const existing = findExistingDetachedSessionByCid(cid, { excludeTargetId: session.targetId });
    if (existing) {
      const focusRes = await focusDetachedSession(existing);
      if (focusRes.ok) {
        if (!silent) {
          await pushWindowActionStatus(session, {
            status: 'opened',
            message: '已切换至该会话的独立聊天窗',
          });
        }
        return { ok: true, focusedExisting: true };
      }
      if (!silent) {
        await pushWindowActionStatus(session, {
          status: 'awaiting-shortcut',
          message:
            process.platform === 'darwin'
              ? '该会话已在独立窗打开（请按 ⌘` 切换，或授辅助功能权限以自动前置）'
              : '该会话已在独立窗口打开，请直接切换至对应窗口',
        });
      }
      return { ok: true, focusedExisting: false, alreadyDetached: true };
    }

    const armRes = detachedWindows.arm({
      cascadeId: cid,
      sourceTargetId: session.targetId,
      title: cleanTitle,
    });
    if (!armRes) return { ok: false, reason: 'arm-failed' };
    if (armRes.duplicate) return { ok: true, duplicate: true };
    const armed = armRes.entry;

    if (!silent) {
      await pushWindowActionStatus(session, {
        status: 'opening',
        requestId: armed.requestId,
        message: '正在独立聊天窗中打开…',
      });
    }

    const baselineTargetIds = await snapshotPageTargetIds();

    // 1. Zero-permission native path: dispatch Cmd/Ctrl+Shift+N via CDP
    const cdpRes = await triggerNativeNewWindowViaCdp(session.client);
    if (cdpRes.ok) {
      const waitRes = await waitForDetachedClaim(armed.requestId, baselineTargetIds);
      if (waitRes.claimed) {
        return { ok: true };
      }
    }

    // 2. Fallback (manual shortcut handoff): keep armed queue entry and guide user
    if (detachedWindows.hasRequest(armed.requestId)) {
      if (!allowManualFallback) {
        detachedWindows.clearPending(armed.requestId);
        return { ok: false, reason: 'restore-timeout' };
      }
      const shortcut = formatShortcutHint();
      wakeDaemonLoop();
      if (!silent) {
        await pushWindowActionStatus(session, {
          status: 'awaiting-shortcut',
          requestId: armed.requestId,
          shortcut,
          expiresAt: armed.expiresAt,
          message: `请按 ${shortcut} 新建窗口，将自动打开该独立聊天窗`,
        });
      }
    }
    return { ok: false, reason: 'awaiting-shortcut' };
  };

  const maybeRunPendingDetachedRestore = () => {
    const restore = pendingDetachedRestore;
    if (!restore || restore.running || stopping || switchInFlight || batchStore.getRaw().active) {
      return;
    }
    if (Date.now() > restore.expiresAt) {
      pendingDetachedRestore = null;
      return;
    }
    const candidates = [...attached.values()].filter(
      (s) => s?.client?.isOpen() && s.hostConfirmed && !restore.prevTargetIds.has(s.targetId)
    );
    if (candidates.length === 0) return;

    restore.running = true;
    void (async () => {
      try {
        let hostSession = null;
        for (const s of candidates) {
          const checkRes = await s.client.send('Runtime.evaluate', {
            expression:
              'Boolean(window.__aqHydrated && document.querySelector("[data-testid=sidebar-split], .bg-sidebar"))',
            returnByValue: true,
          });
          if (checkRes?.result?.result?.value === true) {
            hostSession = s;
            break;
          }
        }
        if (!hostSession) {
          if (pendingDetachedRestore === restore) {
            restore.running = false;
          }
          return;
        }

        await new Promise((r) => setTimeout(r, 600));
        if (
          stopping ||
          switchInFlight ||
          batchStore.getRaw().active ||
          pendingDetachedRestore !== restore ||
          !hostSession.client.isOpen()
        ) {
          if (pendingDetachedRestore === restore) restore.running = false;
          return;
        }

        const total = restore.items.length;
        await pushWindowActionStatus(hostSession, {
          status: 'opening',
          message: `正在自动恢复 ${total} 个独立聊天窗…`,
        });

        let restoredCount = 0;
        for (let i = 0; i < restore.items.length; i += 1) {
          if (
            stopping ||
            switchInFlight ||
            batchStore.getRaw().active ||
            !hostSession.client.isOpen()
          ) {
            break;
          }
          const item = restore.items[i];
          const res = await detachConversationFromSession(hostSession, {
            cascadeId: item.cascadeId,
            title: item.title,
            silent: true,
            allowManualFallback: false,
          });
          if (!res.ok) {
            log(`[detached-window] auto-restore stopped at ${i + 1}/${total}: ${res.reason || 'failed'}`);
            break;
          }
          restoredCount += 1;
          if (i + 1 < restore.items.length) {
            await new Promise((r) => setTimeout(r, 220));
          }
        }

        if (pendingDetachedRestore === restore) {
          pendingDetachedRestore = null;
        }
        if (restoredCount > 0 && hostSession.client.isOpen()) {
          await pushWindowActionStatus(hostSession, {
            status: 'opened',
            message: `已自动恢复 ${restoredCount} 个独立聊天窗`,
          });
          log(`[detached-window] auto-restored ${restoredCount}/${total} detached window(s)`);
        }
      } catch (err) {
        log(`[detached-window] auto-restore error: ${err?.message || err}`);
        if (pendingDetachedRestore === restore) {
          pendingDetachedRestore = null;
        }
      }
    })();
  };

  const handleWindowAction = async (session, rawPayload) => {
    if (!session) return;
    let msg;
    try {
      msg = JSON.parse(String(rawPayload || '{}'));
    } catch {
      return;
    }
    const type = String(msg?.type || '');
    if (type === 'set-detached-mode') {
      const enabled = Boolean(msg?.enabled);
      detachedWindows.setDetachedTarget(session.targetId, enabled);
      await pushDetachedWindowState(session, { enabled, cascadeId: '' });
      void pushDetachedWindowsToAllSessions({ force: true });
      return;
    }
    if (type === 'focus-detached') {
      const cid = String(msg?.cascadeId || '').trim();
      if (!UUID_RE.test(cid)) return;
      const existing = findExistingDetachedSessionByCid(cid, { excludeTargetId: session.targetId });
      let keepDetached = false;
      if (existing) {
        const focusRes = await focusDetachedSession(existing, { promptIfUntrusted: true });
        if (focusRes.ok) {
          return;
        }
        keepDetached = true;
      } else {
        void pushDetachedWindowsToAllSessions({ force: true });
      }
      if (session?.client?.isOpen() && session.hostConfirmed) {
        try {
          await session.client.send('Runtime.evaluate', {
            expression: `window.__aqFallbackOpenConversation && window.__aqFallbackOpenConversation(${JSON.stringify({
              cascadeId: cid,
              keepDetached,
            })})`,
            returnByValue: false,
          });
        } catch {}
      }
      return;
    }
    if (type === 'cancel-detach') {
      detachedWindows.clearPending(String(msg?.requestId || ''));
      return;
    }
    if (type !== 'detach-conversation') return;

    await detachConversationFromSession(session, {
      cascadeId: msg?.cascadeId,
      title: msg?.title,
      silent: false,
      allowManualFallback: true,
    });
  };

  const thinkingDbCache = new Map();

  const readCachedTurnThinking = (dbPath) => {
    if (!dbPath) return { found: false, thinkingCount: 0 };
    const sig = getDbSignature(dbPath);
    if (!sig) return { found: false, thinkingCount: 0 };
    const hit = thinkingDbCache.get(dbPath);
    if (hit && hit.sig === sig) return hit.result;
    const result = extractLatestTurnThinking(dbPath);
    if (!result.transientError) {
      if (thinkingDbCache.size >= 16 && !thinkingDbCache.has(dbPath)) {
        const oldest = thinkingDbCache.keys().next().value;
        if (oldest) thinkingDbCache.delete(oldest);
      }
      thinkingDbCache.set(dbPath, { sig, result });
    }
    return result;
  };

  const pushThinkingResultToSession = async (session, payload) => {
    if (!session?.client?.isOpen() || !session.hostConfirmed) return;
    try {
      await session.client.send('Runtime.evaluate', {
        expression: `window.__aqResolveThinkingTranslate && window.__aqResolveThinkingTranslate(${JSON.stringify(payload)})`,
        returnByValue: false,
      });
    } catch {}
  };

  const handleThinkingAction = async (session, rawPayload) => {
    if (!session) return;
    let msg;
    try {
      msg = JSON.parse(String(rawPayload || '{}'));
    } catch {
      return;
    }
    const type = String(msg?.type || '');
    if (type === 'close') {
      session.latestThinkingReqId = '';
      session.lastThinkingPushSig = '';
      session.lastOriginalPushSig = '';
      return;
    }

    if (type !== 'translate') return;
    const requestId = String(msg?.requestId || '').trim();
    const rawCid = String(msg?.cascadeId || session.activeCascadeId || '').trim();
    const cascadeId = UUID_RE.test(rawCid) ? rawCid : '';
    if (!requestId || !cascadeId) return;
    session.latestThinkingReqId = requestId;

    const clientInfo = msg?.clientThinking && typeof msg.clientThinking === 'object' ? msg.clientThinking : null;
    let clientText = '';
    let clientCacheMiss = false;
    let clientStepIdx = Number.isInteger(clientInfo?.stepIdx) ? clientInfo.stepIdx : -1;
    let clientCount =
      Number.isInteger(clientInfo?.thinkingCount) && clientInfo.thinkingCount > 0
        ? clientInfo.thinkingCount
        : 0;

    if (clientInfo?.sameSig) {
      if (
        session.lastClientThinking?.cascadeId === cascadeId &&
        session.lastClientThinking.sig === String(clientInfo.sameSig)
      ) {
        clientText = session.lastClientThinking.text;
        if (clientStepIdx < 0) clientStepIdx = session.lastClientThinking.stepIdx;
        if (clientCount <= 0) clientCount = session.lastClientThinking.thinkingCount;
      } else {
        clientCacheMiss = true;
      }
    } else if (typeof clientInfo?.text === 'string' && clientInfo.text.trim()) {
      clientText = clientInfo.text.trim();
      session.lastClientThinking = {
        cascadeId,
        sig: String(clientInfo.sig || ''),
        text: clientText,
        stepIdx: clientStepIdx,
        thinkingCount: clientCount,
      };
    }

    const dbPath = resolveConversationDbPath(cascadeId, paths.conversationsDir);
    const dbThinking = readCachedTurnThinking(dbPath);
    const turnStartIdx = Number.isInteger(dbThinking.turnStartStepIdx) ? dbThinking.turnStartStepIdx : -1;
    const validClientText =
      turnStartIdx >= 0 && clientStepIdx >= 0 && clientStepIdx <= turnStartIdx ? '' : clientText;

    let rawSource = '';
    let stepIdx = -1;
    let thinkingCount = 0;

    if (dbThinking.found && validClientText) {
      if (
        clientStepIdx > dbThinking.stepIdx ||
        (clientStepIdx === dbThinking.stepIdx && validClientText.length >= dbThinking.text.length) ||
        (clientStepIdx < 0 && clientCount > dbThinking.thinkingCount)
      ) {
        rawSource = validClientText;
        stepIdx = clientStepIdx >= 0 ? clientStepIdx : dbThinking.stepIdx;
        thinkingCount = Math.max(clientCount, dbThinking.thinkingCount);
      } else {
        rawSource = dbThinking.text;
        stepIdx = dbThinking.stepIdx;
        thinkingCount = Math.max(dbThinking.thinkingCount, clientCount);
      }
    } else if (validClientText) {
      rawSource = validClientText;
      stepIdx = clientStepIdx;
      thinkingCount = clientCount || 1;
    } else if (dbThinking.found) {
      rawSource = dbThinking.text;
      stepIdx = dbThinking.stepIdx;
      thinkingCount = dbThinking.thinkingCount;
    }

    const extraClientFlags = clientCacheMiss ? { resetClientSig: true } : {};

    if (!rawSource) {
      session.lastThinkingPushSig = '';
      session.lastOriginalPushSig = '';
      await pushThinkingResultToSession(session, {
        requestId,
        cascadeId,
        ok: false,
        empty: true,
        error: '当前轮次暂未生成思考内容，正在等待实时刷新…',
        ...extraClientFlags,
      });
      return;
    }

    const sourcePref = normalizeThinkingTranslateSource(msg?.source);
    const onlyOriginal = Boolean(msg?.onlyOriginal);
    const prep = thinkingTranslator.getEffectiveKey(rawSource, { source: sourcePref });
    const origSig = `${cascadeId}|orig:${crypto.createHash('sha256').update(prep.text).digest('hex')}`;

    if (onlyOriginal) {
      if (!msg?.force && session.lastOriginalPushSig === origSig) {
        await pushThinkingResultToSession(session, {
          requestId,
          cascadeId,
          ok: true,
          onlyOriginal: true,
          unchanged: true,
          stepIdx,
          thinkingCount,
          ...extraClientFlags,
        });
        return;
      }
      session.lastOriginalPushSig = origSig;
      await pushThinkingResultToSession(session, {
        requestId,
        cascadeId,
        ok: true,
        onlyOriginal: true,
        stepIdx,
        thinkingCount,
        sourceText: prep.text,
        hasOriginal: true,
        ...extraClientFlags,
      });
      return;
    }

    const pushSig = `${cascadeId}|${prep.effectiveKey}`;
    if (!msg?.force && session.lastThinkingPushSig === pushSig) {
      await pushThinkingResultToSession(session, {
        requestId,
        cascadeId,
        ok: true,
        unchanged: true,
        stepIdx,
        thinkingCount,
        ...extraClientFlags,
      });
      return;
    }

    try {
      const res = await thinkingTranslator.translate(rawSource, { source: sourcePref });
      if (session.latestThinkingReqId !== requestId) return;
      session.lastThinkingPushSig = `${cascadeId}|${res.effectiveKey || prep.effectiveKey}`;
      session.lastOriginalPushSig =
        res.sourceText === prep.text
          ? origSig
          : `${cascadeId}|orig:${crypto.createHash('sha256').update(res.sourceText).digest('hex')}`;
      await pushThinkingResultToSession(session, {
        requestId,
        cascadeId,
        ok: true,
        stepIdx,
        thinkingCount,
        sourcePref,
        sourceText: res.sourceText,
        translatedText: res.translatedText,
        hasOriginal: res.sourceText !== res.translatedText,
        provider: res.provider,
        providerLabel: res.providerLabel,
        ...extraClientFlags,
      });
    } catch (err) {
      if (session.latestThinkingReqId !== requestId) return;
      await pushThinkingResultToSession(session, {
        requestId,
        cascadeId,
        ok: false,
        stepIdx,
        thinkingCount,
        sourceText: prep.text,
        hasOriginal: Boolean(prep.text),
        error: String(err?.message || '翻译请求失败'),
        ...extraClientFlags,
      });
    }
  };

  const pushKeepAliveToSession = async (session, accountEmail = '') => {
    if (!session?.client?.isOpen() || !session.hostConfirmed) return;
    const email = resolveSessionEmail(session, accountEmail);
    const payload = keepAliveManager.getState(email);
    try {
      await session.client.send('Runtime.evaluate', {
        expression: `window.__aqRenderKeepAlive && window.__aqRenderKeepAlive(${JSON.stringify(payload)})`,
        returnByValue: false,
      });
    } catch {}
  };

  const pushKeepAliveToAllSessions = async (accountEmail = '') => {
    for (const s of attached.values()) {
      await pushKeepAliveToSession(s, accountEmail);
    }
  };

  const handleKeepAliveAction = async (session, rawPayload) => {
    let msg;
    try {
      msg = JSON.parse(String(rawPayload || '{}'));
    } catch {
      return;
    }
    const type = String(msg?.type || '');
    const accountEmail = resolveSessionEmail(session, msg?.accountEmail);
    if (accountEmail && session) {
      session.activeEmail = accountEmail;
    }
    if (type === 'get') {
      await pushKeepAliveToSession(session, accountEmail);
      return;
    }
    if (type === 'toggle') {
      keepAliveManager.setPoolEnabled({
        accountEmail,
        poolKey: msg?.poolKey,
        enabled: Boolean(msg?.enabled),
      });
      await pushKeepAliveToAllSessions(accountEmail);
      await pushAccountsToAllSessions();
      return;
    }
    if (type === 'set-model') {
      keepAliveManager.setPoolModel({
        accountEmail,
        poolKey: msg?.poolKey,
        modelId: msg?.modelId,
      });
      await pushKeepAliveToAllSessions(accountEmail);
      return;
    }
    if (type === 'claim') {
      const requestId = String(msg?.requestId || '');
      const res = keepAliveManager.claimTrigger({
        accountEmail,
        poolKey: msg?.poolKey,
        manual: Boolean(msg?.manual),
      });
      if (res.allowed) {
        await pushKeepAliveToAllSessions(accountEmail);
      }
      if (session?.client?.isOpen() && session.hostConfirmed) {
        try {
          await session.client.send('Runtime.evaluate', {
            expression: `window.__aqResolveKeepAliveClaim && window.__aqResolveKeepAliveClaim(${JSON.stringify({ requestId, ...res })})`,
            returnByValue: false,
          });
        } catch {}
      }
      return;
    }
    if (type === 'complete') {
      keepAliveManager.completeTrigger({
        accountEmail,
        poolKey: msg?.poolKey,
        runId: msg?.runId,
        ok: Boolean(msg?.ok),
        modelLabel: msg?.modelLabel,
        error: msg?.error,
      });
      await pushKeepAliveToAllSessions(accountEmail);
    }
  };

  const pushBatchKeepAliveToSession = async (session) => {
    if (!session?.client?.isOpen() || !session.hostConfirmed) return;
    const payload = batchStore.getPublicState(session.targetId);
    try {
      await session.client.send('Runtime.evaluate', {
        expression: `window.__aqRenderBatchKeepAlive && window.__aqRenderBatchKeepAlive(${JSON.stringify(payload)})`,
        returnByValue: false,
      });
    } catch {}
  };

  const pushBatchKeepAliveToAllSessions = async () => {
    await Promise.allSettled([...attached.values()].map((s) => pushBatchKeepAliveToSession(s)));
  };

  const finishBatchOrReturnToOrigin = async () => {
    if (batchDriverInFlight) return;
    const raw = batchStore.getRaw();
    if (!raw.active) return;
    batchDriverInFlight = true;
    try {
      if (raw.cancelRequested) {
        batchStore.markCancelled();
        await pushBatchKeepAliveToAllSessions();
        await pushAccountsToAllSessions({ busy: false, status: '已中途停止一键唤醒' });
        return;
      }

      const activeSessions = [...attached.values()];
      const alreadyOnOrigin =
        !raw.switchedAwayOnce ||
        (Boolean(raw.originEmail) &&
          activeSessions.some(
            (s) => String(s?.activeEmail || '').trim().toLowerCase() === raw.originEmail.toLowerCase()
          ) &&
          raw.items.length === 1 &&
          Boolean(raw.items[0]?.isOrigin));

      if (alreadyOnOrigin) {
        const finished = batchStore.markFinished({ skippedReturn: true });
        log(`[batch-keepalive] finished (${finished.phase}): ${finished.statusText} | ${finished.summaryText}`);
        sendSystemNotification({
          title: finished.allSucceeded ? 'Antigravity 一键唤醒已完成' : 'Antigravity 一键唤醒结束',
          message: `${finished.summaryText}，${finished.statusText}`,
        });
        await pushBatchKeepAliveToAllSessions();
        await pushAccountsToAllSessions({ busy: false, status: finished.statusText });
        return;
      }

      raw.phase = 'returning';
      raw.assignedSessionId = '';
      raw.assignedStepToken = '';
      raw.activePoolLabel = '';
      raw.statusText = `全部唤醒完成，正在切回 ${raw.originEmail}…`;
      await pushBatchKeepAliveToAllSessions();
      await pushAccountsToAllSessions({ busy: true, status: raw.statusText });

      const prevIdsBeforeReturn = new Set(attached.keys());
      switchInFlight = true;
      let failedReturnError = '';
      try {
        log(`[batch-keepalive] returning to origin account ${raw.originEmail}...`);
        await switchAccountWithRestart({
          accountId: raw.originAccountId,
          accountsFile: paths.accountsFile,
          appSupportDir: paths.appSupportDir,
          channel,
        });
      } catch (err) {
        failedReturnError = String(err?.message || '切回原账号失败');
        log(`[batch-keepalive] return switch failed: ${failedReturnError}`);
      } finally {
        switchInFlight = false;
        targetAttachTracker.reset();
      }
      const savedDetached = batchSavedDetachedItems;
      batchSavedDetachedItems = [];
      if (!failedReturnError && savedDetached.length > 0) {
        scheduleDetachedRestoreAfterRestart(savedDetached, prevIdsBeforeReturn);
      }

      const finished = batchStore.markFinished({ failedReturnError });
      log(`[batch-keepalive] finished (${finished.phase}): ${finished.statusText} | ${finished.summaryText}`);
      sendSystemNotification({
        title:
          finished.phase === 'failed'
            ? 'Antigravity 一键唤醒结束（切回失败）'
            : finished.allSucceeded
              ? 'Antigravity 一键唤醒已完成'
              : 'Antigravity 一键唤醒结束',
        message: `${finished.summaryText}，${finished.statusText}`,
      });
      await pushBatchKeepAliveToAllSessions();
      await pushAccountsToAllSessions({
        busy: false,
        error: failedReturnError,
        status: failedReturnError ? '' : finished.statusText,
      });
      void tick();
    } finally {
      batchDriverInFlight = false;
    }
  };

  const advanceToBatchTarget = async (nextIndex) => {
    if (batchDriverInFlight) return;
    const raw = batchStore.getRaw();
    if (!raw.active) return;
    if (raw.cancelRequested) {
      batchStore.markCancelled();
      await pushBatchKeepAliveToAllSessions();
      await pushAccountsToAllSessions({ busy: false, status: '已中途停止一键唤醒' });
      return;
    }
    if (nextIndex >= raw.items.length) {
      await finishBatchOrReturnToOrigin();
      return;
    }

    const item = raw.items[nextIndex];
    batchDriverInFlight = true;
    try {
      raw.currentIndex = nextIndex;
      raw.stepSeq += 1;
      raw.assignedSessionId = '';
      raw.assignedStepToken = '';
      raw.activePoolLabel = '';
      raw.phase = 'switching';
      raw.stepPhaseStartedAt = Date.now();
      item.status = 'switching';
      item.detail = '正在切号重启';
      raw.statusText = `正在切换至 ${item.email} (${nextIndex + 1}/${raw.items.length})…`;
      await pushBatchKeepAliveToAllSessions();
      await pushAccountsToAllSessions({ busy: true, status: raw.statusText });

      switchInFlight = true;
      let switchError = '';
      try {
        log(`[batch-keepalive] switching to ${item.email} (${nextIndex + 1}/${raw.items.length})...`);
        await switchAccountWithRestart({
          accountId: item.accountId,
          accountsFile: paths.accountsFile,
          appSupportDir: paths.appSupportDir,
          channel,
        });
        raw.switchedAwayOnce = true;
      } catch (err) {
        switchError = String(err?.message || '切号失败');
        log(`[batch-keepalive] switch to ${item.email} failed: ${switchError}`);
      } finally {
        switchInFlight = false;
        targetAttachTracker.reset();
      }

      if (raw.cancelRequested || stopping) {
        if (!switchError) {
          item.status = 'cancelled';
          item.detail = '已取消';
        }
        batchStore.markCancelled();
        await pushBatchKeepAliveToAllSessions();
        await pushAccountsToAllSessions({ busy: false, status: '已中途停止一键唤醒' });
        void tick();
        return;
      }

      if (switchError) {
        item.status = 'failed';
        item.detail = switchError;
        batchDriverInFlight = false;
        await advanceToBatchTarget(nextIndex + 1);
        return;
      }

      raw.phase = 'waiting_ready';
      raw.stepPhaseStartedAt = Date.now();
      item.status = 'waiting_ready';
      item.detail = '等待配额就绪';
      raw.statusText = `已切至 ${item.email}，等待页面与配额就绪…`;
      await pushBatchKeepAliveToAllSessions();
      void tick();
    } finally {
      batchDriverInFlight = false;
    }
  };

  const advanceBatchAfterCurrentItem = async () => {
    const raw = batchStore.getRaw();
    if (!raw.active) return;
    if (raw.cancelRequested) {
      batchStore.markCancelled();
      await pushBatchKeepAliveToAllSessions();
      await pushAccountsToAllSessions({ busy: false, status: '已中途停止一键唤醒' });
      return;
    }
    const nextIndex = raw.currentIndex + 1;
    if (nextIndex < raw.items.length) {
      await advanceToBatchTarget(nextIndex);
    } else {
      await finishBatchOrReturnToOrigin();
    }
  };

  const checkBatchKeepAliveTimeouts = async () => {
    const raw = batchStore.getRaw();
    if (!raw.active || batchDriverInFlight || switchInFlight) return;
    const item = raw.items[raw.currentIndex];
    if (!item) return;
    const elapsed = Date.now() - raw.stepPhaseStartedAt;
    if (raw.phase === 'waiting_ready' && elapsed > 35_000) {
      item.status = 'failed';
      item.detail = '页面或登录状态就绪超时';
      await advanceBatchAfterCurrentItem();
    } else if (raw.phase === 'waking' && elapsed > 120_000) {
      item.status = 'failed';
      item.detail = '唤醒执行超时';
      await advanceBatchAfterCurrentItem();
    }
  };

  const handleBatchKeepAliveAction = async (session, rawPayload) => {
    let msg;
    try {
      msg = JSON.parse(String(rawPayload || '{}'));
    } catch {
      return;
    }
    const type = String(msg?.type || '');
    if (type === 'dismiss') {
      batchStore.dismiss();
      await pushBatchKeepAliveToAllSessions();
      return;
    }
    if (type === 'cancel') {
      const raw = batchStore.getRaw();
      if (!raw.active) return;
      raw.cancelRequested = true;
      if (switchInFlight || batchDriverInFlight) {
        raw.statusText = '正在取消，等待当前重启步骤结束后停在当前账号…';
        await pushBatchKeepAliveToAllSessions();
        return;
      }
      batchStore.markCancelled();
      await pushBatchKeepAliveToAllSessions();
      await pushAccountsToAllSessions({ busy: false, status: '已中途停止一键唤醒' });
      return;
    }
    if (!accountSupport.supported) return;

    if (type === 'start') {
      if (switchInFlight || batchDriverInFlight || batchStore.getRaw().active) return;
      const profile = msg?.profile && typeof msg.profile === 'object' ? msg.profile : null;
      if (profile?.email) {
        session.activeEmail = String(profile.email).trim();
        try {
          snapshotCurrentAccount({
            accountsFile: paths.accountsFile,
            appSupportDir: paths.appSupportDir,
            profile,
            quota: msg?.quota || null,
          });
        } catch {}
      }
      const activeEmail = resolveSessionEmail(session, profile?.email || '');
      const accounts = listAccounts(paths.accountsFile, activeEmail);
      const plan = planBatchKeepAliveRun({
        accounts,
        activeEmail,
        liveProfile: profile,
        getKeepAliveState: (email) => keepAliveManager.getState(email),
      });
      if (!plan.ok) {
        await pushAccountsToSession(session, { activeEmail, error: plan.error });
        return;
      }

      batchSavedDetachedItems = await snapshotOpenDetachedWindows();
      batchStore.start({
        originAccount: plan.originAccount,
        targets: plan.targets,
      });
      const raw = batchStore.getRaw();
      await pushBatchKeepAliveToAllSessions();
      await pushAccountsToAllSessions({ busy: true });
      if (!raw.items[0]?.isOrigin) {
        await advanceToBatchTarget(0);
      }
      return;
    }

    const raw = batchStore.getRaw();
    if (!raw.active || raw.cancelRequested) return;
    const item = raw.items[raw.currentIndex];
    if (!item) return;

    if (type === 'step-ready') {
      if (raw.phase !== 'waiting_ready' || msg?.stepSeq !== raw.stepSeq || raw.assignedSessionId) return;
      const readyEmail = String(msg?.email || '').trim().toLowerCase();
      if (!readyEmail || readyEmail !== item.email.toLowerCase()) return;
      session.activeEmail = String(msg?.email || '').trim();
      raw.assignedSessionId = session.targetId;
      raw.assignedStepToken = crypto.randomUUID();
      raw.phase = 'waking';
      raw.stepPhaseStartedAt = Date.now();
      item.status = 'waking';
      item.detail = '正在唤醒模型池…';
      raw.statusText = `正在唤醒 ${item.email} (${raw.currentIndex + 1}/${raw.items.length})…`;
      await pushBatchKeepAliveToAllSessions();
      return;
    }

    if (type === 'step-progress') {
      if (raw.phase !== 'waking' || msg?.runToken !== raw.assignedStepToken) return;
      const poolLabel = String(msg?.poolLabel || '').trim();
      raw.activePoolLabel = poolLabel;
      item.detail = poolLabel ? `唤醒 ${poolLabel}` : '唤醒中…';
      raw.statusText = poolLabel
        ? `正在唤醒 ${item.email} · ${poolLabel} (${raw.currentIndex + 1}/${raw.items.length})`
        : raw.statusText;
      await pushBatchKeepAliveToAllSessions();
      return;
    }

    if (type === 'step-complete') {
      if (raw.phase !== 'waking' || msg?.runToken !== raw.assignedStepToken) return;
      if (msg?.quota) {
        try {
          updateAccountQuotaSnapshot({
            accountsFile: paths.accountsFile,
            email: item.email,
            quota: msg.quota,
          });
        } catch {}
      }
      const wokenCount = Number(msg?.wokenCount || 0);
      const errors = Array.isArray(msg?.errors) ? msg.errors.filter(Boolean) : [];
      if (wokenCount > 0) {
        item.status = 'done';
        item.detail = errors.length > 0 ? `已唤醒 ${wokenCount} 组（${errors.length} 组失败）` : `已唤醒 ${wokenCount} 组`;
      } else if (errors.length > 0) {
        item.status = 'failed';
        item.detail = String(errors[0]);
      } else {
        item.status = 'skipped';
        item.detail = String(msg?.skippedReason || '已在计时中');
      }
      await pushAccountsToAllSessions();
      await advanceBatchAfterCurrentItem();
    }
  };

  const handleGroupAction = async (session, rawPayload) => {
    let msg;
    try {
      msg = JSON.parse(String(rawPayload || '{}'));
    } catch {
      return;
    }
    const type = String(msg?.type || '');
    try {
      if (type === 'list') {
        await pushGroupsToSession(session);
        return;
      }
      if (type === 'create') {
        const { store } = createConversationGroup(paths.groupsFile, {
          name: msg?.name,
          parentId: msg?.parentId || '',
          initialItem: msg?.item || null,
        });
        await pushGroupsToAllSessions({ store });
        return;
      }
      if (type === 'rename') {
        const store = renameConversationGroup(paths.groupsFile, {
          groupId: msg?.groupId,
          name: msg?.name,
        });
        await pushGroupsToAllSessions({ store });
        return;
      }
      if (type === 'delete') {
        const store = deleteConversationGroup(paths.groupsFile, {
          groupId: msg?.groupId,
        });
        await pushGroupsToAllSessions({ store });
        return;
      }
      if (type === 'toggle-collapse') {
        const store = toggleConversationGroupCollapse(paths.groupsFile, {
          groupId: msg?.groupId,
          section: Boolean(msg?.section),
        });
        await pushGroupsToAllSessions({ store });
        return;
      }
      if (type === 'add-item') {
        const store = addConversationToGroup(paths.groupsFile, {
          groupId: msg?.groupId,
          item: msg?.item,
          beforeCascadeId: msg?.beforeCascadeId || '',
          afterCascadeId: msg?.afterCascadeId || '',
          beforeGroupId: msg?.beforeGroupId || '',
          afterGroupId: msg?.afterGroupId || '',
        });
        await pushGroupsToAllSessions({ store });
        return;
      }
      if (type === 'remove-item') {
        const store = removeConversationFromGroup(paths.groupsFile, {
          groupId: msg?.groupId,
          cascadeId: msg?.cascadeId,
        });
        await pushGroupsToAllSessions({ store });
        return;
      }
      if (type === 'move-item') {
        const store = moveConversationBetweenGroups(paths.groupsFile, {
          fromGroupId: msg?.fromGroupId,
          toGroupId: msg?.toGroupId,
          item: msg?.item,
          beforeCascadeId: msg?.beforeCascadeId || '',
          afterCascadeId: msg?.afterCascadeId || '',
          beforeGroupId: msg?.beforeGroupId || '',
          afterGroupId: msg?.afterGroupId || '',
        });
        await pushGroupsToAllSessions({ store });
        return;
      }
      if (type === 'reorder-items') {
        const store = reorderConversationGroupItems(paths.groupsFile, {
          groupId: msg?.groupId,
          cascadeId: msg?.cascadeId || '',
          beforeCascadeId: msg?.beforeCascadeId || '',
          afterCascadeId: msg?.afterCascadeId || '',
          beforeGroupId: msg?.beforeGroupId || '',
          afterGroupId: msg?.afterGroupId || '',
          orderedCascadeIds: msg?.orderedCascadeIds,
        });
        await pushGroupsToAllSessions({ store });
        return;
      }
      if (type === 'move-group') {
        const store = moveConversationGroup(paths.groupsFile, {
          groupId: msg?.groupId,
          parentId: msg?.parentId || '',
          beforeGroupId: msg?.beforeGroupId || '',
          afterGroupId: msg?.afterGroupId || '',
          beforeCascadeId: msg?.beforeCascadeId || '',
          afterCascadeId: msg?.afterCascadeId || '',
        });
        await pushGroupsToAllSessions({ store });
        return;
      }
      if (type === 'reorder') {
        const store = reorderConversationGroups(paths.groupsFile, {
          orderedIds: msg?.orderedIds,
          parentId: msg?.parentId,
        });
        await pushGroupsToAllSessions({ store });
        return;
      }
      if (type === 'sync-meta') {
        const { store, changed } = syncConversationMetadata(paths.groupsFile, msg?.metadata || {});
        if (changed) {
          await pushGroupsToAllSessions({ store });
        }
      }
    } catch (err) {
      await pushGroupsToSession(session, {
        error: String(err?.message || '分组操作失败'),
      });
    }
  };

  const handleAccountAction = async (session, rawPayload) => {
    let msg;
    try {
      msg = JSON.parse(String(rawPayload || '{}'));
    } catch {
      return;
    }
    const profile = msg?.profile && typeof msg.profile === 'object' ? msg.profile : null;
    const prevEmail = String(session?.activeEmail || '').trim().toLowerCase();
    if (profile?.email) {
      session.activeEmail = String(profile.email).trim();
    }
    const activeEmail = resolveSessionEmail(session, profile?.email || '');
    if (activeEmail && activeEmail.toLowerCase() !== prevEmail) {
      void pushKeepAliveToSession(session, activeEmail);
    }
    const type = String(msg?.type || '');

    try {
      if (type === 'list') {
        await pushAccountsToSession(session, { activeEmail });
        return;
      }
      if (!accountSupport.supported) {
        await pushAccountsToSession(session, { activeEmail });
        return;
      }
      if (type === 'sync-quota') {
        const res = updateAccountQuotaSnapshot({
          accountsFile: paths.accountsFile,
          email: activeEmail,
          quota: msg?.quota || null,
        });
        if (res.updated) {
          await pushAccountsToAllSessions({ activeEmail });
        }
        return;
      }
      if (type === 'save') {
        try {
          const entry = snapshotCurrentAccount({
            accountsFile: paths.accountsFile,
            appSupportDir: paths.appSupportDir,
            profile: profile || {},
            quota: msg?.quota || null,
          });
          session.activeEmail = entry.email;
          await pushAccountsToAllSessions({
            activeEmail: entry.email,
            status: msg?.silent ? '' : `已保存账号 ${entry.email}`,
          });
        } catch (err) {
          if (msg?.silent) {
            await pushAccountsToSession(session, { activeEmail });
            return;
          }
          throw err;
        }
        return;
      }
      if (type === 'add-account' || type === 'prepare-add') {
        if (switchInFlight || batchStore.getRaw().active) return;
        switchInFlight = true;
        await pushAccountsToAllSessions({
          activeEmail,
          busy: true,
          status: '正在保存当前账号并重启 Antigravity 进入登录页…',
        });
        let prepareErr = null;
        try {
          log('[accounts] preparing new account login (restarting Antigravity)...');
          await prepareNewAccountWithRestart({
            accountsFile: paths.accountsFile,
            appSupportDir: paths.appSupportDir,
            channel,
            currentProfile: profile,
            currentQuota: msg?.quota || null,
          });
          log('[accounts] Antigravity relaunched for new account login');
        } catch (err) {
          prepareErr = err;
          log(`[accounts] prepare-add failed: ${err?.message || err}`);
        } finally {
          switchInFlight = false;
          targetAttachTracker.reset();
        }
        if (prepareErr) {
          await pushAccountsToAllSessions({
            activeEmail,
            busy: false,
            error: String(prepareErr?.message || '进入新账号登录失败'),
          });
        }
        return;
      }
      if (type === 'delete') {
        deleteAccount(paths.accountsFile, msg?.id);
        await pushAccountsToAllSessions({ activeEmail, status: '已删除账号快照' });
        return;
      }
      if (type === 'reorder') {
        const res = reorderAccounts(paths.accountsFile, msg?.orderedIds);
        if (res.changed) {
          await pushAccountsToAllSessions({ activeEmail });
        }
        return;
      }
      if (type === 'switch') {
        if (switchInFlight || batchStore.getRaw().active) return;
        const detachedToRestore = await snapshotOpenDetachedWindows();
        const prevTargetIds = new Set(attached.keys());
        pendingDetachedRestore = null;
        switchInFlight = true;
        await pushAccountsToAllSessions({
          activeEmail,
          busy: true,
          status: '正在切换账号并重启 Antigravity…',
        });
        let switchErr = null;
        try {
          log(`[accounts] switching account to ${String(msg?.id || '')} (restarting Antigravity)...`);
          await switchAccountWithRestart({
            accountId: msg?.id,
            accountsFile: paths.accountsFile,
            appSupportDir: paths.appSupportDir,
            channel,
            currentProfile: profile,
            currentQuota: msg?.quota || null,
          });
          log('[accounts] Antigravity relaunched after account switch');
        } catch (err) {
          switchErr = err;
          log(`[accounts] switch failed: ${err?.message || err}`);
        } finally {
          switchInFlight = false;
          targetAttachTracker.reset();
        }
        if (switchErr) {
          pendingDetachedRestore = null;
          await pushAccountsToAllSessions({
            activeEmail,
            busy: false,
            error: String(switchErr?.message || '切换账号失败'),
          });
        } else if (detachedToRestore.length > 0) {
          scheduleDetachedRestoreAfterRestart(detachedToRestore, prevTargetIds);
        }
      }
    } catch (err) {
      await pushAccountsToSession(session, {
        activeEmail,
        busy: switchInFlight,
        error: String(err?.message || '账号操作失败'),
      });
    }
  };

  const syncTurnsForSession = async (session, force = false, { skipCidProbe = false } = {}) => {
    if (!session.client.isOpen() || !session.hostConfirmed) return;
    if ((!session.activeCascadeId && !skipCidProbe) || force) {
      const res = await session.client.send('Runtime.evaluate', {
        expression: `window.__aqGetWatchedCascadeId ? window.__aqGetWatchedCascadeId() : (() => {
          const m = location.pathname.match(/\\/c\\/([0-9a-f-]{36})/i);
          return m ? m[1] : '';
        })()`,
        returnByValue: true,
      });
      const cid = String(res?.result?.result?.value || '').trim();
      if (UUID_RE.test(cid)) session.activeCascadeId = cid;
    }
    if (!session.activeCascadeId) return;

    const dbPath = resolveConversationDbPath(session.activeCascadeId, paths.conversationsDir);
    const sig = getDbSignature(dbPath);
    if (!sig) return;

    const rateSig = pricingManager.getRateSignature();
    const sessionKey = `${session.activeCascadeId}@${sig}@${rateSig}`;
    if (!force && sessionKey === session.lastPushedKey) return;

    let basePayload;
    const cached = turnsCache.get(dbPath);
    if (cached && cached.sig === sig) {
      basePayload = cached.payload;
    } else {
      basePayload = parseConversationTurns(dbPath, session.activeCascadeId, {
        prevPayload: cached?.payload || null,
      });
      if (basePayload.transientError) return;
      if (turnsCache.size > 24) {
        turnsCache.delete(turnsCache.keys().next().value);
      }
      turnsCache.set(dbPath, { sig, payload: basePayload });
    }
    const payload = pricingManager.enrichConversationPayload(basePayload);
    const rawTurns = Array.isArray(basePayload.turns) ? basePayload.turns : [];

    let outPayload = payload;
    if (
      !force &&
      session.lastPushedCid === session.activeCascadeId &&
      session.lastPushedRateSig === rateSig &&
      Array.isArray(session.lastPushedRawTurns) &&
      session.lastPushedRawTurns.length > 0 &&
      rawTurns.length >= session.lastPushedRawTurns.length
    ) {
      let stablePrefix = 0;
      const limit = Math.min(session.lastPushedRawTurns.length - 1, rawTurns.length - 1);
      while (stablePrefix < limit && rawTurns[stablePrefix] === session.lastPushedRawTurns[stablePrefix]) {
        stablePrefix += 1;
      }
      if (stablePrefix > 0) {
        outPayload = {
          mode: 'tail',
          cascadeId: payload.cascadeId,
          hasData: payload.hasData,
          latestContext: payload.latestContext,
          tailStartIndex: stablePrefix,
          turns: payload.turns.slice(stablePrefix),
        };
      }
    }

    const evalRes = await session.client.send('Runtime.evaluate', {
      expression: `window.__aqRenderTurns && window.__aqRenderTurns(${JSON.stringify(outPayload)})`,
      returnByValue: false,
    });
    if (!evalRes) return;
    session.lastPushedKey = sessionKey;
    session.lastPushedCid = session.activeCascadeId;
    session.lastPushedRateSig = rateSig;
    session.lastPushedRawTurns = rawTurns;
  };

  const attachTarget = async (target) => {
    if (attached.has(target.id) || attachingIds.has(target.id) || !target.webSocketDebuggerUrl) return;
    if (targetAttachTracker.shouldSkip(target.id)) return;
    attachingIds.add(target.id);
    try {
      let client;
      try {
        client = await createCdpClient(target.webSocketDebuggerUrl);
      } catch {
        targetAttachTracker.markFailure(target.id);
        return;
      }

      const session = {
        targetId: target.id,
        client,
        hostConfirmed: false,
        activeCascadeId: '',
        lastPushedKey: '',
        lastPushedCid: '',
        lastPushedRateSig: '',
        lastPushedRawTurns: null,
        latestThinkingReqId: '',
        lastThinkingPushSig: '',
        lastOriginalPushSig: '',
        lastClientThinking: null,
        evalScriptId: null,
        pendingDetach: null,
      };
      attached.set(target.id, session);

      client.onClose(() => {
        if (attached.get(target.id) === session) {
          attached.delete(target.id);
        }
        detachedWindows.forgetTarget(target.id);
        void pushDetachedWindowsToAllSessions();
      });

      const probeRes = await client.send('Runtime.evaluate', {
        expression: `({
          isHost: Boolean(window.__APP_CONFIG__?.productName === 'antigravity' || document.getElementById('antigravity.agentSidePanelInputBox')),
          readyState: typeof document !== 'undefined' ? document.readyState : '',
        })`,
        returnByValue: true,
      });
      const probeVal = probeRes?.result?.result?.value;
      if (probeVal?.isHost !== true) {
        attached.delete(target.id);
        targetAttachTracker.markFailure(target.id, {
          readyState: typeof probeVal?.readyState === 'string' ? probeVal.readyState : '',
        });
        client.close();
        return;
      }
      targetAttachTracker.markSuccess(target.id);

      session.hostConfirmed = true;

      const claimedDetach = detachedWindows.consumeForNewTarget(target.id);
      if (claimedDetach) {
        session.pendingDetach = {
          cascadeId: claimedDetach.cascadeId,
          title: claimedDetach.title,
        };
        session.activeCascadeId = claimedDetach.cascadeId;
        // Kick off lightweight detached styling + native SPA navigation immediately
        // before transferring the full client bundle.
        await client.send('Runtime.evaluate', {
          expression: buildEarlyDetachedBootstrapExpression({
            cascadeId: claimedDetach.cascadeId,
            isMac: process.platform === 'darwin',
          }),
          returnByValue: false,
        });
        const sourceSession = claimedDetach.sourceTargetId ? attached.get(claimedDetach.sourceTargetId) : null;
        if (sourceSession) {
          void pushWindowActionStatus(sourceSession, {
            status: 'opened',
            requestId: claimedDetach.requestId,
            message: '已在独立聊天窗中打开',
          });
        }
        void pushDetachedWindowsToAllSessions();
      }

      await Promise.all([
        client.send('Runtime.addBinding', { name: '__aqRequestTurns' }),
        client.send('Runtime.addBinding', { name: '__aqAccountAction' }),
        client.send('Runtime.addBinding', { name: '__aqUpdateAction' }),
        client.send('Runtime.addBinding', { name: '__aqGroupAction' }),
        client.send('Runtime.addBinding', { name: '__aqKeepAliveAction' }),
        client.send('Runtime.addBinding', { name: '__aqBatchKeepAliveAction' }),
        client.send('Runtime.addBinding', { name: '__aqUiPrefsAction' }),
        client.send('Runtime.addBinding', { name: '__aqThinkingAction' }),
        client.send('Runtime.addBinding', { name: '__aqFileAction' }),
        client.send('Runtime.addBinding', { name: '__aqWindowAction' }),
      ]);

      client.onBinding((params) => {
        if (params?.name === '__aqRequestTurns') {
          const nextCid = String(params.payload || '').trim();
          if (UUID_RE.test(nextCid)) {
            session.activeCascadeId = nextCid;
            session.lastPushedKey = '';
            void syncTurnsForSession(session, true);
          }
        } else if (params?.name === '__aqAccountAction') {
          void handleAccountAction(session, params.payload);
        } else if (params?.name === '__aqUpdateAction') {
          void handleUpdateAction(params.payload);
        } else if (params?.name === '__aqGroupAction') {
          void handleGroupAction(session, params.payload);
        } else if (params?.name === '__aqKeepAliveAction') {
          void handleKeepAliveAction(session, params.payload);
        } else if (params?.name === '__aqBatchKeepAliveAction') {
          void handleBatchKeepAliveAction(session, params.payload);
        } else if (params?.name === '__aqUiPrefsAction') {
          void handleUiPrefsAction(session, params.payload);
        } else if (params?.name === '__aqThinkingAction') {
          void handleThinkingAction(session, params.payload);
        } else if (params?.name === '__aqFileAction') {
          void handleFileAction(session, params.payload);
        } else if (params?.name === '__aqWindowAction') {
          void handleWindowAction(session, params.payload);
        }
      });

      await client.send('Runtime.evaluate', { expression: script, returnByValue: false });
      const [docRes] = await Promise.all([
        client.send('Page.addScriptToEvaluateOnNewDocument', { source: script }),
        hydrateSession(session),
      ]);
      session.evalScriptId = docRes?.result?.identifier || null;
    } finally {
      attachingIds.delete(target.id);
    }
  };

  const hydrateSession = async (session) => {
    if (session.pendingDetach) {
      const pending = session.pendingDetach;
      session.pendingDetach = null;
      await pushDetachedWindowState(session, {
        enabled: true,
        cascadeId: pending.cascadeId,
        title: pending.title,
      });
    } else if (detachedWindows.isDetachedTarget(session.targetId)) {
      await pushDetachedWindowState(session, {
        enabled: true,
        cascadeId: '',
      });
    }
    await Promise.allSettled([
      pushUiPrefsToSession(session),
      syncTurnsForSession(session, true),
      pushAccountsToSession(session),
      pushGroupsToSession(session),
      pushKeepAliveToSession(session),
      pushBatchKeepAliveToSession(session),
      pushUpdateToSession(session),
      pushDetachedWindowsToSession(session),
    ]);
    await session.client.send('Runtime.evaluate', {
      expression: 'window.__aqHydrated = true;',
      returnByValue: false,
    });
  };

  let tickPromise = null;

  const runTick = async () => {
    if (stopping) return { liveCount: 0, attachedCount: attached.size };
    const port = readDebugPort(paths.portFile);
    if (!port) {
      targetAttachTracker.reset();
      return { liveCount: 0, attachedCount: attached.size };
    }
    const targets = await fetchCdpTargets(port);
    const liveIds = new Set();
    const targetUrlById = new Map();
    const attachCandidates = [];

    for (const t of targets) {
      if (t.type !== 'page' || !ALLOWED_ORIGIN_RE.test(String(t.url || ''))) continue;
      liveIds.add(t.id);
      targetUrlById.set(t.id, String(t.url || ''));
      if (!attached.has(t.id)) {
        attachCandidates.push(t);
      }
    }
    targetAttachTracker.prune(liveIds);
    if (attachCandidates.length > 0) {
      await Promise.allSettled(attachCandidates.map((t) => attachTarget(t)));
    }

    const sessionEntries = [...attached.entries()];
    await Promise.allSettled(
      sessionEntries.map(async ([id, session]) => {
        if (!liveIds.has(id) || !session.client.isOpen()) {
          session.client.close();
          attached.delete(id);
          return;
        }
        const urlCid = targetUrlById.get(id)?.match(/\/c\/([0-9a-f-]{36})/i)?.[1] || '';
        const stateRes = await session.client.send('Runtime.evaluate', {
          expression:
            '({ v: window.__aq_version || "", h: Boolean(window.__aqHydrated), d: document.documentElement?.getAttribute?.("data-aq-detached-chat") === "1", cid: window.__aqGetWatchedCascadeId ? window.__aqGetWatchedCascadeId() : "" })',
          returnByValue: true,
        });
        if (!stateRes) {
          return;
        }
        const pageState = stateRes?.result?.result?.value;
        if (pageState?.d === true || (pageState?.d === false && Boolean(pageState?.v))) {
          detachedWindows.setDetachedTarget(id, pageState.d);
        }
        const watchedCid = UUID_RE.test(String(pageState?.cid || '')) ? String(pageState.cid) : '';
        const resolvedCid = watchedCid || (pageState?.v ? '' : urlCid);
        if (resolvedCid && resolvedCid !== session.activeCascadeId) {
          session.activeCascadeId = resolvedCid;
          session.lastPushedKey = '';
          session.latestThinkingReqId = '';
          session.lastThinkingPushSig = '';
          session.lastOriginalPushSig = '';
          session.lastClientThinking = null;
        }
        if (!pageState || pageState.v !== version) {
          session.lastPushedRawTurns = null;
          session.lastThinkingPushSig = '';
          session.lastOriginalPushSig = '';
          await session.client.send('Runtime.evaluate', { expression: script, returnByValue: false });
          await hydrateSession(session);
        } else if (!pageState.h) {
          session.lastPushedRawTurns = null;
          session.lastThinkingPushSig = '';
          session.lastOriginalPushSig = '';
          await hydrateSession(session);
        } else {
          await syncTurnsForSession(session, false, { skipCidProbe: Boolean(pageState?.v) });
        }
      })
    );
    await pushDetachedWindowsToAllSessions();
    await checkBatchKeepAliveTimeouts();
    maybeRunPendingDetachedRestore();
    return { liveCount: liveIds.size, attachedCount: attached.size };
  };

  const tick = () => {
    if (tickPromise) return tickPromise;
    tickPromise = runTick().finally(() => {
      tickPromise = null;
    });
    return tickPromise;
  };

  const cleanupState = () => {
    if (stopping) return;
    stopping = true;
    if (sleepTimer) {
      clearTimeout(sleepTimer);
      sleepTimer = null;
    }
    if (wakeLoop) {
      const fn = wakeLoop;
      wakeLoop = null;
      fn();
    }
    try {
      unsubscribeUpdate?.();
    } catch {}
    try {
      unsubscribePricing?.();
    } catch {}
    for (const session of attached.values()) session.client.close();
    attached.clear();
    try {
      if (fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() === String(process.pid)) {
        fs.unlinkSync(pidFile);
      }
    } catch {}
  };

  onRegisterControls?.({
    stop: cleanupState,
    tickNow: () => tick(),
    setRestartInFlight: (flag) => {
      externalRestartInFlight = Boolean(flag);
      if (!externalRestartInFlight) {
        targetAttachTracker.reset();
      }
    },
  });

  const shouldStopFollowing = (tickRes) => {
    if (!followController) return false;
    const effectiveSwitchInFlight = switchInFlight || externalRestartInFlight;
    let isProcessAlive = false;
    if (tickRes.attachedCount === 0 && tickRes.liveCount === 0 && !effectiveSwitchInFlight) {
      const extraExeNames = userCfg.antigravityExe ? [path.win32.basename(userCfg.antigravityExe)] : [];
      isProcessAlive = isAntigravityProcessRunning({ channel, extraExeNames });
    }
    const decision = followController.update({
      hasAttachedTargets: tickRes.attachedCount > 0,
      hasLiveCdpTargets: tickRes.liveCount > 0,
      isProcessAlive,
      switchInFlight: effectiveSwitchInFlight,
    });
    if (decision.shouldExit) {
      log(`[antigravity-quota-injector] exiting (${decision.reason})`);
      return true;
    }
    return false;
  };

  const firstTick = await tick();
  if (once) {
    cleanupState();
    return;
  }
  if (shouldStopFollowing(firstTick)) {
    cleanupState();
    return;
  }

  const handleExitSignal = (signal) => {
    log(`[antigravity-quota-injector] exiting (${signal})`);
    cleanupState();
    process.exit(0);
  };
  const onSigInt = () => handleExitSignal('SIGINT');
  const onSigTerm = () => handleExitSignal('SIGTERM');
  // Ignore terminal/parent-session SIGHUP so closing a host terminal or restarting Antigravity
  // during an account switch never terminates the daemon mid-flight.
  const onSigHup = () => {
    log('[antigravity-quota-injector] ignoring SIGHUP to stay alive across host restarts');
  };

  process.on('SIGINT', onSigInt);
  process.on('SIGTERM', onSigTerm);
  process.on('SIGHUP', onSigHup);

  // Periodic sync loop (stat-gated, minimal overhead when idle)
  try {
    while (!stopping) {
      await new Promise((r) => {
        const pollMs = detachedWindows.hasActivePending() || Boolean(pendingDetachedRestore) ? 350 : 1500;
        wakeLoop = r;
        sleepTimer = setTimeout(() => {
          sleepTimer = null;
          wakeLoop = null;
          r();
        }, pollMs);
      });
      if (stopping) break;
      try {
        void pricingManager.refreshExchangeRate().catch(() => {});
        userCfg = readUserConfig(paths.stateDir);
        const next = buildClientScript(userCfg);
        if (next.version !== version) {
          version = next.version;
          script = next.script;
          for (const session of attached.values()) {
            if (session.evalScriptId) {
              await session.client.send('Page.removeScriptToEvaluateOnNewDocument', {
                identifier: session.evalScriptId,
              });
            }
            const docRes = await session.client.send('Page.addScriptToEvaluateOnNewDocument', { source: script });
            session.evalScriptId = docRes?.result?.identifier || null;
          }
        }
        const tickRes = await tick();
        if (shouldStopFollowing(tickRes)) {
          cleanupState();
          break;
        }
      } catch {}
    }
  } finally {
    cleanupState();
    process.off('SIGINT', onSigInt);
    process.off('SIGTERM', onSigTerm);
    process.off('SIGHUP', onSigHup);
  }
}
