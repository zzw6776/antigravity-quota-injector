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
  reorderConversationGroups,
  syncConversationMetadata,
  toggleConversationGroupCollapse,
} from './conversation-groups.mjs';
import {
  createFollowAppController,
  isAntigravityProcessRunning,
  stopDaemonPid,
} from './platform.mjs';
import { createKeepAliveManager } from './keepalive.mjs';
import {
  getDbSignature,
  parseConversationTurns,
  resolveConversationDbPath,
} from './proto-metrics.mjs';
import { TokenPricingManager } from './token-pricing.mjs';
import { readUiPrefsStore, updateConversationWidthPref } from './ui-prefs.mjs';

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

export function readUserConfig(stateDir) {
  try {
    const cfgPath = path.join(stateDir, 'config.json');
    if (!fs.existsSync(cfgPath)) return { codexTheme: true, zhUi: true, antigravityExe: '' };
    const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return {
      codexTheme: parsed?.codexTheme !== false,
      zhUi: parsed?.zhUi !== false,
      antigravityExe: typeof parsed?.antigravityExe === 'string' ? parsed.antigravityExe.trim() : '',
    };
  } catch {
    return { codexTheme: true, zhUi: true, antigravityExe: '' };
  }
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
  const attached = new Map(); // targetId -> session state
  const targetCooldownUntil = new Map(); // non-host / unreachable targetId -> retry timestamp
  const turnsCache = new Map(); // dbPath -> { sig, payload }
  let stopping = false;
  let switchInFlight = false;
  let externalRestartInFlight = false;
  let wakeLoop = null;
  let sleepTimer = null;

  const pricingManager = new TokenPricingManager({
    stateDir: paths.stateDir,
    refreshOnInitialize: !once,
  });
  await pricingManager.initialize();
  const unsubscribePricing = pricingManager.onChange(() => {
    if (sleepTimer) {
      clearTimeout(sleepTimer);
      sleepTimer = null;
    }
    if (wakeLoop) {
      const fn = wakeLoop;
      wakeLoop = null;
      fn();
    }
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
    const payload = {
      supported: accountSupport.supported,
      unsupportedReason: accountSupport.reason,
      accounts: Array.isArray(extra.accounts)
        ? extra.accounts
        : accountSupport.supported
          ? listAccounts(paths.accountsFile, activeEmail)
          : [],
      busy: Boolean(extra.busy ?? switchInFlight),
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
        return pushAccountsToSession(s, {
          ...extra,
          resolvedEmail,
          accounts: resolveSharedAccounts(resolvedEmail),
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

  const pushUiPrefsToSession = async (session, extra = {}) => {
    if (!session?.client?.isOpen() || !session.hostConfirmed) return;
    const store = extra.store || readUiPrefsStore(paths.uiPrefsFile);
    const payload = {
      convWidthMode: store.convWidthMode,
      convMaxWidth: store.convMaxWidth,
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
      await pushUiPrefsToSession(session);
      return;
    }
    if (type === 'set-conv-width') {
      const store = updateConversationWidthPref(paths.uiPrefsFile, {
        mode: msg?.mode,
        width: msg?.width,
      });
      await pushUiPrefsToAllSessions({ store });
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
        if (switchInFlight) return;
        switchInFlight = true;
        await pushAccountsToAllSessions({
          activeEmail,
          busy: true,
          status: '正在保存当前账号并重启 Antigravity 进入登录页…',
        });
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
          switchInFlight = false;
          log(`[accounts] prepare-add failed: ${err?.message || err}`);
          await pushAccountsToAllSessions({
            activeEmail,
            busy: false,
            error: String(err?.message || '进入新账号登录失败'),
          });
          return;
        }
        switchInFlight = false;
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
        if (switchInFlight) return;
        switchInFlight = true;
        await pushAccountsToAllSessions({
          activeEmail,
          busy: true,
          status: '正在切换账号并重启 Antigravity…',
        });
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
          switchInFlight = false;
          log(`[accounts] switch failed: ${err?.message || err}`);
          await pushAccountsToAllSessions({
            activeEmail,
            busy: false,
            error: String(err?.message || '切换账号失败'),
          });
          return;
        }
        switchInFlight = false;
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

  const PROBE_FAIL_COOLDOWN_MS = 60_000;

  const attachTarget = async (target) => {
    if (attached.has(target.id) || !target.webSocketDebuggerUrl) return;
    const cooldownUntil = targetCooldownUntil.get(target.id) || 0;
    if (cooldownUntil > Date.now()) return;

    let client;
    try {
      client = await createCdpClient(target.webSocketDebuggerUrl);
    } catch {
      targetCooldownUntil.set(target.id, Date.now() + PROBE_FAIL_COOLDOWN_MS);
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
      evalScriptId: null,
    };
    attached.set(target.id, session);

    client.onClose(() => {
      if (attached.get(target.id) === session) {
        attached.delete(target.id);
      }
    });

    const probeRes = await client.send('Runtime.evaluate', {
      expression: `Boolean(window.__APP_CONFIG__?.productName === 'antigravity' || document.getElementById('antigravity.agentSidePanelInputBox'))`,
      returnByValue: true,
    });
    if (probeRes?.result?.result?.value !== true) {
      attached.delete(target.id);
      targetCooldownUntil.set(target.id, Date.now() + PROBE_FAIL_COOLDOWN_MS);
      client.close();
      return;
    }
    targetCooldownUntil.delete(target.id);

    session.hostConfirmed = true;
    await client.send('Runtime.addBinding', { name: '__aqRequestTurns' });
    await client.send('Runtime.addBinding', { name: '__aqAccountAction' });
    await client.send('Runtime.addBinding', { name: '__aqUpdateAction' });
    await client.send('Runtime.addBinding', { name: '__aqGroupAction' });
    await client.send('Runtime.addBinding', { name: '__aqKeepAliveAction' });
    await client.send('Runtime.addBinding', { name: '__aqUiPrefsAction' });

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
      } else if (params?.name === '__aqUiPrefsAction') {
        void handleUiPrefsAction(session, params.payload);
      }
    });

    const docRes = await client.send('Page.addScriptToEvaluateOnNewDocument', { source: script });
    session.evalScriptId = docRes?.result?.identifier || null;

    await client.send('Runtime.evaluate', { expression: script, returnByValue: false });
    await hydrateSession(session);
  };

  const hydrateSession = async (session) => {
    await pushUiPrefsToSession(session);
    await syncTurnsForSession(session, true);
    await pushAccountsToSession(session);
    await pushGroupsToSession(session);
    await pushKeepAliveToSession(session);
    await pushUpdateToSession(session);
    await session.client.send('Runtime.evaluate', {
      expression: 'window.__aqHydrated = true;',
      returnByValue: false,
    });
  };

  let tickPromise = null;

  const runTick = async () => {
    if (stopping) return { liveCount: 0, attachedCount: attached.size };
    const port = readDebugPort(paths.portFile);
    if (!port) return { liveCount: 0, attachedCount: attached.size };
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
    for (const tid of targetCooldownUntil.keys()) {
      if (!liveIds.has(tid)) targetCooldownUntil.delete(tid);
    }
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
            '({ v: window.__aq_version || "", h: Boolean(window.__aqHydrated), cid: window.__aqGetWatchedCascadeId ? window.__aqGetWatchedCascadeId() : "" })',
          returnByValue: true,
        });
        if (!stateRes) {
          return;
        }
        const pageState = stateRes?.result?.result?.value;
        const watchedCid = UUID_RE.test(String(pageState?.cid || '')) ? String(pageState.cid) : '';
        const resolvedCid = watchedCid || (pageState?.v ? '' : urlCid);
        if (resolvedCid && resolvedCid !== session.activeCascadeId) {
          session.activeCascadeId = resolvedCid;
          session.lastPushedKey = '';
        }
        if (!pageState || pageState.v !== version) {
          session.lastPushedRawTurns = null;
          await session.client.send('Runtime.evaluate', { expression: script, returnByValue: false });
          await hydrateSession(session);
        } else if (!pageState.h) {
          session.lastPushedRawTurns = null;
          await hydrateSession(session);
        } else {
          await syncTurnsForSession(session, false, { skipCidProbe: Boolean(pageState?.v) });
        }
      })
    );
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
  const onSigHup = () => handleExitSignal('SIGHUP');

  process.on('SIGINT', onSigInt);
  process.on('SIGTERM', onSigTerm);
  process.on('SIGHUP', onSigHup);

  // Periodic sync loop (stat-gated, minimal overhead when idle)
  try {
    while (!stopping) {
      await new Promise((r) => {
        wakeLoop = r;
        sleepTimer = setTimeout(() => {
          sleepTimer = null;
          wakeLoop = null;
          r();
        }, 1500);
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
