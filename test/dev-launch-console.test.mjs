import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { appendFile, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { claimConsole } from '../scripts/macos-dev-console-owner.mjs';
import { endDevConsoleOnFormalTakeover } from '../src/macos-dev-console.mjs';
import { acquireSingleInstance, closeSingleInstance, readSingleInstanceStatus } from '../src/single-instance.mjs';

const root = path.resolve(import.meta.dirname, '..');
const exec = promisify(execFile);
const psQuote = (value) => `'${value.replaceAll("'", "''")}'`;

async function useTempDir(t, prefix) {
  const dir = await mkdirTemp(prefix);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function mkdirTemp(prefix) {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function waitFor(fn, { timeoutMs = 10_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor timed out');
}

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

function observe(t, executable, args, options = {}) {
  const child = spawn(executable, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.stdin.end('\n');
      child.kill();
    }
    await done.catch(() => {});
  });
  return { child, done, output: () => output };
}

if (process.platform === 'win32') {
  test('Windows dev log reader handles incremental UTF-8 and truncation', async (t) => {
    const directory = await useTempDir(t, 'aq-dev-log-reader-');
    const logPath = path.join(directory, 'log.txt');
    const helper = path.join(root, 'scripts', 'dev-launch-log-reader.ps1');
    const script = `. ${psQuote(helper)}
$cursor = New-DevLogCursor ${psQuote(logPath)}
Read-DevLogCursor $cursor
$bytes = [Text.Encoding]::UTF8.GetBytes("中文")
[IO.File]::WriteAllBytes(${psQuote(logPath)}, $bytes[0..1])
Read-DevLogCursor $cursor
$file = [IO.File]::Open(${psQuote(logPath)}, 'Append', 'Write', 'ReadWrite')
$file.Write($bytes, 2, $bytes.Length - 2); $file.Dispose()
Read-DevLogCursor $cursor
Read-DevLogCursor $cursor
[IO.File]::WriteAllText(${psQuote(logPath)}, "X", (New-Object Text.UTF8Encoding $false))
Read-DevLogCursor $cursor`;
    const { stdout } = await exec('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ]);
    assert.equal(stdout, '中文X');
  });

  for (const code of [0, 7]) {
    test(`Windows dev console exits cleanly or follows logs when bootstrap exits ${code}`, async (t) => {
      const directory = await useTempDir(t, 'aq-dev-console-');
      const bootstrap = path.join(directory, 'fake bootstrap.ps1');
      const runtime = path.join(directory, 'injector.log');
      await writeFile(runtime, 'OLD-LAUNCH\n');
      await writeFile(
        bootstrap,
        `param([switch]$Console)\nWrite-Host 'BOOT-EARLY'\nStart-Sleep -Milliseconds 300\nAdd-Content -LiteralPath ${psQuote(runtime)} -Value 'RUNTIME-READY'\n[Console]::Error.WriteLine('BOOT-FINAL-ERROR')\nexit ${code}\n`
      );
      const run = observe(t, 'powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(root, 'scripts', 'dev-launch-console.ps1'),
        '-BootstrapPath',
        bootstrap,
        '-LogRoot',
        directory,
      ]);
      await waitFor(() => run.output().includes('BOOT-EARLY'), { timeoutMs: 15_000 });
      if (code) {
        assert.equal(await run.done, code);
      } else {
        await waitFor(() => run.output().includes('Startup preparation finished'), { timeoutMs: 15_000 });
        await appendFile(runtime, 'RUNTIME-AFTER-BOOTSTRAP\n');
        await waitFor(() => run.output().includes('RUNTIME-AFTER-BOOTSTRAP'), { timeoutMs: 15_000 });
        assert.equal(run.child.exitCode, null);
      }
      assert.match(run.output(), /RUNTIME-READY/);
      assert.doesNotMatch(run.output(), /OLD-LAUNCH/);
    });
  }
}

if (process.platform !== 'win32') {
  test('endDevConsoleOnFormalTakeover closes macOS dev console only when formal takes over dev', async (t) => {
    const directory = await useTempDir(t, 'aq-dev-console-takeover-');
    assert.equal(
      await endDevConsoleOnFormalTakeover({
        mode: 'dev',
        requestMode: 'formal',
        platform: 'darwin',
        logRoot: directory,
      }),
      false
    );

    let replaced = false;
    const errors = [];
    const owner = await claimConsole(directory, {
      onReplaced: () => {
        replaced = true;
      },
      onError: (err) => errors.push(err),
    });
    t.after(() => owner.close());

    const tokenPath = joinPath(directory, 'active-dev-console');
    const original = await readFile(tokenPath, 'utf8');
    for (const [mode, requestMode, platform] of [
      ['dev', 'dev', 'darwin'],
      ['formal', 'formal', 'darwin'],
      ['dev', 'formal', 'win32'],
      ['dev', 'formal', 'linux'],
    ]) {
      assert.equal(
        await endDevConsoleOnFormalTakeover({ mode, requestMode, platform, logRoot: directory }),
        false
      );
      assert.equal(await readFile(tokenPath, 'utf8'), original);
    }

    assert.equal(
      await endDevConsoleOnFormalTakeover({
        mode: 'dev',
        requestMode: 'formal',
        platform: 'darwin',
        logRoot: directory,
      }),
      true
    );
    await waitFor(() => replaced);
    assert.deepEqual(errors, []);
    assert.notEqual(await readFile(tokenPath, 'utf8'), original);
    assert.equal((await readdir(directory)).some((n) => n.endsWith('.tmp')), false);
  });

  test('启动开发版.command hands off console logs cleanly and exits on formal takeover', async (t) => {
    const directory = await useTempDir(t, 'aq-dev-formal-console-');
    await mkdir(path.join(directory, 'scripts'));
    await copyFile(path.join(root, '启动开发版.command'), path.join(directory, 'start.command'));
    for (const name of ['macos-dev-environment.sh', 'macos-dev-console-owner.mjs']) {
      await copyFile(path.join(root, 'scripts', name), path.join(directory, 'scripts', name));
    }

    const port = await getFreePort();
    const dev = await acquireSingleInstance({
      port,
      mode: 'dev',
      version: '0.1.0',
      explicitStart: true,
      getStatus: () => ({ phase: 'ready' }),
      onTakeover: async (req) => {
        const logRoot = path.join(directory, 'Library', 'Logs', 'Antigravity Quota Injector');
        await endDevConsoleOnFormalTakeover({
          mode: 'dev',
          requestMode: req.mode,
          platform: 'darwin',
          logRoot,
        });
        await closeSingleInstance(dev);
      },
    });
    t.after(() => closeSingleInstance(dev));

    await writeFile(
      path.join(directory, 'scripts', 'start-injector-macos.sh'),
      '#!/bin/bash\necho ISOLATED-DEV-REUSED\nexit 0\n',
      { mode: 0o755 }
    );

    const run = observe(t, 'bash', [path.join(directory, 'start.command')], {
      env: { ...process.env, HOME: directory, ANTIGRAVITY_QUOTA_INSTANCE_PORT: String(port) },
    });
    const logRoot = path.join(directory, 'Library', 'Logs', 'Antigravity Quota Injector');
    await waitFor(() => run.output().includes('Continuing to follow'), { timeoutMs: 15_000 });
    await waitFor(() =>
      readFile(path.join(logRoot, 'active-dev-console'), 'utf8').then(Boolean).catch(() => false)
    );

    const formal = await acquireSingleInstance({
      port,
      mode: 'formal',
      version: '0.1.0',
      explicitStart: true,
      getStatus: () => ({ phase: 'ready' }),
    });
    t.after(() => closeSingleInstance(formal));

    assert.ok(formal?.listening);
    assert.equal(await run.done, 0);
    assert.doesNotMatch(run.output(), /Press Enter to close|Development launcher failed/);
    assert.equal((await readSingleInstanceStatus({ port })).mode, 'formal');
  });
}

function joinPath(...parts) {
  return path.join(...parts);
}
