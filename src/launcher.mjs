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
  isAntigravityProcessRunning,
  isPidAlive,
  launchAntigravityExecutable,
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
      path.join(srcDir, 'proto-metrics.mjs'),
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

async function ensureAntigravityRunning(paths, userCfg, { allowMissingError = false } = {}) {
  const extraExeNames = userCfg.antigravityExe
    ? [path.win32.basename(userCfg.antigravityExe)]
    : [];
  let running = isAntigravityProcessRunning({ channel: 'stable', extraExeNames });
  if (!running) {
    const port = readDebugPort(paths.portFile);
    if (port) {
      const targets = await fetchCdpTargets(port);
      running = targets.some(
        (t) =>
          t.type === 'page' && /^https?:\/\/(?:127\.0\.0\.1|localhost)/i.test(String(t.url || ''))
      );
    }
  }
  if (running) {
    console.log('[launcher] Antigravity 已在运行，直接附着注入');
    return { ok: true, launched: false };
  }

  const res = launchAntigravityExecutable({
    channel: 'stable',
    stateDir: paths.stateDir,
  });
  if (!res.launched) {
    if (allowMissingError) {
      return { ok: false, reason: res.reason };
    }
    console.warn(`[launcher] ${res.reason}`);
    return { ok: false, reason: res.reason };
  }
  console.log(`[launcher] 已拉起 Antigravity (${res.source}): ${res.exePath}`);
  return { ok: true, launched: true, exePath: res.exePath };
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
          await ensureAntigravityRunning(paths, readUserConfig(paths.stateDir));
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

    const ensured = await ensureAntigravityRunning(paths, userCfg, { allowMissingError: true });
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
