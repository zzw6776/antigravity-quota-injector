import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { downloadUpdate } from '../src/app-update/download.mjs';
import {
  buildWindowsUpdateHelperScript,
  resolveInstalledAppPath,
  verifyWindowsInstallerPE,
} from '../src/app-update/install.mjs';
import { createUpdateManager } from '../src/app-update/manager.mjs';
import { releaseUpdate } from '../src/app-update/releases.mjs';

function makeRelease(version, assets) {
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    body: `# ${version}\n\n- 更新内容`,
    assets,
  };
}

function makeAsset(name, sha256, size = 1024) {
  return {
    id: 100,
    name,
    state: 'uploaded',
    size,
    digest: `sha256:${sha256}`,
    browser_download_url: `https://github.com/zzw6776/antigravity-quota-injector/releases/download/v0.2.0/${name}`,
  };
}

test('releaseUpdate matches macOS arm64/x64 DMG and Windows x64 Setup and ignores older versions', () => {
  const hash = 'a'.repeat(64);
  const rel = makeRelease('0.2.0', [
    makeAsset('Antigravity-Quota-Injector-0.2.0-macos-arm64.dmg', hash, 2048),
    makeAsset('Antigravity-Quota-Injector-0.2.0-macos-x64.dmg', hash, 2048),
    makeAsset('Antigravity-Quota-Injector-0.2.0-windows-x64-Setup.exe', hash, 4096),
  ]);

  const macArm = releaseUpdate(rel, { version: '0.1.0', platform: 'darwin', arch: 'arm64' });
  assert.equal(macArm.name, 'Antigravity-Quota-Injector-0.2.0-macos-arm64.dmg');
  assert.equal(macArm.sha256, hash);

  const winX64 = releaseUpdate(rel, { version: '0.1.0', platform: 'win32', arch: 'x64' });
  assert.equal(winX64.name, 'Antigravity-Quota-Injector-0.2.0-windows-x64-Setup.exe');

  assert.equal(releaseUpdate(rel, { version: '0.2.0', platform: 'win32', arch: 'x64' }), null);
});

test('downloadUpdate verifies SHA-256 and rejects corrupted payloads', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aq-dl-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  const bytes = Buffer.from('hello-antigravity-release');
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const dest = path.join(tmp, 'pkg.exe');

  await downloadUpdate(
    {
      url: 'https://github.com/zzw6776/antigravity-quota-injector/releases/download/v0.2.0/pkg.exe',
      size: bytes.length,
      sha256: sha,
    },
    dest,
    {
      fetchImpl: async () =>
        new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } }),
    }
  );
  assert.deepEqual(await fs.readFile(dest), bytes);

  await assert.rejects(
    downloadUpdate(
      {
        url: 'https://github.com/zzw6776/antigravity-quota-injector/releases/download/v0.2.0/pkg.exe',
        size: bytes.length,
        sha256: 'b'.repeat(64),
      },
      path.join(tmp, 'bad.exe'),
      {
        fetchImpl: async () => new Response(bytes, { status: 200 }),
      }
    ),
    /SHA-256/
  );
});

test('createUpdateManager auto-checks and pre-downloads in formal mode, then replaces self on installUpdate without touching Antigravity', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aq-upd-mgr-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  const payload = Buffer.alloc(160, 0);
  payload.write('MZ', 0, 'ascii');
  payload.writeUInt32LE(0x40, 0x3c);
  payload.write('PE\0\0', 0x40, 'ascii');
  payload.writeUInt16LE(0x8664, 0x44);
  const sha = crypto.createHash('sha256').update(payload).digest('hex');
  const rel = makeRelease('0.2.0', [
    makeAsset('Antigravity-Quota-Injector-0.2.0-windows-x64-Setup.exe', sha, payload.length),
  ]);

  let applied = false;
  const states = [];
  const mgr = createUpdateManager({
    version: '0.1.0',
    mode: 'formal',
    platform: 'win32',
    arch: 'x64',
    dataDir: tmp,
    installedApp: 'C:\\Users\\Alice\\AppData\\Local\\Programs\\Antigravity Quota Injector',
    onStateChange: (s) => states.push(s.status),
    fetchReleaseImpl: async () => ({ release: rel, releases: [rel], etag: '"e1"' }),
    downloadImpl: async (asset, dest, { onProgress }) => {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, payload);
      onProgress(asset.size, asset.size);
      return dest;
    },
    prepareImpl: async ({ downloadPath }) => {
      await verifyWindowsInstallerPE(downloadPath);
      return { installer: downloadPath };
    },
    applyImpl: async ({ installedApp, prepared }) => {
      applied = true;
      assert.ok(installedApp.includes('Antigravity Quota Injector'));
      assert.ok(prepared.installer.endsWith('Setup.exe'));
    },
  });

  await mgr.checkNow({ manual: true });
  for (let i = 0; i < 30 && mgr.getState().status !== 'ready'; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(mgr.getState().status, 'ready');
  assert.equal(mgr.getState().latestVersion, '0.2.0');

  await mgr.installUpdate();
  assert.equal(mgr.getState().error, '');
  assert.equal(applied, true);
  assert.ok(states.includes('installing'));
});

test('resolveInstalledAppPath and Windows update helper script handle bundle/exe paths safely', () => {
  const macApp = resolveInstalledAppPath({
    platform: 'darwin',
    execPath:
      '/Applications/Antigravity Quota Injector.app/Contents/Resources/Antigravity Quota Injector Worker',
    existsSyncFn: (p) => p.endsWith('Info.plist'),
    readFileSyncFn: () => '<string>com.zzw6776.antigravity-quota-injector</string>',
  });
  assert.equal(macApp, '/Applications/Antigravity Quota Injector.app');

  const winDir = resolveInstalledAppPath({
    platform: 'win32',
    execPath:
      'C:\\Users\\Alice\\AppData\\Local\\Programs\\Antigravity Quota Injector\\Antigravity Quota Injector.exe',
    existsSyncFn: () => true,
  });
  assert.equal(winDir, 'C:\\Users\\Alice\\AppData\\Local\\Programs\\Antigravity Quota Injector');

  const ps = buildWindowsUpdateHelperScript();
  assert.match(ps, /Start-Process -FilePath \$SetupExe/);
  assert.match(ps, /\/S/);
  assert.doesNotMatch(ps, /Antigravity\.exe/);
});
