import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { ensureAntigravityRunning } from '../src/launcher.mjs';

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
