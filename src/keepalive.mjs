import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const IN_FLIGHT_LEASE_MS = 60_000;
const ERROR_BACKOFF_MS = 15 * 60_000;
export const KEEP_ALIVE_COOLDOWN_MS = 300_000;
const DEFAULT_COOLDOWN_MS = KEEP_ALIVE_COOLDOWN_MS;

function normalizeAccountKey(email) {
  const clean = String(email || '').trim().toLowerCase();
  return clean || 'default';
}

function normalizePoolKey(poolKey) {
  return String(poolKey || '').trim().toLowerCase();
}

function atomicWriteJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') {
    fs.chmodSync(tmpPath, 0o600);
  }
  fs.renameSync(tmpPath, filePath);
}

function emptyStore() {
  return { version: 1, accounts: {} };
}

function sanitizePoolEntry(raw) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: Boolean(obj.enabled),
    preferredModel: String(obj.preferredModel || '').trim(),
    lastTriggeredAt: Number(obj.lastTriggeredAt) || 0,
    lastSucceededAt: Number(obj.lastSucceededAt) || 0,
    lastModelLabel: String(obj.lastModelLabel || '').trim(),
    lastError: String(obj.lastError || '').trim(),
    backoffUntil: Number(obj.backoffUntil) || 0,
  };
}

export function readKeepAliveStore(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return emptyStore();
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return emptyStore();
    }
    const rawAccounts = parsed.accounts && typeof parsed.accounts === 'object' ? parsed.accounts : {};
    const accounts = {};
    for (const [acctKey, acctVal] of Object.entries(rawAccounts)) {
      const cleanAcct = normalizeAccountKey(acctKey);
      const rawPools = acctVal?.pools && typeof acctVal.pools === 'object' ? acctVal.pools : {};
      const pools = {};
      for (const [pKey, pVal] of Object.entries(rawPools)) {
        const cleanPool = normalizePoolKey(pKey);
        if (!cleanPool) continue;
        pools[cleanPool] = sanitizePoolEntry(pVal);
      }
      accounts[cleanAcct] = { pools };
    }
    return { version: 1, accounts };
  } catch {
    return emptyStore();
  }
}

export function createKeepAliveManager({
  stateDir,
  filePath = stateDir ? path.join(stateDir, 'keepalive.json') : '',
  leaseMs = IN_FLIGHT_LEASE_MS,
  backoffMs = ERROR_BACKOFF_MS,
  defaultCooldownMs = DEFAULT_COOLDOWN_MS,
  nowFn = () => Date.now(),
} = {}) {
  let store = readKeepAliveStore(filePath);
  const inFlight = new Map(); // `${acctKey}|${poolKey}` -> { runId, startedAt }

  const save = () => {
    if (!filePath) return;
    atomicWriteJson(filePath, store);
  };

  const pruneInFlight = (nowMs) => {
    for (const [k, lease] of inFlight.entries()) {
      if (nowMs - lease.startedAt >= leaseMs) {
        inFlight.delete(k);
      }
    }
  };

  const ensureAccountPools = (accountEmail) => {
    const acctKey = normalizeAccountKey(accountEmail);
    if (!store.accounts[acctKey]) {
      store.accounts[acctKey] = { pools: {} };
    }
    return { acctKey, pools: store.accounts[acctKey].pools };
  };

  const ensurePoolEntry = (accountEmail, poolKey) => {
    const { acctKey, pools } = ensureAccountPools(accountEmail);
    const pKey = normalizePoolKey(poolKey);
    if (!pKey) return null;
    if (!pools[pKey]) {
      pools[pKey] = sanitizePoolEntry(null);
    }
    return { acctKey, pKey, entry: pools[pKey] };
  };

  const getState = (accountEmail = '') => {
    const nowMs = nowFn();
    pruneInFlight(nowMs);
    const acctKey = normalizeAccountKey(accountEmail);
    const rawPools = store.accounts[acctKey]?.pools || {};
    const pools = {};
    for (const [pKey, entry] of Object.entries(rawPools)) {
      const leaseKey = `${acctKey}|${pKey}`;
      pools[pKey] = {
        ...entry,
        inFlight: inFlight.has(leaseKey),
      };
    }
    // Also expose in-flight flags if a pool hasn't been persisted yet
    for (const [leaseKey] of inFlight.entries()) {
      if (!leaseKey.startsWith(`${acctKey}|`)) continue;
      const pKey = leaseKey.slice(acctKey.length + 1);
      if (pKey && !pools[pKey]) {
        pools[pKey] = {
          ...sanitizePoolEntry(null),
          inFlight: true,
        };
      }
    }
    return { accountId: acctKey, pools };
  };

  const setPoolEnabled = ({ accountEmail = '', poolKey, enabled }) => {
    const target = ensurePoolEntry(accountEmail, poolKey);
    if (!target) return getState(accountEmail);
    target.entry.enabled = Boolean(enabled);
    if (target.entry.enabled) {
      target.entry.backoffUntil = 0;
      target.entry.lastError = '';
    }
    save();
    return getState(accountEmail);
  };

  const setPoolModel = ({ accountEmail = '', poolKey, modelId }) => {
    const target = ensurePoolEntry(accountEmail, poolKey);
    if (!target) return getState(accountEmail);
    target.entry.preferredModel = String(modelId || '').trim();
    target.entry.backoffUntil = 0;
    target.entry.lastError = '';
    save();
    return getState(accountEmail);
  };

  const claimTrigger = ({
    accountEmail = '',
    poolKey,
    manual = false,
    cooldownMs = defaultCooldownMs,
  }) => {
    const nowMs = nowFn();
    pruneInFlight(nowMs);
    const target = ensurePoolEntry(accountEmail, poolKey);
    if (!target) {
      return { allowed: false, reason: 'invalid_pool', runId: '' };
    }
    const leaseKey = `${target.acctKey}|${target.pKey}`;
    if (inFlight.has(leaseKey)) {
      return { allowed: false, reason: 'in_flight', runId: '' };
    }
    if (!manual) {
      if (!target.entry.enabled) {
        return { allowed: false, reason: 'disabled', runId: '' };
      }
      if (target.entry.backoffUntil && nowMs < target.entry.backoffUntil) {
        return { allowed: false, reason: 'backoff', runId: '' };
      }
      if (target.entry.lastTriggeredAt && nowMs - target.entry.lastTriggeredAt < cooldownMs) {
        return { allowed: false, reason: 'cooldown', runId: '' };
      }
    }
    const runId = crypto.randomUUID();
    inFlight.set(leaseKey, { runId, startedAt: nowMs });
    target.entry.lastTriggeredAt = nowMs;
    target.entry.lastError = '';
    save();
    return { allowed: true, reason: 'claimed', runId };
  };

  const completeTrigger = ({
    accountEmail = '',
    poolKey,
    runId = '',
    ok = false,
    modelLabel = '',
    error = '',
  }) => {
    const nowMs = nowFn();
    const target = ensurePoolEntry(accountEmail, poolKey);
    if (!target) return getState(accountEmail);
    const leaseKey = `${target.acctKey}|${target.pKey}`;
    const existingLease = inFlight.get(leaseKey);
    if (existingLease && runId && existingLease.runId === runId) {
      inFlight.delete(leaseKey);
    }
    if (modelLabel) {
      target.entry.lastModelLabel = String(modelLabel).trim();
    }
    if (ok) {
      target.entry.lastSucceededAt = nowMs;
      target.entry.lastError = '';
      target.entry.backoffUntil = 0;
    } else {
      target.entry.lastError = String(error || '唤醒发送失败').trim();
      target.entry.backoffUntil = nowMs + backoffMs;
    }
    save();
    return getState(accountEmail);
  };

  return {
    getState,
    setPoolEnabled,
    setPoolModel,
    claimTrigger,
    completeTrigger,
  };
}
