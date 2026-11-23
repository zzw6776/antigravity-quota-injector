#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';

import { createUpdateManager, getDefaultAppDataDir } from './app-update/manager.mjs';
import {
  fetchCdpTargets,
  getAppDataPaths,
  readDebugPort,
  readPackageVersion,
  readUserConfig,
  runDaemon,
} from './daemon.mjs';
import { getDefaultLogDir, getDefaultLogPath, installFileLogger } from './file-logger.mjs';
import { endDevConsoleOnFormalTakeover } from './macos-dev-console.mjs';
import {
  hasAntigravityRemoteDebuggingFlag,
  inspectAntigravityRemoteDebugging,
  isAntigravityProcessRunning,
  isPidAlive,
  launchAntigravityExecutable,
  quitAndWaitAntigravityProcesses,
  resolveAntigravityExecutable,
  showWindowsNotice,
} from './platform.mjs';
import {
  SingleInstanceTakeoverError,
  acquireSingleInstance,
  closeSingleInstance,
  readSingleInstanceStatus,
} from './single-instance.mjs';

function showNativeFailureNotice(title, message) {
  if (process.platform === 'win32') {
    showWindowsNotice(title, message, { icon: 48 });
    return;
  }
  if (process.platform === 'darwin') {
    try {
      const safeTitle = String(title || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const safeMsg = String(message || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      execFileSync(
        '/usr/bin/osascript',
        ['-e', `display alert "${safeTitle}" message "${safeMsg}" as critical`],
        { timeout: 5000, stdio: 'ignore' }
      );
    } catch {}
  }
}

function computeDevRuntimeIdentity() {
  if (isSea()) return null;
  try {
    const srcDir =
      typeof __dirname === 'string'
        ? __dirname
        : path.dirname(fileURLToPath(import.meta.url));
    const rootDir = path.resolve(srcDir, '..');
    const hash = crypto.createHash('sha256');
    const files = [
      path.join(rootDir, 'package.json'),
      path.join(srcDir, 'launcher.mjs'),
      path.join(srcDir, 'daemon.mjs'),
      path.join(srcDir, 'platform.mjs'),
      path.join(srcDir, 'single-instance.mjs'),
      path.join(srcDir, 'file-logger.mjs'),
      path.join(srcDir, 'macos-dev-console.mjs'),
      path.join(srcDir, 'accounts.mjs'),
      path.join(srcDir, 'conversation-groups.mjs'),
      path.join(srcDir, 'keepalive.mjs'),
      path.join(srcDir, 'batch-keepalive.mjs'),
      path.join(srcDir, 'ui-prefs.mjs'),
      path.join(srcDir, 'proto-metrics.mjs'),
      path.join(srcDir, 'thinking-translator.mjs'),
      path.join(srcDir, 'token-pricing.mjs'),
      path.join(srcDir, 'app-update', 'manager.mjs'),
      path.join(srcDir, 'app-update', 'releases.mjs'),
      path.join(srcDir, 'app-update', 'download.mjs'),
      path.join(srcDir, 'app-update', 'install.mjs'),
    ];
    for (const file of files) {
      if (fs.existsSync(file)) {
        hash.update(file);
        hash.update(fs.readFileSync(file));
      }
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}

export async function ensureAntigravityRunning(
  paths,
  userCfg = {},
  {
    allowMissingError = false,
    allowRestart = true,
    setRestartInFlight = null,
    isProcessRunningFn = isAntigravityProcessRunning,
    readDebugPortFn = readDebugPort,
    fetchCdpTargetsFn = fetchCdpTargets,
    hasRemoteDebuggingFlagFn = hasAntigravityRemoteDebuggingFlag,
    inspectRemoteDebuggingFn = null,
    resolveExecutableFn = resolveAntigravityExecutable,
    quitAntigravityFn = quitAndWaitAntigravityProcesses,
    launchExecutableFn = launchAntigravityExecutable,
    existsSyncFn = fs.existsSync,
    unlinkSyncFn = fs.unlinkSync,
    sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)),
    log = console.log,
    warn = console.warn,
  } = {}
) {
  const extraExeNames = userCfg?.antigravityExe
    ? [path.win32.basename(userCfg.antigravityExe)]
    : [];
  let running = isProcessRunningFn({ channel: 'stable', extraExeNames });
  let activePort = readDebugPortFn(paths.portFile);
  let initialTargets = activePort ? await fetchCdpTargetsFn(activePort) : [];
  if (!running && Array.isArray(initialTargets) && initialTargets.length > 0) {
    running = initialTargets.some(
      (t) =>
        t.type === 'page' && /^https?:\/\/(?:127\.0\.0\.1|localhost)/i.test(String(t.url || ''))
    );
  }

  if (running) {
    const hasLiveCdp =
      Array.isArray(initialTargets) &&
      initialTargets.some((t) => Boolean(t?.webSocketDebuggerUrl || t?.type === 'page'));
    let remoteDebugState = 'disabled';
    if (!hasLiveCdp) {
      if (typeof inspectRemoteDebuggingFn === 'function') {
        remoteDebugState = inspectRemoteDebuggingFn({ channel: 'stable', extraExeNames });
      } else if (hasRemoteDebuggingFlagFn !== hasAntigravityRemoteDebuggingFlag) {
        remoteDebugState = hasRemoteDebuggingFlagFn({ channel: 'stable', extraExeNames })
          ? 'enabled'
          : 'disabled';
      } else {
        remoteDebugState = inspectAntigravityRemoteDebugging({ channel: 'stable', extraExeNames });
      }
    }
    const injectable = hasLiveCdp || remoteDebugState === 'enabled';
    if (injectable) {
      log('[launcher] Antigravity 已在运行，直接附着注入');
      return { ok: true, launched: false, restarted: false, injectable: true };
    }
    if (remoteDebugState === 'unknown') {
      warn('[launcher] 无法确认运行中 Antigravity 的远程调试参数状态，跳过自动重启');
      return {
        ok: true,
        launched: false,
        restarted: false,
        injectable: false,
        reason: 'unknown_debug_flag',
      };
    }

    if (!allowRestart) {
      warn(
        '[launcher] 检测到 Antigravity 已在运行但未开启远程调试端口（Antigravity 2.33+ 需带 --remote-debugging-port=0 启动），当前无法注入；请完全退出 Antigravity 后通过本注入器启动'
      );
      return { ok: true, launched: false, restarted: false, injectable: false };
    }

    const resolved = resolveExecutableFn({ channel: 'stable', stateDir: paths.stateDir });
    if (!resolved?.exePath) {
      warn('[launcher] 检测到 Antigravity 已在运行但无法注入，且未找到可重启的执行路径，跳过自动重启');
      return {
        ok: true,
        launched: false,
        restarted: false,
        injectable: false,
        reason: 'missing_executable',
      };
    }

    log('[launcher] 检测到 Antigravity 已在运行但无法注入（未开启远程调试端口），正在自动重启 Antigravity...');
    setRestartInFlight?.(true);
    try {
      const exited = await quitAntigravityFn({
        channel: 'stable',
        extraExeNames,
        timeoutMs: 8000,
      });
      if (!exited) {
        warn('[launcher] 等待 Antigravity 退出超时，已取消自动重启（请手动退出 Antigravity 后重试）');
        return {
          ok: true,
          launched: false,
          restarted: false,
          injectable: false,
          reason: 'quit_timeout',
        };
      }

      if (activePort && existsSyncFn(paths.portFile)) {
        try {
          unlinkSyncFn(paths.portFile);
        } catch {}
      }

      await sleepFn(300);

      let res = launchExecutableFn({
        channel: 'stable',
        stateDir: paths.stateDir,
      });
      if (!res.launched) {
        if (allowMissingError) {
          return { ok: false, reason: res.reason };
        }
        warn(`[launcher] ${res.reason}`);
        return { ok: false, reason: res.reason };
      }

      const waitLaunched = async (timeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (isProcessRunningFn({ channel: 'stable', extraExeNames })) return true;
          await sleepFn(200);
        }
        return isProcessRunningFn({ channel: 'stable', extraExeNames });
      };

      const firstOk = await waitLaunched(4000);
      if (!firstOk) {
        await sleepFn(600);
        res = launchExecutableFn({
          channel: 'stable',
          stateDir: paths.stateDir,
        });
        if (!res.launched) {
          return { ok: false, reason: res.reason };
        }
        await waitLaunched(6000);
      }

      log(`[launcher] 已自动重启 Antigravity (${res.source}): ${res.exePath}`);
      return {
        ok: true,
        launched: true,
        restarted: true,
        injectable: true,
        exePath: res.exePath,
      };
    } finally {
      setRestartInFlight?.(false);
    }
  }

  const res = launchExecutableFn({
    channel: 'stable',
    stateDir: paths.stateDir,
  });
  if (!res.launched) {
    if (allowMissingError) {
      return { ok: false, reason: res.reason };
    }
    warn(`[launcher] ${res.reason}`);
    return { ok: false, reason: res.reason };
  }
  log(`[launcher] 已拉起 Antigravity (${res.source}): ${res.exePath}`);
  return { ok: true, launched: true, restarted: false, injectable: true, exePath: res.exePath };
}

async function runUpdatePreparation(version) {
  let lock = null;
  try {
    const previous = await readSingleInstanceStatus().catch(() => null);
    lock = await acquireSingleInstance({
      mode: 'formal',
      version,
      explicitStart: true,
      purpose: 'install-update',
      getStatus: () => ({ phase: 'updating' }),
    });
    if (!lock) {
      throw new Error('现有注入器拒绝安装接管');
    }
    const oldPid = Number(previous?.pid);
    if (Number.isInteger(oldPid) && oldPid > 0 && oldPid !== process.pid) {
      const deadline = Date.now() + 5000;
      while (isPidAlive(oldPid) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    return 0;
  } catch (err) {
    console.error(`[launcher] update preparation failed: ${err?.message || err}`);
    return 1;
  } finally {
    await closeSingleInstance(lock);
  }
}

function writeLaunchStatusFile(statusFile, payload) {
  if (!statusFile) return;
  const tmpFile = `${statusFile}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmpFile, statusFile);
  } catch {
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch {}
    try {
      fs.writeFileSync(statusFile, JSON.stringify(payload), 'utf8');
    } catch {}
  }
}

export function shouldDetachMacDevLauncher({
  platform = process.platform,
  sea = isSea(),
  explicitStart = false,
  once = false,
  argv = process.argv,
  env = process.env,
} = {}) {
  if (platform !== 'darwin' || sea || !explicitStart || once) return false;
  if (env?.AQ_DETACHED_CHILD === '1') return false;
  const args = Array.isArray(argv) ? argv : [];
  if (
    args.includes('--version') ||
    args.includes('--prepare-update') ||
    args.includes('--foreground')
  ) {
    return false;
  }
  return true;
}

export async function launchDetachedMacLauncher({
  entrypointPath,
  argv = [],
  env = process.env,
  execPath = process.execPath,
  logPath = getDefaultLogPath(),
  spawnFn = spawn,
  existsSyncFn = fs.existsSync,
  readFileSyncFn = fs.readFileSync,
  statSyncFn = fs.statSync,
  mkdtempSyncFn = fs.mkdtempSync,
  rmSyncFn = fs.rmSync,
  sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)),
  timeoutMs = 45_000,
  log = console.log,
  error = console.error,
} = {}) {
  const tmpDir = mkdtempSyncFn(path.join(os.tmpdir(), 'aq-detach-'));
  const statusFile = path.join(tmpDir, 'status.json');
  const forwardLogs = env?.ANTIGRAVITY_QUOTA_DEV_EXTERNAL_START !== '1';
  let logOffset = 0;
  try {
    if (existsSyncFn(logPath)) {
      logOffset = statSyncFn(logPath).size || 0;
    }
  } catch {}

  const flushLogDelta = () => {
    if (!forwardLogs) return;
    try {
      if (!existsSyncFn(logPath)) return;
      const size = statSyncFn(logPath).size || 0;
      if (size < logOffset) {
        logOffset = 0;
      }
      if (size === logOffset) return;
      const buf = readFileSyncFn(logPath);
      const chunk = buf.subarray(logOffset, size).toString('utf8');
      logOffset = size;
      for (const line of chunk.split(/\r?\n/)) {
        if (line) {
          log(line.replace(/^\[\d{4}-\d{2}-\d{2}T[^\]]+\]\s+\[[A-Z]+\]\s+/, ''));
        }
      }
    } catch {}
  };

  let exited = false;
  let exitCode = null;
  let exitSignal = null;
  const child = spawnFn(execPath, [entrypointPath, ...argv], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: {
      ...env,
      AQ_DETACHED_CHILD: '1',
      AQ_LAUNCH_STATUS_FILE: statusFile,
    },
  });
  child?.once?.('exit', (code, signal) => {
    exited = true;
    exitCode = code;
    exitSignal = signal;
  });
  child?.once?.('error', (err) => {
    exited = true;
    exitCode = 1;
    error(`[launcher] 后台启动进程失败: ${err?.message || err}`);
  });
  child?.unref?.();

  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      flushLogDelta();
      if (existsSyncFn(statusFile)) {
        try {
          const parsed = JSON.parse(readFileSyncFn(statusFile, 'utf8'));
          flushLogDelta();
          if (parsed?.ok === false) {
            if (parsed.reason) {
              error(`[launcher] ${parsed.reason}`);
            }
            return Number.isInteger(parsed?.exitCode) && parsed.exitCode !== 0 ? parsed.exitCode : 1;
          }
          return 0;
        } catch {}
      }
      if (exited) {
        await sleepFn(50);
        flushLogDelta();
        if (existsSyncFn(statusFile)) {
          try {
            const parsed = JSON.parse(readFileSyncFn(statusFile, 'utf8'));
            if (parsed?.ok === false) {
              if (parsed.reason) error(`[launcher] ${parsed.reason}`);
              return Number.isInteger(parsed?.exitCode) && parsed.exitCode !== 0 ? parsed.exitCode : 1;
            }
            return 0;
          } catch {}
        }
        if (exitCode === 0) return 0;
        error(
          `[launcher] 后台启动进程异常退出 (code=${exitCode ?? 'null'}, signal=${exitSignal ?? 'none'})`
        );
        return exitCode || 1;
      }
      await sleepFn(80);
    }
    flushLogDelta();
    error('[launcher] 等待后台注入器就绪超时');
    return 1;
  } finally {
    try {
      rmSyncFn(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

export async function runLauncher({
  once = false,
  explicitStart = isSea() ||
    process.env.ANTIGRAVITY_QUOTA_EXPLICIT_START === '1' ||
    process.argv.includes('--explicit-start'),
  statusFile = process.env.AQ_LAUNCH_STATUS_FILE || '',
} = {}) {
  const version = readPackageVersion();
  if (process.argv.includes('--version')) {
    console.log(version);
    return 0;
  }
  if (process.argv.includes('--prepare-update')) {
    return runUpdatePreparation(version);
  }

  const mode = isSea() ? 'formal' : 'dev';
  // Clear internal launcher handshake markers so any descendant processes (like Antigravity)
  // never inherit AQ_DETACHED_CHILD=1 or stale status paths.
  delete process.env.AQ_DETACHED_CHILD;
  delete process.env.AQ_LAUNCH_STATUS_FILE;
  delete process.env.ANTIGRAVITY_QUOTA_DEV_EXTERNAL_START;
  process.title = 'Antigravity Quota Injector';
  const logPath = installFileLogger();
  if (!explicitStart) {
    const reason = '请通过桌面应用入口或 npm run launch 启动';
    console.warn(`[launcher] ${reason}`);
    writeLaunchStatusFile(statusFile, { ok: false, phase: 'failed', exitCode: 1, reason });
    return 1;
  }

  const paths = getAppDataPaths('stable');
  const userCfg = readUserConfig(paths.stateDir);
  const runtimeIdentity = computeDevRuntimeIdentity();
  const launchStatus = { phase: 'starting', revision: 0 };
  let instanceLock = null;
  let daemonControls = null;
  let updateManager = null;
  let takeoverInProgress = false;
  let ensureInFlight = null;
  const runEnsureSingleFlight = (cfg, opts = {}) => {
    if (!ensureInFlight) {
      ensureInFlight = ensureAntigravityRunning(paths, cfg, {
        ...opts,
        setRestartInFlight: (flag) => daemonControls?.setRestartInFlight?.(flag),
      }).finally(() => {
        ensureInFlight = null;
      });
    }
    return ensureInFlight;
  };

  try {
    try {
      instanceLock = await acquireSingleInstance({
        mode,
        version,
        explicitStart: true,
        runtimeIdentity,
        getStatus: () => launchStatus,
        onTakeover: async (req) => {
          if (takeoverInProgress) return;
          takeoverInProgress = true;
          console.log(
            `[launcher] ${req?.mode ?? 'unknown'} v${req?.version ?? 'unknown'} 请求接管，正在退出当前实例`
          );
          await endDevConsoleOnFormalTakeover({
            mode,
            requestMode: req?.mode,
            logRoot: getDefaultLogDir(),
          }).catch((err) => console.warn(`[launcher] 开发日志终端退出通知失败: ${err?.message || err}`));
          updateManager?.stop();
          daemonControls?.stop();
          await closeSingleInstance(instanceLock);
          process.exit(0);
        },
        onReuse: async (req) => {
          launchStatus.revision += 1;
          console.log(
            `[launcher] ${req?.mode ?? 'unknown'} v${req?.version ?? 'unknown'} 请求复用当前实例`
          );
          await runEnsureSingleFlight(readUserConfig(paths.stateDir));
          await daemonControls?.tickNow?.();
        },
      });
    } catch (err) {
      if (!(err instanceof SingleInstanceTakeoverError)) throw err;
      console.warn(`[launcher] ${err.message}`);
      writeLaunchStatusFile(statusFile, {
        ok: false,
        phase: 'failed',
        exitCode: 1,
        reason: err.message,
      });
      return 1;
    }

    if (!instanceLock) {
      console.log(`[launcher] 已有注入器保留运行，当前 ${mode} v${version} 退出`);
      writeLaunchStatusFile(statusFile, { ok: true, phase: 'reused', exitCode: 0 });
      return 0;
    }

    const ensured = await runEnsureSingleFlight(userCfg, {
      allowMissingError: true,
      allowRestart: !once,
    });
    if (!ensured.ok) {
      console.error(`[launcher] ${ensured.reason}`);
      if (!once) {
        showNativeFailureNotice('Antigravity Quota Injector', ensured.reason);
      }
      writeLaunchStatusFile(statusFile, {
        ok: false,
        phase: 'failed',
        exitCode: 1,
        reason: ensured.reason,
      });
      return 1;
    }

    const subscribers = new Set();
    updateManager = createUpdateManager({
      version,
      mode,
      dataDir: getDefaultAppDataDir(),
      onStateChange: (nextState) => {
        for (const fn of subscribers) {
          try {
            fn(nextState);
          } catch {}
        }
      },
      onBeforeExit: async () => {
        takeoverInProgress = true;
        updateManager?.stop();
        daemonControls?.stop();
        await closeSingleInstance(instanceLock);
        instanceLock = null;
      },
    });
    const updateProvider = {
      getState: () => updateManager.getState(),
      subscribe: (fn) => {
        subscribers.add(fn);
        return () => subscribers.delete(fn);
      },
      checkNow: (opts) => updateManager.checkNow(opts),
      openUpdate: (opts) => updateManager.openUpdate(opts),
      installUpdate: () => updateManager.installUpdate(),
      openReleasePage: () => updateManager.openReleasePage(),
    };
    if (!once) {
      updateManager.start();
    }

    launchStatus.phase = 'ready';
    console.log(`[launcher] 已启动 (${mode} v${version}), 日志=${logPath}`);
    writeLaunchStatusFile(statusFile, { ok: true, phase: 'ready', exitCode: 0 });

    await runDaemon({
      once,
      channel: 'stable',
      followApp: true,
      skipKillExistingPid: true,
      updateManager: updateProvider,
      onRegisterControls: (controls) => {
        daemonControls = controls;
      },
    });
    return 0;
  } finally {
    updateManager?.stop();
    await closeSingleInstance(instanceLock);
  }
}

const isEntrypoint = (() => {
  if (isSea()) return true;
  if (!process.argv[1]) return false;
  try {
    const selfPath =
      typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url);
    return path.resolve(process.argv[1]) === path.resolve(selfPath);
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  const once = process.argv.includes('--once');
  const explicitStart =
    isSea() ||
    process.env.ANTIGRAVITY_QUOTA_EXPLICIT_START === '1' ||
    process.argv.includes('--explicit-start');
  const entryStatusFile = process.env.AQ_LAUNCH_STATUS_FILE || '';
  const runner = shouldDetachMacDevLauncher({ explicitStart, once })
    ? launchDetachedMacLauncher({
        entrypointPath: fileURLToPath(import.meta.url),
        argv: process.argv.slice(2),
      })
    : runLauncher({ once, explicitStart, statusFile: entryStatusFile });
  runner
    .then((code) => {
      if (typeof code === 'number' && code !== 0) {
        process.exitCode = code;
      }
    })
    .catch((err) => {
      writeLaunchStatusFile(entryStatusFile, {
        ok: false,
        phase: 'failed',
        exitCode: 1,
        reason: err?.message || String(err),
      });
      console.error(`[launcher] fatal: ${err?.stack || err}`);
      process.exitCode = 1;
    });
}
