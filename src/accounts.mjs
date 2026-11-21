import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  encodePowerShellCommand,
  escapePowerShellSingleQuoted,
  findRunningAntigravityPids,
  launchAntigravityExecutable,
  quitAndWaitAntigravityProcesses,
} from './platform.mjs';

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
  'jetski.onboarding.lastLoginUsername',
  'jetski.onboarding.lastLoginIsGcpTos',
];

const WINCRED_CSHARP_SOURCE = `
using System;
using System.Runtime.InteropServices;

public static class AqWinCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("Advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredRead(string target, uint type, int reservedFlag, out IntPtr credentialPtr);

  [DllImport("Advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredWrite([In] ref CREDENTIAL userCredential, uint flags);

  [DllImport("Advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredDelete(string target, uint type, int flags);

  [DllImport("Advapi32.dll", EntryPoint = "CredFree", SetLastError = true)]
  private static extern void CredFree(IntPtr cred);

  public static string ReadBase64(string target) {
    IntPtr ptr;
    if (!CredRead(target, 1, 0, out ptr)) {
      int err = Marshal.GetLastWin32Error();
      if (err == 1168) return "";
      throw new Exception("CredReadW failed with error " + err);
    }
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
      if (c.CredentialBlob == IntPtr.Zero || c.CredentialBlobSize == 0) return "";
      byte[] bytes = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, bytes, 0, (int)c.CredentialBlobSize);
      return Convert.ToBase64String(bytes);
    } finally {
      CredFree(ptr);
    }
  }

  public static void WriteBase64(string target, string userName, string base64Payload) {
    byte[] bytes = Convert.FromBase64String(base64Payload);
    IntPtr blobPtr = Marshal.AllocCoTaskMem(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, blobPtr, bytes.Length);
      CREDENTIAL c = new CREDENTIAL();
      c.Flags = 0;
      c.Type = 1;
      c.TargetName = target;
      c.CredentialBlobSize = (uint)bytes.Length;
      c.CredentialBlob = blobPtr;
      c.Persist = 2;
      c.UserName = userName;
      if (!CredWrite(ref c, 0)) {
        throw new Exception("CredWriteW failed with error " + Marshal.GetLastWin32Error());
      }
    } finally {
      Marshal.FreeCoTaskMem(blobPtr);
    }
  }

  public static bool Delete(string target) {
    if (!CredDelete(target, 1, 0)) {
      int err = Marshal.GetLastWin32Error();
      if (err == 1168) return false;
      throw new Exception("CredDeleteW failed with error " + err);
    }
    return true;
  }
}
`;

function runWinCredPowerShell(bodyLines, execFileSyncFn = execFileSync) {
  const psScript = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "if (-not ('AqWinCred' -as [type])) {",
    `  Add-Type -TypeDefinition @'\n${WINCRED_CSHARP_SOURCE}\n'@`,
    '}',
    ...bodyLines,
  ].join('\n');
  return execFileSyncFn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodePowerShellCommand(psScript),
    ],
    {
      timeout: 8000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }
  );
}

export function getAccountSwitchSupport(platform = process.platform) {
  if (platform === 'darwin' || platform === 'win32') {
    return { supported: true, reason: '' };
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
  platform = process.platform,
  execFileSyncFn = execFileSync,
} = {}) {
  if (platform === 'win32') {
    const target = `${service}:${account}`;
    try {
      const out = runWinCredPowerShell(
        [`Write-Output ([AqWinCred]::ReadBase64('${escapePowerShellSingleQuoted(target)}'))`],
        execFileSyncFn
      );
      const b64 = String(out || '').trim();
      if (!b64) return '';
      return Buffer.from(b64, 'base64').toString('utf8').replace(/[\r\n]+$/, '');
    } catch {
      throw new Error('读取系统凭据管理器登录凭据失败');
    }
  }
  if (platform !== 'darwin') {
    throw new Error('当前系统暂不支持读取账号凭据');
  }
  try {
    const out = execFileSyncFn(
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
  platform = process.platform,
  execFileSyncFn = execFileSync,
} = {}) {
  if (platform === 'win32') {
    const target = `${service}:${account}`;
    try {
      const out = runWinCredPowerShell(
        [
          `if ([AqWinCred]::Delete('${escapePowerShellSingleQuoted(target)}')) { Write-Output 'DELETED' } else { Write-Output 'NOT_FOUND' }`,
        ],
        execFileSyncFn
      );
      return String(out || '').trim() === 'DELETED';
    } catch {
      throw new Error('清理系统凭据管理器登录凭据失败');
    }
  }
  if (platform !== 'darwin') {
    throw new Error('当前系统暂不支持清理账号凭据');
  }
  try {
    execFileSyncFn('security', ['delete-generic-password', '-a', account, '-s', service], {
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
  {
    service = KEYCHAIN_SERVICE,
    account = KEYCHAIN_ACCOUNT,
    platform = process.platform,
    execFileSyncFn = execFileSync,
  } = {}
) {
  if (!secret || typeof secret !== 'string') {
    throw new Error('无效的账号凭据快照');
  }
  if (platform === 'win32') {
    const target = `${service}:${account}`;
    let rawSecret = secret;
    const b64Prefix = 'go-keyring-base64:';
    if (rawSecret.startsWith(b64Prefix)) {
      try {
        rawSecret = Buffer.from(rawSecret.slice(b64Prefix.length), 'base64').toString('utf8');
      } catch {}
    }
    const base64Payload = Buffer.from(rawSecret, 'utf8').toString('base64');
    try {
      runWinCredPowerShell(
        [
          `[AqWinCred]::WriteBase64('${escapePowerShellSingleQuoted(target)}', '${escapePowerShellSingleQuoted(account)}', '${base64Payload}')`,
        ],
        execFileSyncFn
      );
      return;
    } catch {
      throw new Error('写入系统凭据管理器登录凭据失败');
    }
  }
  if (platform !== 'darwin') {
    throw new Error('当前系统暂不支持写入账号凭据');
  }
  try {
    execFileSyncFn(
      'security',
      ['add-generic-password', '-U', '-a', account, '-s', service, '-w', secret],
      {
        timeout: 2500,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
  } catch {
    try {
      execFileSyncFn('security', ['delete-generic-password', '-a', account, '-s', service], {
        timeout: 2500,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {}
    execFileSyncFn(
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

export function sanitizeQuotaSnapshot(rawQuota) {
  if (!rawQuota || typeof rawQuota !== 'object') return null;
  const rawGroups = Array.isArray(rawQuota.groups) ? rawQuota.groups : [];
  if (rawGroups.length === 0) return null;

  const groups = [];
  for (const g of rawGroups) {
    if (!g || typeof g !== 'object') continue;
    const displayName = String(g.displayName || '').trim();
    const rawBuckets = Array.isArray(g.buckets) ? g.buckets : [];
    const buckets = [];
    for (const b of rawBuckets) {
      if (!b || typeof b !== 'object' || b.disabled) continue;
      const frac = Number(b.remainingFraction);
      if (!Number.isFinite(frac)) continue;
      buckets.push({
        bucketId: String(b.bucketId || '').trim(),
        displayName: String(b.displayName || '').trim(),
        window: String(b.window || '').trim(),
        remainingFraction: Math.max(0, Math.min(1, frac)),
        resetTime: String(b.resetTime || '').trim(),
      });
    }
    if (displayName || buckets.length > 0) {
      groups.push({ displayName: displayName || '模型分组', buckets });
    }
  }
  if (groups.length === 0) return null;

  const parsedUpdated = Date.parse(String(rawQuota.updatedAt || ''));
  const updatedAt = Number.isFinite(parsedUpdated)
    ? new Date(parsedUpdated).toISOString()
    : new Date().toISOString();
  return { updatedAt, groups };
}

function quotaSnapshotDataSignature(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.groups)) return '';
  return JSON.stringify(snapshot.groups);
}

/**
 * Update only the cached quota snapshot for an existing saved account without touching keychain credentials.
 */
export function updateAccountQuotaSnapshot({ accountsFile, email, quota }) {
  const normEmail = String(email || '').trim().toLowerCase();
  if (!normEmail) return { updated: false, changed: false };
  const snapshot = sanitizeQuotaSnapshot(quota);
  if (!snapshot) return { updated: false, changed: false };

  const store = readAccountsStore(accountsFile);
  const idx = store.accounts.findIndex(
    (a) => String(a?.email || '').trim().toLowerCase() === normEmail || String(a?.id || '').toLowerCase() === normEmail
  );
  if (idx < 0) return { updated: false, changed: false };

  const prev = store.accounts[idx];
  const prevSig = quotaSnapshotDataSignature(prev?.quotaSnapshot);
  const nextSig = quotaSnapshotDataSignature(snapshot);
  const prevAt = Date.parse(String(prev?.quotaSnapshot?.updatedAt || ''));
  const nextAt = Date.parse(snapshot.updatedAt);
  const changed = prevSig !== nextSig;
  if (!changed && Number.isFinite(prevAt) && Number.isFinite(nextAt) && nextAt - prevAt < 60_000) {
    return { updated: false, changed: false };
  }

  store.accounts[idx] = {
    ...prev,
    quotaSnapshot: snapshot,
  };
  writeAccountsStore(accountsFile, store);
  return { updated: true, changed, snapshot };
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
      quotaSnapshot: sanitizeQuotaSnapshot(item?.quotaSnapshot),
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
  const raw =
    appStorageAuth?.['agy.onboarding.lastLoginUsername'] ||
    appStorageAuth?.['jetski.onboarding.lastLoginUsername'];
  if (!raw || typeof raw !== 'string') return '';
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed.trim() : '';
  } catch {
    return raw.replace(/^"+|"+$/g, '').trim();
  }
}

export function readLastLoginEmail(appSupportDir) {
  if (!appSupportDir) return '';
  return resolveEmailFromAppStorage(readAppStorageAuth(appSupportDir));
}

export function snapshotCurrentAccount({
  accountsFile,
  appSupportDir,
  profile = {},
  quota = null,
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
  const quotaSnapshot =
    (profileMatchesEmail ? sanitizeQuotaSnapshot(quota) : null) ||
    sanitizeQuotaSnapshot(prev?.quotaSnapshot);
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
    ...(quotaSnapshot ? { quotaSnapshot } : {}),
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

export function reorderAccounts(accountsFile, orderedIds) {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) return { changed: false };
  const store = readAccountsStore(accountsFile);
  if (store.accounts.length <= 1) return { changed: false };

  const byId = new Map();
  for (const item of store.accounts) {
    const key = String(item?.id || normalizeAccountId(item?.email)).toLowerCase();
    if (key && !byId.has(key)) {
      byId.set(key, item);
    }
  }

  const next = [];
  const seen = new Set();
  for (const rawId of orderedIds) {
    const key = String(rawId || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    const found = byId.get(key);
    if (found) {
      seen.add(key);
      next.push(found);
    }
  }
  for (const item of store.accounts) {
    const key = String(item?.id || normalizeAccountId(item?.email)).toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      next.push(item);
    }
  }

  const changed = next.some((item, idx) => item !== store.accounts[idx]);
  if (!changed) return { changed: false };
  writeAccountsStore(accountsFile, { ...store, accounts: next });
  return { changed: true };
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
      : {
          'agy.onboarding.lastLoginUsername': JSON.stringify(target.email),
          'jetski.onboarding.lastLoginUsername': target.email,
        };
  writeAppStorageAuth(appSupportDir, appAuth);
  writeVscdbAuth(appSupportDir, target.vscdbAuth);
  return target;
}

export async function quitAndWaitAntigravity({ channel = 'stable', timeoutMs = 8000 } = {}) {
  return quitAndWaitAntigravityProcesses({ channel, timeoutMs });
}

export function launchAntigravityApp({ channel = 'stable', stateDir = '' } = {}) {
  const res = launchAntigravityExecutable({ channel, stateDir });
  if (!res.launched) {
    throw new Error(res.reason || '未找到 Antigravity 应用');
  }
  return res;
}

export async function waitForAntigravityLaunch({ channel = 'stable', timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (findRunningAntigravityPids({ channel }).length > 0) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function relaunchAntigravityWithRetry({
  channel = 'stable',
  stateDir = '',
  launchFn = launchAntigravityApp,
  waitLaunchFn = waitForAntigravityLaunch,
} = {}) {
  launchFn({ channel, stateDir });
  const firstOk = await waitLaunchFn({ channel, timeoutMs: 4000 });
  if (firstOk) return true;
  await new Promise((r) => setTimeout(r, 600));
  launchFn({ channel, stateDir });
  return Boolean(await waitLaunchFn({ channel, timeoutMs: 6000 }));
}

export async function switchAccountWithRestart({
  accountId,
  accountsFile,
  appSupportDir,
  channel = 'stable',
  currentProfile = null,
  currentQuota = null,
  platform = process.platform,
  quitFn = quitAndWaitAntigravity,
  launchFn = launchAntigravityApp,
  waitLaunchFn = waitForAntigravityLaunch,
}) {
  const support = getAccountSwitchSupport(platform);
  if (!support.supported) {
    throw new Error(support.reason);
  }
  const stateDir = accountsFile ? path.dirname(accountsFile) : '';

  // Best-effort snapshot of current active account so credentials and latest quota are never lost
  if (currentProfile?.email) {
    try {
      snapshotCurrentAccount({
        accountsFile,
        appSupportDir,
        profile: currentProfile,
        quota: currentQuota,
      });
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

  const exited = await quitFn({ channel });
  if (!exited) {
    try {
      launchFn({ channel, stateDir });
    } catch {}
    throw new Error('Antigravity 未能及时退出，已取消写入凭据');
  }

  try {
    const portFile = path.join(appSupportDir, 'DevToolsActivePort');
    if (fs.existsSync(portFile)) fs.unlinkSync(portFile);
  } catch {}

  const applied = applyAccountSnapshot({ accountId, accountsFile, appSupportDir });
  await new Promise((r) => setTimeout(r, 250));
  const relaunched = await relaunchAntigravityWithRetry({
    channel,
    stateDir,
    launchFn,
    waitLaunchFn,
  });
  if (!relaunched) {
    throw new Error('账号凭据已切换，但自动重新打开 Antigravity 超时，请手动启动注入器打开');
  }
  return applied;
}

export async function prepareNewAccountWithRestart({
  accountsFile,
  appSupportDir,
  channel = 'stable',
  currentProfile = null,
  currentQuota = null,
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
      quota: currentQuota,
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

  try {
    const portFile = path.join(appSupportDir, 'DevToolsActivePort');
    if (fs.existsSync(portFile)) fs.unlinkSync(portFile);
  } catch {}

  clearCurrentAccountAuth({ appSupportDir, deleteSecretFn });
  await new Promise((r) => setTimeout(r, 250));
  const relaunched = await relaunchAntigravityWithRetry({
    channel,
    stateDir,
    launchFn,
    waitLaunchFn,
  });
  if (!relaunched) {
    throw new Error('已清理当前登录状态，但自动重新打开 Antigravity 超时，请手动启动注入器打开');
  }
  return savedEntry;
}
