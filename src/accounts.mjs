import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { launchAntigravityExecutable } from './platform.mjs';

const KEYCHAIN_SERVICE = 'gemini';
const KEYCHAIN_ACCOUNT = 'antigravity';
const VSCDB_AUTH_KEYS = [
  'antigravityUnifiedStateSync.oauthToken',
  'antigravityUnifiedStateSync.userStatus',
  'antigravity.profileUrl',
  'antigravityUnifiedStateSync.modelCredits',
];
const APP_STORAGE_AUTH_KEYS = [
  'agy.onboarding.lastLoginUsername',
  'agy.onboarding.lastLoginIsGcpTos',
];

export function getAccountSwitchSupport(platform = process.platform) {
  if (platform === 'darwin') {
    return { supported: true, reason: '' };
  }
  if (platform === 'win32') {
    return { supported: false, reason: 'Windows 暂不支持账号快照与一键切换' };
  }
  return { supported: false, reason: '当前系统暂不支持账号快照与一键切换' };
}

function atomicWriteFile(filePath, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode });
  if (process.platform !== 'win32') {
    fs.chmodSync(tmpPath, mode);
  }
  fs.renameSync(tmpPath, filePath);
}

export function normalizeAccountId(email, fallbackSeed = '') {
  const clean = String(email || '').trim().toLowerCase();
  if (clean) return clean;
  const h = crypto.createHash('sha256').update(String(fallbackSeed || '')).digest('hex').slice(0, 12);
  return `account-${h}`;
}

export function parseKeychainSecretMetadata(secret) {
  const raw = String(secret || '').trim();
  if (!raw) return { usable: false, email: '' };

  let decoded = raw;
  const b64Prefix = 'go-keyring-base64:';
  if (raw.startsWith(b64Prefix)) {
    try {
      decoded = Buffer.from(raw.slice(b64Prefix.length), 'base64').toString('utf8');
    } catch {
      return { usable: false, email: '' };
    }
  }

  const trimmed = decoded.trim();
  if (!trimmed.startsWith('{')) {
    return { usable: true, email: '' };
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { usable: false, email: '' };
    }
    const tokenObj = parsed.token && typeof parsed.token === 'object' ? parsed.token : parsed;
    const hasToken = Boolean(
      (typeof tokenObj.access_token === 'string' && tokenObj.access_token.trim()) ||
        (typeof tokenObj.refresh_token === 'string' && tokenObj.refresh_token.trim()) ||
        (typeof tokenObj.accessToken === 'string' && tokenObj.accessToken.trim()) ||
        (typeof tokenObj.refreshToken === 'string' && tokenObj.refreshToken.trim())
    );
    const email = typeof parsed.id_token_email === 'string' ? parsed.id_token_email.trim() : '';
    return { usable: hasToken, email };
  } catch {
    return { usable: false, email: '' };
  }
}

export function readKeychainSecret({
  service = KEYCHAIN_SERVICE,
  account = KEYCHAIN_ACCOUNT,
} = {}) {
  if (process.platform !== 'darwin') {
    throw new Error('当前仅支持 macOS Keychain 账号快照');
  }
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-s', service, '-a', account, '-w'],
      {
        timeout: 2500,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    return String(out || '').replace(/[\r\n]+$/, '');
  } catch (err) {
    const stderr = String(err?.stderr || err?.message || '');
    if (
      err?.status === 44 ||
      /could not be found in the keychain|SecKeychainSearchCopyNext/i.test(stderr)
    ) {
      return '';
    }
    throw new Error('读取系统钥匙串登录凭据失败');
  }
}

export function deleteKeychainSecret({
  service = KEYCHAIN_SERVICE,
  account = KEYCHAIN_ACCOUNT,
} = {}) {
  if (process.platform !== 'darwin') {
    throw new Error('当前仅支持 macOS Keychain 账号快照');
  }
  try {
    execFileSync('security', ['delete-generic-password', '-a', account, '-s', service], {
      timeout: 2500,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = String(err?.stderr || err?.message || '');
    if (
      err?.status === 44 ||
      /could not be found in the keychain|SecKeychainSearchCopyNext/i.test(stderr)
    ) {
      return false;
    }
    throw new Error('清理系统钥匙串登录凭据失败');
  }
  return true;
}

export function writeKeychainSecret(
  secret,
  { service = KEYCHAIN_SERVICE, account = KEYCHAIN_ACCOUNT } = {}
) {
  if (process.platform !== 'darwin') {
    throw new Error('当前仅支持 macOS Keychain 账号快照');
  }
  if (!secret || typeof secret !== 'string') {
    throw new Error('无效的账号凭据快照');
  }
  try {
    execFileSync(
      'security',
      ['add-generic-password', '-U', '-a', account, '-s', service, '-w', secret],
      {
        timeout: 2500,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
  } catch {
    try {
      execFileSync('security', ['delete-generic-password', '-a', account, '-s', service], {
        timeout: 2500,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {}
    execFileSync(
      'security',
      ['add-generic-password', '-a', account, '-s', service, '-w', secret],
      {
        timeout: 2500,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
  }
}

export function readAccountsStore(accountsFile) {
  try {
    if (!fs.existsSync(accountsFile)) return { version: 1, accounts: [] };
    const parsed = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
    if (!Array.isArray(parsed?.accounts)) return { version: 1, accounts: [] };
    return { version: 1, accounts: parsed.accounts };
  } catch {
    return { version: 1, accounts: [] };
  }
}

export function writeAccountsStore(accountsFile, store) {
  atomicWriteFile(accountsFile, `${JSON.stringify({ version: 1, accounts: store.accounts || [] }, null, 2)}\n`, 0o600);
}

/**
 * Return UI-safe account summaries without exposing credentials or raw tokens.
 */
export function listAccounts(accountsFile, activeEmail = '') {
  const store = readAccountsStore(accountsFile);
  const normActive = String(activeEmail || '').trim().toLowerCase();
  return store.accounts.map((item) => {
    const email = String(item?.email || '').trim();
    return {
      id: String(item?.id || normalizeAccountId(email)),
      email,
      name: String(item?.name || '').trim(),
      planName: String(item?.planName || '').trim(),
      savedAt: String(item?.savedAt || ''),
      active: Boolean(normActive && email.toLowerCase() === normActive),
    };
  });
}

function readAppStorageAuth(appSupportDir) {
  try {
    const p = path.join(appSupportDir, 'app_storage.json');
    if (!fs.existsSync(p)) return {};
    const json = JSON.parse(fs.readFileSync(p, 'utf8'));
    const out = {};
    for (const k of APP_STORAGE_AUTH_KEYS) {
      if (Object.prototype.hasOwnProperty.call(json, k)) {
        out[k] = json[k];
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeAppStorageAuth(appSupportDir, authMap) {
  const map = authMap && typeof authMap === 'object' ? authMap : {};
  const p = path.join(appSupportDir, 'app_storage.json');
  const fileExists = fs.existsSync(p);
  if (!fileExists && Object.keys(map).length === 0) return;
  let json = {};
  try {
    if (fileExists) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        json = parsed;
      }
    }
  } catch {}
  for (const k of APP_STORAGE_AUTH_KEYS) {
    if (Object.prototype.hasOwnProperty.call(map, k)) {
      json[k] = map[k];
    } else {
      delete json[k];
    }
  }
  atomicWriteFile(p, JSON.stringify(json, null, 2), 0o644);
}

function clearAppStorageAuth(appSupportDir) {
  writeAppStorageAuth(appSupportDir, {});
}

function readVscdbAuth(appSupportDir) {
  const dbPath = path.join(appSupportDir, 'User', 'globalStorage', 'state.vscdb');
  if (!fs.existsSync(dbPath)) return {};
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 300 });
    const out = {};
    const stmt = db.prepare('SELECT value FROM ItemTable WHERE key = ?');
    for (const k of VSCDB_AUTH_KEYS) {
      const row = stmt.get(k);
      if (row && row.value != null) out[k] = String(row.value);
    }
    return out;
  } catch {
    return {};
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

function writeVscdbAuth(appSupportDir, vscdbAuth) {
  const map = vscdbAuth && typeof vscdbAuth === 'object' ? vscdbAuth : {};
  const dbPath = path.join(appSupportDir, 'User', 'globalStorage', 'state.vscdb');
  if (!fs.existsSync(dbPath)) return;
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { timeout: 500 });
    db.exec('BEGIN IMMEDIATE');
    const upsertStmt = db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)');
    const deleteStmt = db.prepare('DELETE FROM ItemTable WHERE key = ?');
    for (const k of VSCDB_AUTH_KEYS) {
      if (Object.prototype.hasOwnProperty.call(map, k)) {
        upsertStmt.run(k, String(map[k]));
      } else {
        deleteStmt.run(k);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db?.exec('ROLLBACK');
    } catch {}
    throw err;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

function clearVscdbAuth(appSupportDir) {
  try {
    writeVscdbAuth(appSupportDir, {});
  } catch {}
}

export function clearCurrentAccountAuth({
  appSupportDir,
  deleteSecretFn = deleteKeychainSecret,
}) {
  deleteSecretFn();
  const scopePath = path.join(appSupportDir, 'credential-user-scope');
  try {
    if (fs.existsSync(scopePath)) {
      fs.unlinkSync(scopePath);
    }
  } catch {}
  clearAppStorageAuth(appSupportDir);
  clearVscdbAuth(appSupportDir);
}

function resolveEmailFromAppStorage(appStorageAuth) {
  const raw = appStorageAuth?.['agy.onboarding.lastLoginUsername'];
  if (!raw || typeof raw !== 'string') return '';
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed.trim() : '';
  } catch {
    return raw.replace(/^"+|"+$/g, '').trim();
  }
}

export function snapshotCurrentAccount({
  accountsFile,
  appSupportDir,
  profile = {},
  readSecretFn = readKeychainSecret,
}) {
  const keychainSecret = readSecretFn();
  const secretMeta = parseKeychainSecretMetadata(keychainSecret);
  if (!keychainSecret || !secretMeta.usable) {
    throw new Error('未检测到当前账号的本地登录凭据，请重新登录后再试');
  }
  const appStorageAuth = readAppStorageAuth(appSupportDir);
  const email = String(
    secretMeta.email || profile?.email || resolveEmailFromAppStorage(appStorageAuth) || ''
  ).trim();
  if (!email) {
    throw new Error('未获取到当前登录邮箱');
  }

  const profileMatchesEmail =
    !profile?.email || String(profile.email).trim().toLowerCase() === email.toLowerCase();

  let credentialUserScope = '';
  const scopePath = path.join(appSupportDir, 'credential-user-scope');
  if (fs.existsSync(scopePath)) {
    credentialUserScope = fs.readFileSync(scopePath, 'utf8').trim();
  }

  const vscdbAuth = readVscdbAuth(appSupportDir);
  const id = normalizeAccountId(email, keychainSecret);
  const store = readAccountsStore(accountsFile);
  const idx = store.accounts.findIndex(
    (a) => a.id === id || String(a.email || '').toLowerCase() === email.toLowerCase()
  );
  const prev = idx >= 0 ? store.accounts[idx] : null;
  const entry = {
    id,
    email,
    name: String((profileMatchesEmail ? profile?.name : '') || prev?.name || '').trim(),
    planName: String((profileMatchesEmail ? profile?.planName : '') || prev?.planName || '').trim(),
    savedAt: new Date().toISOString(),
    keychainSecret,
    credentialUserScope,
    appStorageAuth,
    vscdbAuth,
  };

  if (idx >= 0) {
    store.accounts[idx] = { ...prev, ...entry };
  } else {
    store.accounts.push(entry);
  }
  writeAccountsStore(accountsFile, store);
  return entry;
}

export function deleteAccount(accountsFile, accountId) {
  const target = String(accountId || '').trim().toLowerCase();
  if (!target) return false;
  const store = readAccountsStore(accountsFile);
  const next = store.accounts.filter(
    (a) => a.id?.toLowerCase() !== target && String(a.email || '').toLowerCase() !== target
  );
  if (next.length === store.accounts.length) return false;
  writeAccountsStore(accountsFile, { ...store, accounts: next });
  return true;
}

export function applyAccountSnapshot({
  accountId,
  accountsFile,
  appSupportDir,
  writeSecretFn = writeKeychainSecret,
}) {
  const targetId = String(accountId || '').trim().toLowerCase();
  const store = readAccountsStore(accountsFile);
  const target = store.accounts.find(
    (a) => a.id?.toLowerCase() === targetId || String(a.email || '').toLowerCase() === targetId
  );
  if (!target || !target.keychainSecret || !parseKeychainSecretMetadata(target.keychainSecret).usable) {
    throw new Error('未找到目标账号的本地凭据快照');
  }

  writeSecretFn(target.keychainSecret);
  const scopePath = path.join(appSupportDir, 'credential-user-scope');
  if (target.credentialUserScope) {
    atomicWriteFile(scopePath, target.credentialUserScope, 0o644);
  } else {
    try {
      if (fs.existsSync(scopePath)) fs.unlinkSync(scopePath);
    } catch {}
  }
  const appAuth =
    target.appStorageAuth && Object.keys(target.appStorageAuth).length > 0
      ? target.appStorageAuth
      : { 'agy.onboarding.lastLoginUsername': JSON.stringify(target.email) };
  writeAppStorageAuth(appSupportDir, appAuth);
  writeVscdbAuth(appSupportDir, target.vscdbAuth);
  return target;
}

function findRunningAntigravityPids(appName = 'Antigravity') {
  try {
    const out = execFileSync('pgrep', ['-f', `${appName}.app/Contents/(MacOS|Resources/bin)/`], {
      timeout: 1500,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out
      .split(/\s+/)
      .map((s) => Number.parseInt(s, 10))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

export async function quitAndWaitAntigravity({ channel = 'stable', timeoutMs = 8000 } = {}) {
  const appName = channel === 'insiders' ? 'Antigravity - Insiders' : 'Antigravity';
  if (process.platform === 'darwin') {
    try {
      execFileSync('osascript', ['-e', `tell application "${appName}" to quit`], {
        timeout: 2500,
        stdio: 'ignore',
      });
    } catch {}
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (findRunningAntigravityPids(appName).length === 0) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  // Fallback graceful SIGTERM if osascript quit hung on a dialog
  for (const pid of findRunningAntigravityPids(appName)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
  const termDeadline = Date.now() + 2500;
  while (Date.now() < termDeadline) {
    if (findRunningAntigravityPids(appName).length === 0) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return findRunningAntigravityPids(appName).length === 0;
}

export function launchAntigravityApp({ channel = 'stable', stateDir = '' } = {}) {
  const res = launchAntigravityExecutable({ channel, stateDir });
  if (!res.launched) {
    throw new Error(res.reason || '未找到 Antigravity 应用');
  }
  return res;
}

export async function waitForAntigravityLaunch({ channel = 'stable', timeoutMs = 8000 } = {}) {
  const appName = channel === 'insiders' ? 'Antigravity - Insiders' : 'Antigravity';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (findRunningAntigravityPids(appName).length > 0) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export async function switchAccountWithRestart({
  accountId,
  accountsFile,
  appSupportDir,
  channel = 'stable',
  currentProfile = null,
}) {
  const support = getAccountSwitchSupport();
  if (!support.supported) {
    throw new Error(support.reason);
  }
  const stateDir = accountsFile ? path.dirname(accountsFile) : '';

  // Best-effort snapshot of current active account so credentials are never lost
  if (currentProfile?.email) {
    try {
      snapshotCurrentAccount({ accountsFile, appSupportDir, profile: currentProfile });
    } catch {}
  }

  // Validate target snapshot exists before shutting down the running app
  const targetId = String(accountId || '').trim().toLowerCase();
  const store = readAccountsStore(accountsFile);
  const exists = store.accounts.find(
    (a) => a.id?.toLowerCase() === targetId || String(a.email || '').toLowerCase() === targetId
  );
  if (!exists || !exists.keychainSecret || !parseKeychainSecretMetadata(exists.keychainSecret).usable) {
    throw new Error('目标账号快照不存在或已损坏');
  }

  const exited = await quitAndWaitAntigravity({ channel });
  if (!exited) {
    try {
      launchAntigravityApp({ channel, stateDir });
    } catch {}
    throw new Error('Antigravity 未能及时退出，已取消写入凭据');
  }

  const applied = applyAccountSnapshot({ accountId, accountsFile, appSupportDir });
  await new Promise((r) => setTimeout(r, 250));
  launchAntigravityApp({ channel, stateDir });
  await waitForAntigravityLaunch({ channel });
  return applied;
}

export async function prepareNewAccountWithRestart({
  accountsFile,
  appSupportDir,
  channel = 'stable',
  currentProfile = null,
  platform = process.platform,
  readSecretFn = readKeychainSecret,
  deleteSecretFn = deleteKeychainSecret,
  quitFn = quitAndWaitAntigravity,
  launchFn = launchAntigravityApp,
  waitLaunchFn = waitForAntigravityLaunch,
}) {
  const support = getAccountSwitchSupport(platform);
  if (!support.supported) {
    throw new Error(support.reason);
  }
  const stateDir = accountsFile ? path.dirname(accountsFile) : '';

  let savedEntry = null;
  try {
    savedEntry = snapshotCurrentAccount({
      accountsFile,
      appSupportDir,
      profile: currentProfile || {},
      readSecretFn,
    });
  } catch {}

  const exited = await quitFn({ channel });
  if (!exited) {
    try {
      launchFn({ channel, stateDir });
    } catch {}
    throw new Error('Antigravity 未能及时退出，已取消进入新账号登录');
  }

  clearCurrentAccountAuth({ appSupportDir, deleteSecretFn });
  await new Promise((r) => setTimeout(r, 250));
  launchFn({ channel, stateDir });
  await waitLaunchFn({ channel });
  return savedEntry;
}
