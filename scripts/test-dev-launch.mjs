#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { endDevConsoleOnFormalTakeover } from '../src/macos-dev-console.mjs';
import { createFollowAppController } from '../src/platform.mjs';
import {
  acquireSingleInstance,
  closeSingleInstance,
  readSingleInstanceStatus,
} from '../src/single-instance.mjs';

const root = path.resolve(import.meta.dirname, '..');
const liveMode = process.argv.includes('--live');

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function runIsolatedDevTakeoverCheck() {
  const port = await getFreePort();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aq-dev-launch-test-'));
  const logRoot = path.join(tmpRoot, 'logs');
  await fs.mkdir(logRoot, { recursive: true });
  await fs.writeFile(path.join(logRoot, 'active-dev-console'), 'dev-token-1', 'utf8');

  let formalTakenOver = false;
  const formal = await acquireSingleInstance({
    port,
    mode: 'formal',
    version: '0.1.0',
    explicitStart: true,
    getStatus: () => ({ phase: 'ready' }),
    onTakeover: async () => {
      formalTakenOver = true;
      await closeSingleInstance(formal);
    },
  });

  // 1. Local dev startup automatically replaces running formal version
  let devTakenOverByFormal = false;
  const dev = await acquireSingleInstance({
    port,
    mode: 'dev',
    version: '0.1.0',
    explicitStart: true,
    runtimeIdentity: 'a'.repeat(64),
    getStatus: () => ({ phase: 'ready' }),
    onTakeover: async (req) => {
      devTakenOverByFormal = true;
      await endDevConsoleOnFormalTakeover({
        mode: 'dev',
        requestMode: req.mode,
        platform: 'darwin',
        logRoot,
      });
      await closeSingleInstance(dev);
    },
  });

  try {
    assert.equal(formalTakenOver, true, '开发版启动后应自动接管并替换运行中的正式版');
    assert.ok(dev?.listening, '开发版应成功接管单实例端口');
    assert.equal((await readSingleInstanceStatus({ port })).mode, 'dev');

    // 2. Formal launch takes back over from dev and closes dev console on macOS
    const formal2 = await acquireSingleInstance({
      port,
      mode: 'formal',
      version: '0.1.0',
      explicitStart: true,
      getStatus: () => ({ phase: 'ready' }),
    });
    try {
      assert.equal(devTakenOverByFormal, true, '正式版再次启动应能接管开发版');
      assert.ok(formal2?.listening);
      assert.equal((await readSingleInstanceStatus({ port })).mode, 'formal');
      const consoleToken = await fs.readFile(path.join(logRoot, 'active-dev-console'), 'utf8');
      assert.match(consoleToken, /^formal-/, '正式版接管开发版后应更新 active-dev-console 通知');
    } finally {
      await closeSingleInstance(formal2);
    }

    // 3. Follow-app controller exits after main app closes
    const ctrl = createFollowAppController({
      startupGraceMs: 10_000,
      exitConfirmTicks: 3,
      nowFn: () => 0,
    });
    assert.equal(ctrl.update({ hasAttachedTargets: true }).shouldExit, false);
    assert.equal(ctrl.update({}).shouldExit, false);
    assert.equal(ctrl.update({}).shouldExit, false);
    assert.deepEqual(ctrl.update({}), {
      shouldExit: true,
      reason: 'app-closed',
      seenAppAlive: true,
      absentTicks: 3,
    });
  } finally {
    await closeSingleInstance(dev).catch(() => {});
    await closeSingleInstance(formal).catch(() => {});
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

async function runLiveOnceCheck() {
  const child = spawn(
    process.execPath,
    [path.join(root, 'src', 'launcher.mjs'), '--explicit-start', '--once'],
    {
      cwd: root,
      stdio: 'inherit',
    }
  );
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 0, 'launcher --explicit-start --once 应返回 0');
}

await runIsolatedDevTakeoverCheck();
console.log('✓ 开发版自动替换正式版 / 正式版接管开发版 / 主应用退出跟随 验证通过');
if (liveMode) {
  await runLiveOnceCheck();
  console.log('✓ 实机 launcher --explicit-start --once 验证通过');
}
