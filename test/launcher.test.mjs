import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ensureAntigravityRunning,
  launchDetachedMacLauncher,
  shouldDetachMacDevLauncher,
} from '../src/launcher.mjs';

function makePaths(root = '/tmp/aq-launcher-test') {
  return {
    portFile: path.join(root, 'DevToolsActivePort'),
    stateDir: path.join(root, 'state'),
  };
}

test('ensureAntigravityRunning attaches directly when running with live CDP or remote-debugging flag', async () => {
  const paths = makePaths();
  let quitCalled = false;
  let launchCalled = false;

  const liveRes = await ensureAntigravityRunning(paths, {}, {
    isProcessRunningFn: () => true,
    readDebugPortFn: () => 51686,
    fetchCdpTargetsFn: async () => [{ type: 'page', url: 'https://127.0.0.1:51688/c/abc', webSocketDebuggerUrl: 'ws://127.0.0.1:51686/devtools/page/1' }],
    hasRemoteDebuggingFlagFn: () => false,
    quitAntigravityFn: async () => {
      quitCalled = true;
      return true;
    },
    launchExecutableFn: () => {
      launchCalled = true;
      return { launched: true, exePath: '/Applications/Antigravity.app', source: 'standard' };
    },
    log: () => {},
    warn: () => {},
  });
  assert.deepEqual(liveRes, { ok: true, launched: false, restarted: false, injectable: true });
  assert.equal(quitCalled, false);
  assert.equal(launchCalled, false);

  // Even before DevToolsActivePort responds, --remote-debugging-port on the running process skips restart
  const bootingRes = await ensureAntigravityRunning(paths, {}, {
    isProcessRunningFn: () => true,
    readDebugPortFn: () => null,
    fetchCdpTargetsFn: async () => [],
    hasRemoteDebuggingFlagFn: () => true,
    quitAntigravityFn: async () => {
      quitCalled = true;
      return true;
    },
    launchExecutableFn: () => {
      launchCalled = true;
      return { launched: true, exePath: '/Applications/Antigravity.app', source: 'standard' };
    },
    log: () => {},
    warn: () => {},
  });
  assert.deepEqual(bootingRes, { ok: true, launched: false, restarted: false, injectable: true });
  assert.equal(quitCalled, false);
  assert.equal(launchCalled, false);
});

test('ensureAntigravityRunning automatically restarts Antigravity when running without CDP injection support', async () => {
  const paths = makePaths();
  const events = [];
  let processRunning = true;
  let portFilePresent = true;

  const res = await ensureAntigravityRunning(paths, {}, {
    setRestartInFlight: (flag) => events.push(`restartInFlight:${flag}`),
    isProcessRunningFn: () => processRunning,
    readDebugPortFn: () => (portFilePresent ? 59999 : null),
    fetchCdpTargetsFn: async () => [],
    hasRemoteDebuggingFlagFn: () => false,
    resolveExecutableFn: () => ({ exePath: '/Applications/Antigravity.app', source: 'standard' }),
    existsSyncFn: (p) => p === paths.portFile && portFilePresent,
    unlinkSyncFn: (p) => {
      if (p === paths.portFile) {
        portFilePresent = false;
        events.push('unlinkStalePort');
      }
    },
    quitAntigravityFn: async () => {
      events.push('quit');
      processRunning = false;
      return true;
    },
    launchExecutableFn: () => {
      events.push('launch');
      processRunning = true;
      return { launched: true, exePath: '/Applications/Antigravity.app', source: 'standard' };
    },
    sleepFn: async () => {},
    log: () => {},
    warn: () => {},
  });

  assert.deepEqual(res, {
    ok: true,
    launched: true,
    restarted: true,
    injectable: true,
    exePath: '/Applications/Antigravity.app',
  });
  assert.deepEqual(events, [
    'restartInFlight:true',
    'quit',
    'unlinkStalePort',
    'launch',
    'restartInFlight:false',
  ]);
});

test('ensureAntigravityRunning avoids killing Antigravity if executable is missing or quit times out', async () => {
  const paths = makePaths();
  let quitCalled = false;
  let launchCalled = false;
  const inflight = [];

  const unknownFlagRes = await ensureAntigravityRunning(paths, {}, {
    setRestartInFlight: (flag) => inflight.push(flag),
    isProcessRunningFn: () => true,
    readDebugPortFn: () => null,
    fetchCdpTargetsFn: async () => [],
    inspectRemoteDebuggingFn: () => 'unknown',
    resolveExecutableFn: () => ({ exePath: '/Applications/Antigravity.app', source: 'standard' }),
    quitAntigravityFn: async () => {
      quitCalled = true;
      return true;
    },
    launchExecutableFn: () => {
      launchCalled = true;
      return { launched: true, exePath: '/Applications/Antigravity.app', source: 'standard' };
    },
    sleepFn: async () => {},
    log: () => {},
    warn: () => {},
  });
  assert.equal(unknownFlagRes.reason, 'unknown_debug_flag');
  assert.equal(quitCalled, false);
  assert.equal(launchCalled, false);

  const missingExeRes = await ensureAntigravityRunning(paths, {}, {
    setRestartInFlight: (flag) => inflight.push(flag),
    isProcessRunningFn: () => true,
    readDebugPortFn: () => null,
    fetchCdpTargetsFn: async () => [],
    hasRemoteDebuggingFlagFn: () => false,
    resolveExecutableFn: () => ({ exePath: '', source: '' }),
    quitAntigravityFn: async () => {
      quitCalled = true;
      return true;
    },
    launchExecutableFn: () => {
      launchCalled = true;
      return { launched: true, exePath: 'x', source: 'standard' };
    },
    sleepFn: async () => {},
    log: () => {},
    warn: () => {},
  });
  assert.equal(missingExeRes.reason, 'missing_executable');
  assert.equal(quitCalled, false);
  assert.equal(launchCalled, false);

  const timeoutRes = await ensureAntigravityRunning(paths, {}, {
    setRestartInFlight: (flag) => inflight.push(flag),
    isProcessRunningFn: () => true,
    readDebugPortFn: () => null,
    fetchCdpTargetsFn: async () => [],
    hasRemoteDebuggingFlagFn: () => false,
    resolveExecutableFn: () => ({ exePath: '/Applications/Antigravity.app', source: 'standard' }),
    quitAntigravityFn: async () => {
      quitCalled = true;
      return false;
    },
    launchExecutableFn: () => {
      launchCalled = true;
      return { launched: true, exePath: '/Applications/Antigravity.app', source: 'standard' };
    },
    sleepFn: async () => {},
    log: () => {},
    warn: () => {},
  });
  assert.equal(timeoutRes.reason, 'quit_timeout');
  assert.equal(quitCalled, true);
  assert.equal(launchCalled, false);
  assert.deepEqual(inflight, [true, false]);
});

test('shouldDetachMacDevLauncher enables detachment only for interactive macOS dev runs', () => {
  assert.equal(
    shouldDetachMacDevLauncher({
      platform: 'darwin',
      sea: false,
      explicitStart: true,
      once: false,
      argv: ['node', 'launcher.mjs', '--explicit-start'],
      env: {},
    }),
    true
  );
  assert.equal(
    shouldDetachMacDevLauncher({
      platform: 'darwin',
      sea: false,
      explicitStart: true,
      once: false,
      argv: ['node', 'launcher.mjs', '--explicit-start'],
      env: { AQ_DETACHED_CHILD: '1' },
    }),
    false
  );
  assert.equal(
    shouldDetachMacDevLauncher({
      platform: 'darwin',
      sea: false,
      explicitStart: true,
      once: true,
      argv: ['--explicit-start', '--once'],
      env: {},
    }),
    false
  );
  assert.equal(
    shouldDetachMacDevLauncher({
      platform: 'darwin',
      sea: false,
      explicitStart: true,
      once: false,
      argv: ['--explicit-start', '--foreground'],
      env: {},
    }),
    false
  );
  assert.equal(
    shouldDetachMacDevLauncher({
      platform: 'darwin',
      sea: true,
      explicitStart: true,
      once: false,
      argv: [],
      env: {},
    }),
    false
  );
  assert.equal(
    shouldDetachMacDevLauncher({
      platform: 'win32',
      sea: false,
      explicitStart: true,
      once: false,
      argv: ['--explicit-start'],
      env: {},
    }),
    false
  );
});

test('launchDetachedMacLauncher detaches stdio/session, forwards ready logs, and cleans temp state', async () => {
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-detach-unit-'));
  const logPath = path.join(scratchRoot, 'injector.log');
  fs.writeFileSync(logPath, '[2026-11-21T00:00:00.000Z] [INFO] old-line\n', 'utf8');

  let spawnCall = null;
  let unrefCalled = false;
  let createdDir = '';
  const logs = [];
  const errors = [];

  try {
    const code = await launchDetachedMacLauncher({
      entrypointPath: '/repo/src/launcher.mjs',
      argv: ['--explicit-start'],
      env: { PATH: '/usr/bin' },
      logPath,
      mkdtempSyncFn: (prefix) => {
        createdDir = fs.mkdtempSync(prefix);
        return createdDir;
      },
      spawnFn: (execPath, args, opts) => {
        spawnCall = { execPath, args, opts };
        setTimeout(() => {
          fs.appendFileSync(
            logPath,
            '[2026-11-21T00:00:01.000Z] [INFO] [launcher] 已启动 (dev v0.1.54)\n',
            'utf8'
          );
          fs.writeFileSync(
            opts.env.AQ_LAUNCH_STATUS_FILE,
            JSON.stringify({ ok: true, phase: 'ready', exitCode: 0 }),
            'utf8'
          );
        }, 20);
        return {
          once: () => {},
          unref: () => {
            unrefCalled = true;
          },
        };
      },
      sleepFn: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 15))),
      log: (line) => logs.push(line),
      error: (line) => errors.push(line),
    });

    assert.equal(code, 0);
    assert.equal(unrefCalled, true);
    assert.equal(spawnCall.opts.detached, true);
    assert.deepEqual(spawnCall.opts.stdio, ['ignore', 'ignore', 'ignore']);
    assert.equal(spawnCall.opts.env.AQ_DETACHED_CHILD, '1');
    assert.deepEqual(logs, ['[launcher] 已启动 (dev v0.1.54)']);
    assert.deepEqual(errors, []);
    assert.equal(fs.existsSync(createdDir), false);

    // Failures written to statusFile propagate non-zero exit code without echoing logs under EXTERNAL_START
    const failLogs = [];
    const failErrors = [];
    const failCode = await launchDetachedMacLauncher({
      entrypointPath: '/repo/src/launcher.mjs',
      argv: ['--explicit-start'],
      env: { ANTIGRAVITY_QUOTA_DEV_EXTERNAL_START: '1' },
      logPath,
      spawnFn: (_execPath, _args, opts) => {
        setTimeout(() => {
          fs.appendFileSync(logPath, '[2026-11-21T00:00:02.000Z] [INFO] duplicate-skip\n', 'utf8');
          fs.writeFileSync(
            opts.env.AQ_LAUNCH_STATUS_FILE,
            JSON.stringify({ ok: false, phase: 'failed', exitCode: 1, reason: 'takeover denied' }),
            'utf8'
          );
        }, 20);
        return { once: () => {}, unref: () => {} };
      },
      sleepFn: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 15))),
      log: (line) => failLogs.push(line),
      error: (line) => failErrors.push(line),
    });
    assert.equal(failCode, 1);
    assert.deepEqual(failLogs, []);
    assert.deepEqual(failErrors, ['[launcher] takeover denied']);
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
});
