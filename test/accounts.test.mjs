import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  applyAccountSnapshot,
  clearCurrentAccountAuth,
  deleteAccount,
  deleteKeychainSecret,
  getAccountSwitchSupport,
  listAccounts,
  parseKeychainSecretMetadata,
  prepareNewAccountWithRestart,
  readKeychainSecret,
  reorderAccounts,
  sanitizeQuotaSnapshot,
  snapshotCurrentAccount,
  updateAccountQuotaSnapshot,
  writeKeychainSecret,
} from '../src/accounts.mjs';

function makeTempFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-accounts-test-'));
  const stateDir = path.join(root, 'state');
  const appSupportDir = path.join(root, 'Antigravity');
  const globalStorage = path.join(appSupportDir, 'User', 'globalStorage');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(globalStorage, { recursive: true });

  fs.writeFileSync(path.join(appSupportDir, 'credential-user-scope'), 'u1111aaaa', 'utf8');
  fs.writeFileSync(
    path.join(appSupportDir, 'app_storage.json'),
    JSON.stringify({
      keepMeKey: 'preserved-value',
      'agy.onboarding.lastLoginUsername': JSON.stringify('alice@example.com'),
      'agy.onboarding.lastLoginIsGcpTos': 'false',
    }),
    'utf8'
  );

  const dbPath = path.join(globalStorage, 'state.vscdb');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB);');
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
    'antigravityUnifiedStateSync.oauthToken',
    'token-alice'
  );
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
    'antigravity.profileUrl',
    'https://example.com/alice.png'
  );
  db.close();

  return {
    root,
    accountsFile: path.join(stateDir, 'accounts.json'),
    appSupportDir,
    dbPath,
  };
}

test('snapshotCurrentAccount, listAccounts, applyAccountSnapshot, and deleteAccount work cleanly', () => {
  const fx = makeTempFixture();
  let mockKeychain = 'secret-alice';

  const savedAlice = snapshotCurrentAccount({
    accountsFile: fx.accountsFile,
    appSupportDir: fx.appSupportDir,
    profile: { email: 'Alice@Example.com', name: 'Alice', planName: 'Pro' },
    readSecretFn: () => mockKeychain,
  });
  assert.equal(savedAlice.id, 'alice@example.com');

  const stat = fs.statSync(fx.accountsFile);
  if (process.platform !== 'win32') {
    assert.equal(stat.mode & 0o777, 0o600);
  }

  // Switch simulated active state to Bob and snapshot Bob
  mockKeychain = 'secret-bob';
  fs.writeFileSync(path.join(fx.appSupportDir, 'credential-user-scope'), 'u2222bbbb', 'utf8');
  fs.writeFileSync(
    path.join(fx.appSupportDir, 'app_storage.json'),
    JSON.stringify({
      keepMeKey: 'preserved-value',
      'agy.onboarding.lastLoginUsername': JSON.stringify('bob@example.com'),
      'agy.onboarding.lastLoginIsGcpTos': 'true',
    }),
    'utf8'
  );
  const db = new DatabaseSync(fx.dbPath);
  db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run(
    'antigravityUnifiedStateSync.oauthToken',
    'token-bob'
  );
  db.close();

  snapshotCurrentAccount({
    accountsFile: fx.accountsFile,
    appSupportDir: fx.appSupportDir,
    profile: { email: 'bob@example.com', name: 'Bob', planName: 'Ultra' },
    readSecretFn: () => mockKeychain,
  });

  // listAccounts must sanitize credentials
  const list = listAccounts(fx.accountsFile, 'bob@example.com');
  assert.equal(list.length, 2);
  assert.equal(list[0].active, false);
  assert.equal(list[1].active, true);
  assert.equal('keychainSecret' in list[0], false);
  assert.equal('vscdbAuth' in list[0], false);

  // Restore Alice snapshot
  let writtenSecret = '';
  applyAccountSnapshot({
    accountId: 'alice@example.com',
    accountsFile: fx.accountsFile,
    appSupportDir: fx.appSupportDir,
    writeSecretFn: (s) => {
      writtenSecret = s;
    },
  });
  assert.equal(writtenSecret, 'secret-alice');
  assert.equal(fs.readFileSync(path.join(fx.appSupportDir, 'credential-user-scope'), 'utf8'), 'u1111aaaa');
  const appStorageAfter = JSON.parse(
    fs.readFileSync(path.join(fx.appSupportDir, 'app_storage.json'), 'utf8')
  );
  assert.equal(appStorageAfter.keepMeKey, 'preserved-value');
  assert.equal(appStorageAfter['agy.onboarding.lastLoginUsername'], JSON.stringify('alice@example.com'));

  const dbAfter = new DatabaseSync(fx.dbPath, { readOnly: true });
  const tokRow = dbAfter
    .prepare('SELECT value FROM ItemTable WHERE key = ?')
    .get('antigravityUnifiedStateSync.oauthToken');
  dbAfter.close();
  assert.equal(tokRow.value, 'token-alice');

  assert.equal(deleteAccount(fx.accountsFile, 'bob@example.com'), true);
  assert.equal(listAccounts(fx.accountsFile).length, 1);

  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('getAccountSwitchSupport enables darwin and win32 and reports unsupported on other platforms', () => {
  assert.deepEqual(getAccountSwitchSupport('darwin'), { supported: true, reason: '' });
  assert.deepEqual(getAccountSwitchSupport('win32'), { supported: true, reason: '' });
  const linux = getAccountSwitchSupport('linux');
  assert.equal(linux.supported, false);
  assert.match(linux.reason, /暂不支持/);
});

test('Windows Credential Manager readKeychainSecret, writeKeychainSecret, and deleteKeychainSecret encode and decode payloads cleanly', () => {
  const sampleJson = JSON.stringify({
    token: { access_token: 'ya29.win', refresh_token: '1//win' },
    auth_method: 'consumer',
    id_token_email: 'winuser@example.com',
  });
  let storedB64 = '';

  const mockExec = (cmd, args) => {
    assert.equal(cmd, 'powershell.exe');
    const encIdx = args.indexOf('-EncodedCommand');
    assert.ok(encIdx >= 0);
    const decodedScript = Buffer.from(args[encIdx + 1], 'base64').toString('utf16le');
    if (decodedScript.includes('[AqWinCred]::WriteBase64')) {
      const m = decodedScript.match(
        /\[AqWinCred\]::WriteBase64\('([^']+)',\s*'([^']+)',\s*'([^']+)'\)/
      );
      assert.ok(m);
      assert.equal(m[1], 'gemini:antigravity');
      assert.equal(m[2], 'antigravity');
      storedB64 = m[3];
      return '';
    }
    if (decodedScript.includes('[AqWinCred]::ReadBase64')) {
      return `${storedB64}\r\n`;
    }
    if (decodedScript.includes('[AqWinCred]::Delete')) {
      if (storedB64) {
        storedB64 = '';
        return 'DELETED\r\n';
      }
      return 'NOT_FOUND\r\n';
    }
    return '';
  };

  // Supports both raw JSON and go-keyring-base64: prefixed secrets when writing on win32
  writeKeychainSecret(`go-keyring-base64:${Buffer.from(sampleJson, 'utf8').toString('base64')}`, {
    platform: 'win32',
    execFileSyncFn: mockExec,
  });
  assert.equal(Buffer.from(storedB64, 'base64').toString('utf8'), sampleJson);

  const readVal = readKeychainSecret({ platform: 'win32', execFileSyncFn: mockExec });
  assert.equal(readVal, sampleJson);

  assert.equal(deleteKeychainSecret({ platform: 'win32', execFileSyncFn: mockExec }), true);
  assert.equal(deleteKeychainSecret({ platform: 'win32', execFileSyncFn: mockExec }), false);
  assert.equal(readKeychainSecret({ platform: 'win32', execFileSyncFn: mockExec }), '');
});

test('parseKeychainSecretMetadata validates go-keyring-base64 StoredToken and rejects tokenless sign-out stubs', () => {
  const validPayload = Buffer.from(
    JSON.stringify({
      token: { access_token: 'ya29.test', refresh_token: '1//test' },
      auth_method: 'personal',
      id_token_email: 'carol@example.com',
    }),
    'utf8'
  ).toString('base64');
  assert.deepEqual(parseKeychainSecretMetadata(`go-keyring-base64:${validPayload}`), {
    usable: true,
    email: 'carol@example.com',
  });

  const signedOutStub = Buffer.from(
    JSON.stringify({
      auth_method: 'personal',
      writer_id: 'w1',
    }),
    'utf8'
  ).toString('base64');
  assert.equal(parseKeychainSecretMetadata(`go-keyring-base64:${signedOutStub}`).usable, false);
  assert.equal(parseKeychainSecretMetadata('').usable, false);
});

test('prepareNewAccountWithRestart snapshots active account, quits, clears auth, and relaunches cleanly even when already signed out', async () => {
  const fx = makeTempFixture();
  const events = [];
  let keychain = 'secret-alice';

  const saved = await prepareNewAccountWithRestart({
    accountsFile: fx.accountsFile,
    appSupportDir: fx.appSupportDir,
    channel: 'stable',
    platform: 'darwin',
    currentProfile: { email: 'alice@example.com', name: 'Alice', planName: 'Pro' },
    readSecretFn: () => {
      events.push('readSecret');
      return keychain;
    },
    quitFn: async () => {
      events.push('quit');
      return true;
    },
    deleteSecretFn: () => {
      events.push('deleteSecret');
      keychain = '';
      return true;
    },
    launchFn: () => {
      events.push('launch');
    },
    waitLaunchFn: async () => {
      events.push('waitLaunch');
      return true;
    },
  });

  assert.equal(saved?.email, 'alice@example.com');
  assert.deepEqual(events, ['readSecret', 'quit', 'deleteSecret', 'launch', 'waitLaunch']);
  assert.equal(keychain, '');
  assert.equal(fs.existsSync(path.join(fx.appSupportDir, 'credential-user-scope')), false);

  const appStorageAfter = JSON.parse(
    fs.readFileSync(path.join(fx.appSupportDir, 'app_storage.json'), 'utf8')
  );
  assert.equal(appStorageAfter.keepMeKey, 'preserved-value');
  assert.equal('agy.onboarding.lastLoginUsername' in appStorageAfter, false);
  assert.equal('agy.onboarding.lastLoginIsGcpTos' in appStorageAfter, false);

  const dbAfter = new DatabaseSync(fx.dbPath, { readOnly: true });
  const tokRow = dbAfter
    .prepare('SELECT value FROM ItemTable WHERE key = ?')
    .get('antigravityUnifiedStateSync.oauthToken');
  dbAfter.close();
  assert.equal(tokRow, undefined);

  // Calling prepareNewAccountWithRestart again when keychain is already empty must not throw
  let launchAttempts = 0;
  const savedWhenSignedOut = await prepareNewAccountWithRestart({
    accountsFile: fx.accountsFile,
    appSupportDir: fx.appSupportDir,
    channel: 'stable',
    platform: 'darwin',
    currentProfile: { email: 'alice@example.com' },
    readSecretFn: () => '',
    quitFn: async () => true,
    deleteSecretFn: () => false,
    launchFn: () => {
      launchAttempts += 1;
    },
    waitLaunchFn: async () => launchAttempts >= 2,
  });
  assert.equal(savedWhenSignedOut, null);
  assert.equal(launchAttempts, 2);
  assert.equal(listAccounts(fx.accountsFile).length, 1);

  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('applyAccountSnapshot removes stale credential-user-scope when target snapshot has no scope', () => {
  const fx = makeTempFixture();
  fs.unlinkSync(path.join(fx.appSupportDir, 'credential-user-scope'));
  snapshotCurrentAccount({
    accountsFile: fx.accountsFile,
    appSupportDir: fx.appSupportDir,
    profile: { email: 'noscope@example.com', name: 'NoScope', planName: 'Pro' },
    readSecretFn: () => 'secret-noscope',
  });

  // Simulate another account leaving a scope file, enterprise ToS key, and vscdb token behind
  const scopePath = path.join(fx.appSupportDir, 'credential-user-scope');
  fs.writeFileSync(scopePath, 'stale-scope', 'utf8');
  fs.writeFileSync(
    path.join(fx.appSupportDir, 'app_storage.json'),
    JSON.stringify({
      keepMeKey: 'preserved-value',
      'agy.onboarding.lastLoginUsername': JSON.stringify('enterprise@example.com'),
      'agy.onboarding.lastLoginIsGcpTos': 'true',
    }),
    'utf8'
  );
  // Strip vscdbAuth & lastLoginIsGcpTos from noscope snapshot to verify full managed-key alignment
  const storeRaw = JSON.parse(fs.readFileSync(fx.accountsFile, 'utf8'));
  delete storeRaw.accounts[0].appStorageAuth['agy.onboarding.lastLoginIsGcpTos'];
  storeRaw.accounts[0].vscdbAuth = {};
  fs.writeFileSync(fx.accountsFile, JSON.stringify(storeRaw), 'utf8');

  applyAccountSnapshot({
    accountId: 'noscope@example.com',
    accountsFile: fx.accountsFile,
    appSupportDir: fx.appSupportDir,
    writeSecretFn: () => {},
  });
  assert.equal(fs.existsSync(scopePath), false);
  const alignedAppStorage = JSON.parse(
    fs.readFileSync(path.join(fx.appSupportDir, 'app_storage.json'), 'utf8')
  );
  assert.equal(alignedAppStorage.keepMeKey, 'preserved-value');
  assert.equal('agy.onboarding.lastLoginIsGcpTos' in alignedAppStorage, false);
  const alignedDb = new DatabaseSync(fx.dbPath, { readOnly: true });
  const staleVscdbTok = alignedDb
    .prepare('SELECT value FROM ItemTable WHERE key = ?')
    .get('antigravityUnifiedStateSync.oauthToken');
  alignedDb.close();
  assert.equal(staleVscdbTok, undefined);

  clearCurrentAccountAuth({
    appSupportDir: fx.appSupportDir,
    deleteSecretFn: () => true,
  });
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('account quotaSnapshot persists cleanly via snapshotCurrentAccount and updateAccountQuotaSnapshot', () => {
  const fx = makeTempFixture();
  const initialQuota = {
    updatedAt: '2026-11-20T02:00:00.000Z',
    groups: [
      {
        displayName: 'Gemini Models',
        buckets: [
          {
            bucketId: 'gemini-5h',
            displayName: '5h',
            window: '5h',
            remainingFraction: 0.72,
            resetTime: '2026-11-20T05:00:00.000Z',
          },
          {
            bucketId: 'disabled-b',
            window: 'weekly',
            remainingFraction: 0.5,
            disabled: true,
          },
        ],
      },
    ],
  };

  assert.equal(sanitizeQuotaSnapshot({ groups: [] }), null);
  snapshotCurrentAccount({
    accountsFile: fx.accountsFile,
    appSupportDir: fx.appSupportDir,
    profile: { email: 'alice@example.com', name: 'Alice', planName: 'Pro' },
    quota: initialQuota,
    readSecretFn: () => 'secret-alice',
  });

  // Subsequent snapshot without quota must preserve existing quotaSnapshot
  snapshotCurrentAccount({
    accountsFile: fx.accountsFile,
    appSupportDir: fx.appSupportDir,
    profile: { email: 'alice@example.com', name: 'Alice', planName: 'Pro' },
    readSecretFn: () => 'secret-alice',
  });

  let listed = listAccounts(fx.accountsFile, 'alice@example.com');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].quotaSnapshot?.groups.length, 1);
  assert.equal(listed[0].quotaSnapshot?.groups[0].buckets.length, 1);
  assert.equal(listed[0].quotaSnapshot?.groups[0].buckets[0].remainingFraction, 0.72);

  // Identical quota within 60s skips redundant disk write
  const noopRes = updateAccountQuotaSnapshot({
    accountsFile: fx.accountsFile,
    email: 'alice@example.com',
    quota: {
      updatedAt: '2026-11-20T02:00:20.000Z',
      groups: initialQuota.groups,
    },
  });
  assert.equal(noopRes.updated, false);

  // Changed remainingFraction persists immediately
  const updatedRes = updateAccountQuotaSnapshot({
    accountsFile: fx.accountsFile,
    email: 'alice@example.com',
    quota: {
      updatedAt: '2026-11-20T02:00:30.000Z',
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            {
              bucketId: 'gemini-5h',
              window: '5h',
              remainingFraction: 0.45,
              resetTime: '2026-11-20T05:00:00.000Z',
            },
          ],
        },
      ],
    },
  });
  assert.equal(updatedRes.updated, true);
  assert.equal(updatedRes.changed, true);

  listed = listAccounts(fx.accountsFile, 'other@example.com');
  assert.equal(listed[0].active, false);
  assert.equal(listed[0].quotaSnapshot?.groups[0].buckets[0].remainingFraction, 0.45);
  assert.equal('keychainSecret' in listed[0], false);

  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('reorderAccounts persists custom account order and preserves unmentioned accounts', () => {
  const fx = makeTempFixture();
  for (const email of ['alice@example.com', 'bob@example.com', 'carol@example.com']) {
    snapshotCurrentAccount({
      accountsFile: fx.accountsFile,
      appSupportDir: fx.appSupportDir,
      profile: { email, name: email.split('@')[0], planName: 'Pro' },
      readSecretFn: () => `secret-${email}`,
    });
  }

  assert.deepEqual(
    listAccounts(fx.accountsFile).map((a) => a.id),
    ['alice@example.com', 'bob@example.com', 'carol@example.com']
  );

  assert.deepEqual(
    reorderAccounts(fx.accountsFile, ['carol@example.com', 'alice@example.com', 'bob@example.com']),
    { changed: true }
  );
  assert.deepEqual(
    listAccounts(fx.accountsFile).map((a) => a.id),
    ['carol@example.com', 'alice@example.com', 'bob@example.com']
  );

  // Same order is a no-op
  assert.deepEqual(
    reorderAccounts(fx.accountsFile, ['carol@example.com', 'alice@example.com', 'bob@example.com']),
    { changed: false }
  );

  // Partial list moves mentioned accounts first and appends unmentioned ones in original relative order
  assert.deepEqual(reorderAccounts(fx.accountsFile, ['bob@example.com']), { changed: true });
  assert.deepEqual(
    listAccounts(fx.accountsFile).map((a) => a.id),
    ['bob@example.com', 'carol@example.com', 'alice@example.com']
  );

  fs.rmSync(fx.root, { recursive: true, force: true });
});
