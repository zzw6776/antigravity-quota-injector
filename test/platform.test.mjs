import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildWindowsInstallShortcutsScript,
  buildWindowsRemoveShortcutsScript,
  createFollowAppController,
  encodePowerShellCommand,
  findRunningAntigravityPids,
  hasAntigravityRemoteDebuggingFlag,
  inspectAntigravityRemoteDebugging,
  installWindowsAppEntry,
  isNodeVersionSupported,
  launchAntigravityExecutable,
  matchesQuotaInjectorCommand,
  parseWindowsTasklistCsv,
  quitAndWaitAntigravityProcesses,
  resolveAntigravityExecutable,
  uninstallWindowsAppEntry,
} from '../src/platform.mjs';

test('isNodeVersionSupported enforces >= 22.13.0', () => {
  assert.equal(isNodeVersionSupported('v22.13.0'), true);
  assert.equal(isNodeVersionSupported('v22.14.1'), true);
  assert.equal(isNodeVersionSupported('v24.0.0'), true);
  assert.equal(isNodeVersionSupported('v22.12.9'), false);
  assert.equal(isNodeVersionSupported('v20.18.0'), false);
});

test('resolveAntigravityExecutable locates Windows exe via env, config, standard dirs, and PATH', () => {
  const customExe = 'D:\\Custom\\Antigravity\\Antigravity.exe';
  const stdExe = 'C:\\Users\\Alice\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe';
  const pathExe = 'E:\\Portable\\Antigravity\\Antigravity.exe';

  const envMatch = resolveAntigravityExecutable({
    platform: 'win32',
    env: { ANTIGRAVITY_EXE: customExe, LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local' },
    existsSyncFn: (p) => p === customExe || p === stdExe,
  });
  assert.deepEqual(envMatch, { exePath: customExe, source: 'env' });

  const cfgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-win-cfg-'));
  fs.writeFileSync(path.join(cfgRoot, 'config.json'), JSON.stringify({ antigravityExe: customExe }), 'utf8');
  const cfgMatch = resolveAntigravityExecutable({
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local' },
    stateDir: cfgRoot,
    existsSyncFn: (p) => p === path.join(cfgRoot, 'config.json') || p === customExe || p === stdExe,
  });
  assert.deepEqual(cfgMatch, { exePath: customExe, source: 'config' });
  fs.rmSync(cfgRoot, { recursive: true, force: true });

  const stdMatch = resolveAntigravityExecutable({
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local' },
    existsSyncFn: (p) => p === stdExe,
  });
  assert.deepEqual(stdMatch, { exePath: stdExe, source: 'standard' });

  const pathMatch = resolveAntigravityExecutable({
    platform: 'win32',
    env: { PATH: 'C:\\Windows\\System32;"E:\\Portable\\Antigravity"' },
    existsSyncFn: (p) => p === pathExe,
  });
  assert.deepEqual(pathMatch, { exePath: pathExe, source: 'path' });
});

test('parseWindowsTasklistCsv parses matching image names and ignores non-matching lines', () => {
  const csv = [
    '"Antigravity.exe","1234","Console","1","120,000 K"',
    '"antigravity.exe","5678","Console","1","80,000 K"',
    '"node.exe","999","Console","1","20,000 K"',
    'INFO: No tasks are running which match the specified criteria.',
  ].join('\r\n');
  assert.deepEqual(parseWindowsTasklistCsv(csv, ['Antigravity.exe']), [1234, 5678]);
  assert.deepEqual(parseWindowsTasklistCsv('INFO: No tasks...', ['Antigravity.exe']), []);
});

test('createFollowAppController waits for startup grace, resets on activity, and exits after app closes', () => {
  let now = 1000;
  const ctrl = createFollowAppController({
    startupGraceMs: 10_000,
    exitConfirmTicks: 3,
    nowFn: () => now,
  });

  // Before startup grace expires and before app seen alive
  now = 5000;
  assert.equal(ctrl.update({ hasAttachedTargets: false, hasLiveCdpTargets: false, isProcessAlive: false }).shouldExit, false);

  // App launches
  now = 6000;
  assert.equal(ctrl.update({ isProcessAlive: true }).shouldExit, false);
  assert.equal(ctrl.getState().seenAppAlive, true);

  // One absent tick resets when app reappears
  assert.equal(ctrl.update({}).absentTicks, 1);
  assert.equal(ctrl.update({ hasAttachedTargets: true }).absentTicks, 0);

  // App closes -> exits on 3rd consecutive absent tick
  assert.equal(ctrl.update({}).shouldExit, false);
  assert.equal(ctrl.update({}).shouldExit, false);
  const finalDecision = ctrl.update({});
  assert.equal(finalDecision.shouldExit, true);
  assert.equal(finalDecision.reason, 'app-closed');

  // Timeout before app ever launches
  let t2 = 0;
  const timeoutCtrl = createFollowAppController({
    startupGraceMs: 5000,
    exitConfirmTicks: 3,
    nowFn: () => t2,
  });
  t2 = 5000;
  const timeoutDecision = timeoutCtrl.update({});
  assert.equal(timeoutDecision.shouldExit, true);
  assert.equal(timeoutDecision.reason, 'startup-timeout');
});

test('Windows shortcut scripts create Desktop & Programs entries only (never Startup) and escape quotes', () => {
  const installScript = buildWindowsInstallShortcutsScript({
    vbsPath: "C:\\Users\\O'Brien\\antigravity-quota-injector\\windows\\launch.vbs",
    workingDir: "C:\\Users\\O'Brien\\antigravity-quota-injector",
    iconLocation: 'C:\\Program Files\\Antigravity\\Antigravity.exe,0',
  });
  assert.match(installScript, /GetFolderPath\('Desktop'\)/);
  assert.match(installScript, /GetFolderPath\('Programs'\)/);
  assert.doesNotMatch(installScript, /Startup/i);
  assert.match(installScript, /O''Brien/);
  assert.match(installScript, /wscript\.exe/);
  assert.match(installScript, /\$sc\.WindowStyle = 1/);

  const removeScript = buildWindowsRemoveShortcutsScript();
  assert.match(removeScript, /GetFolderPath\('Desktop'\)/);
  assert.match(removeScript, /GetFolderPath\('Programs'\)/);
  assert.doesNotMatch(removeScript, /Startup/i);
});

test('installWindowsAppEntry and uninstallWindowsAppEntry manage node-path.txt and invoke PowerShell cleanly', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-win-entry-'));
  const stateDir = path.join(tmp, 'state');
  const calls = [];

  const installRes = installWindowsAppEntry({
    projectRoot: 'C:\\Tools\\antigravity-quota-injector',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    stateDir,
    spawnSyncFn: (exe, args) => {
      calls.push({ exe, args });
      return {
        status: 0,
        stdout: 'C:\\Users\\Alice\\Desktop\\Antigravity Quota.lnk\r\nC:\\Users\\Alice\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Antigravity Quota.lnk\r\n',
        stderr: '',
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].exe, 'powershell.exe');
  assert.equal(fs.readFileSync(path.join(stateDir, 'node-path.txt'), 'utf8').trim(), 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(installRes.shortcuts.length, 2);

  const uninstallRes = uninstallWindowsAppEntry({
    stateDir,
    spawnSyncFn: (exe, args) => {
      calls.push({ exe, args });
      return {
        status: 0,
        stdout: 'C:\\Users\\Alice\\Desktop\\Antigravity Quota.lnk\r\n',
        stderr: '',
      };
    },
  });
  assert.equal(uninstallRes.removed.length, 1);
  assert.equal(fs.existsSync(path.join(stateDir, 'node-path.txt')), false);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('launchAntigravityExecutable passes --remote-debugging-port=0 on win32 & darwin and returns helpful reason when missing', () => {
  const missing = launchAntigravityExecutable({
    platform: 'win32',
    env: {},
    existsSyncFn: () => false,
  });
  assert.equal(missing.launched, false);
  assert.match(missing.reason, /Antigravity\.exe/);

  const exe = 'C:\\Users\\Alice\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe';
  let invokedArgs = null;
  const ok = launchAntigravityExecutable({
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local' },
    existsSyncFn: (p) => p === exe,
    spawnSyncFn: (cmd, args) => {
      invokedArgs = { cmd, args };
      return { status: 0 };
    },
  });
  assert.equal(ok.launched, true);
  assert.equal(ok.exePath, exe);
  assert.equal(invokedArgs.cmd, 'powershell.exe');
  const encodedIdx = invokedArgs.args.indexOf('-EncodedCommand');
  assert.equal(
    invokedArgs.args[encodedIdx + 1],
    encodePowerShellCommand(
      `Start-Process -FilePath '${exe}' -ArgumentList @('--remote-debugging-port=0') -WindowStyle Normal`
    )
  );

  let macCall = null;
  const macOk = launchAntigravityExecutable({
    platform: 'darwin',
    existsSyncFn: (p) => p === '/Applications/Antigravity.app',
    spawnFn: (cmd, args) => {
      macCall = { cmd, args };
      return { unref() {} };
    },
  });
  assert.equal(macOk.launched, true);
  assert.deepEqual(macCall, {
    cmd: 'open',
    args: ['-a', '/Applications/Antigravity.app', '--args', '--remote-debugging-port=0'],
  });
});

test('matchesQuotaInjectorCommand matches both spaced and hyphenated injector processes without false positives', () => {
  assert.equal(matchesQuotaInjectorCommand('Antigravity Quota Injector'), true);
  assert.equal(
    matchesQuotaInjectorCommand('/Applications/Antigravity Quota Injector.app/Contents/Resources/Antigravity Quota Injector Worker --explicit-start'),
    true
  );
  assert.equal(matchesQuotaInjectorCommand('node /Users/test/antigravity-quota-injector/src/launcher.mjs --explicit-start'), true);
  assert.equal(matchesQuotaInjectorCommand('node src/cli.mjs start'), true);
  assert.equal(matchesQuotaInjectorCommand('/Applications/Antigravity.app/Contents/MacOS/Antigravity'), false);
  assert.equal(matchesQuotaInjectorCommand('Antigravity.exe'), false);
});

test('findRunningAntigravityPids and hasAntigravityRemoteDebuggingFlag inspect darwin and win32 processes cleanly', () => {
  const macPids = findRunningAntigravityPids({
    platform: 'darwin',
    execFileSyncFn: () =>
      [
        '101 /Applications/Antigravity.app/Contents/MacOS/Antigravity',
        '102 /Applications/Antigravity.app/Contents/Resources/bin/language_server',
        '103 /Applications/Antigravity Quota Injector.app/Contents/MacOS/node',
      ].join('\n'),
  });
  assert.deepEqual(macPids, [101, 102]);

  assert.equal(
    hasAntigravityRemoteDebuggingFlag({
      platform: 'darwin',
      execFileSyncFn: () =>
        '/Applications/Antigravity.app/Contents/MacOS/Antigravity --remote-debugging-port=0\n',
    }),
    true
  );
  assert.equal(
    hasAntigravityRemoteDebuggingFlag({
      platform: 'darwin',
      execFileSyncFn: () => '/Applications/Antigravity.app/Contents/MacOS/Antigravity\n',
    }),
    false
  );

  assert.equal(
    hasAntigravityRemoteDebuggingFlag({
      platform: 'win32',
      spawnSyncFn: () => ({
        status: 0,
        stdout: '"C:\\Users\\Alice\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe" --remote-debugging-port=0\r\n',
      }),
    }),
    true
  );
  assert.equal(
    hasAntigravityRemoteDebuggingFlag({
      platform: 'win32',
      spawnSyncFn: () => ({
        status: 0,
        stdout: '"C:\\Users\\Alice\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe"\r\n',
      }),
    }),
    false
  );
  assert.equal(
    inspectAntigravityRemoteDebugging({
      platform: 'win32',
      spawnSyncFn: () => ({ status: 1, stdout: '' }),
    }),
    'unknown'
  );
  assert.equal(
    inspectAntigravityRemoteDebugging({
      platform: 'win32',
      spawnSyncFn: () => ({ status: 0, stdout: '\r\n' }),
    }),
    'unknown'
  );
});

test('quitAndWaitAntigravityProcesses quits gracefully and avoids force-kill on win32 timeout', async () => {
  const winCalls = [];
  let winAlive = true;
  const winExited = await quitAndWaitAntigravityProcesses({
    platform: 'win32',
    timeoutMs: 100,
    sleepFn: async () => {},
    execFileSyncFn: (cmd, args) => {
      winCalls.push([cmd, args]);
      if (cmd === 'tasklist') {
        return winAlive ? '"Antigravity.exe","4321","Console","1","100 K"\r\n' : 'INFO: No tasks\r\n';
      }
      if (cmd === 'taskkill' && !args.includes('/F')) {
        winAlive = false;
      }
      return '';
    },
  });
  assert.equal(winExited, true);
  assert.equal(
    winCalls.some(([cmd, args]) => cmd === 'taskkill' && args.includes('/IM') && !args.includes('/F')),
    true
  );

  const stuckWinCalls = [];
  const stuckExited = await quitAndWaitAntigravityProcesses({
    platform: 'win32',
    timeoutMs: 20,
    sleepFn: async () => {},
    execFileSyncFn: (cmd, args) => {
      stuckWinCalls.push([cmd, args]);
      if (cmd === 'tasklist') {
        return '"Antigravity.exe","4321","Console","1","100 K"\r\n';
      }
      return '';
    },
  });
  assert.equal(stuckExited, false);
  assert.equal(
    stuckWinCalls.some(([cmd, args]) => cmd === 'taskkill' && args.includes('/F')),
    false
  );

  const macCalls = [];
  let macAlive = true;
  const macExited = await quitAndWaitAntigravityProcesses({
    platform: 'darwin',
    timeoutMs: 100,
    sleepFn: async () => {},
    execFileSyncFn: (cmd, args) => {
      macCalls.push([cmd, args]);
      if (cmd === 'ps') {
        return macAlive ? '555 /Applications/Antigravity.app/Contents/MacOS/Antigravity\n' : '';
      }
      if (cmd === 'osascript') {
        macAlive = false;
      }
      return '';
    },
  });
  assert.equal(macExited, true);
  assert.equal(macCalls.some(([cmd]) => cmd === 'osascript'), true);
});
