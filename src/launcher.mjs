#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
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
import { installFileLogger, getDefaultLogDir } from './file-logger.mjs';
import { endDevConsoleOnFormalTakeover } from './macos-dev-console.mjs';
import {
  hasAntigravityRemoteDebuggingFlag,
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
      path.join(srcDir, 'proto-metrics.mjs'),
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
    const injectable =
      hasLiveCdp || hasRemoteDebuggingFlagFn({ channel: 'stable', extraExeNames });
    if (injectable) {
      log('[launcher] Antigravity 已在运行，直接附着注入');
      return { ok: true, launched: false, restarted: false, injectable: true };
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

export async function runLauncher({
  once = false,
  explicitStart = isSea() ||
    process.env.ANTIGRAVITY_QUOTA_EXPLICIT_START === '1' ||
    process.argv.includes('--explicit-start'),
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
  process.title = 'Antigravity Quota Injector';
  const logPath = installFileLogger();
  if (!explicitStart) {
    console.warn('[launcher] 请通过桌面应用入口或 npm run launch 启动');
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
          await ensureAntigravityRunning(paths, readUserConfig(paths.stateDir), {
            setRestartInFlight: (flag) => daemonControls?.setRestartInFlight?.(flag),
          });
          await daemonControls?.tickNow?.();
        },
      });
    } catch (err) {
      if (!(err instanceof SingleInstanceTakeoverError)) throw err;
      console.warn(`[launcher] ${err.message}`);
      return 1;
    }

    if (!instanceLock) {
      console.log(`[launcher] 已有注入器保留运行，当前 ${mode} v${version} 退出`);
      return 0;
    }

    const ensured = await ensureAntigravityRunning(paths, userCfg, {
      allowMissingError: true,
      allowRestart: !once,
    });
    if (!ensured.ok) {
      console.error(`[launcher] ${ensured.reason}`);
      if (!once) {
        showNativeFailureNotice('Antigravity Quota Injector', ensured.reason);
      }
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
  runLauncher({ once, explicitStart: true })
    .then((code) => {
      if (typeof code === 'number' && code !== 0) {
        process.exitCode = code;
      }
    })
    .catch((err) => {
      console.error(`[launcher] fatal: ${err?.stack || err}`);
      process.exitCode = 1;
    });
}
