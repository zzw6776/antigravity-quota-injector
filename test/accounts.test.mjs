import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  applyAccountSnapshot,
  deleteAccount,
  getAccountSwitchSupport,
  listAccounts,
  snapshotCurrentAccount,
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

test('getAccountSwitchSupport enables darwin and reports Windows unsupported message', () => {
  assert.deepEqual(getAccountSwitchSupport('darwin'), { supported: true, reason: '' });
  const win = getAccountSwitchSupport('win32');
  assert.equal(win.supported, false);
  assert.match(win.reason, /Windows/);
});
