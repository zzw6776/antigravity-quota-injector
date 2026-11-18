#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MIN_NODE_MAJOR,
  MIN_NODE_MINOR,
  getWindowsAppEntryStatus,
  installWindowsAppEntry,
  isAntigravityProcessRunning,
  isNodeVersionSupported,
  isQuotaInjectorDaemonPid,
  resolveAntigravityExecutable,
  showWindowsNotice,
  uninstallWindowsAppEntry,
} from './platform.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const LAUNCH_AGENT_LABEL = 'com.antigravity.quota-injector';

function getLaunchAgentPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
}

function buildPlistXml(nodePath, cliPath, logFile) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${cliPath}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logFile}</string>
  <key>StandardErrorPath</key>
  <string>${logFile}</string>
</dict>
</plist>
`;
}

const cmd = process.argv[2] || 'start';
const once = process.argv.includes('--once');
const followAppFlag = process.argv.includes('--follow-app');

if (!isNodeVersionSupported()) {
  const errMsg = `需要 Node.js >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0，当前版本为 ${process.version}。请升级 Node.js 后重试。`;
  console.error(errMsg);
  if (process.platform === 'win32' && ['launch', 'install-app', 'install'].includes(cmd)) {
    showWindowsNotice('Antigravity Quota', errMsg, { icon: 16 });
  }
  process.exit(1);
}

const {
  buildClientScript,
  cleanupOpenTargets,
  fetchCdpTargets,
  getAppDataPaths,
  readDebugPort,
  readUserConfig,
  runDaemon,
  stopRunningDaemon,
} = await import('./daemon.mjs');
const { getAccountSwitchSupport } = await import('./accounts.mjs');
const { getDefaultLogPath } = await import('./file-logger.mjs');
const { runLauncher } = await import('./launcher.mjs');
const { readSingleInstanceStatus } = await import('./single-instance.mjs');

async function cmdDoctor() {
  const paths = getAppDataPaths('stable');
  const userCfg = readUserConfig(paths.stateDir);
  const port = readDebugPort(paths.portFile);
  const targets = port ? await fetchCdpTargets(port) : [];
  const antigravityPages = targets.filter(
    (t) => t.type === 'page' && /^https?:\/\/(?:127\.0\.0\.1|localhost)/i.test(String(t.url || ''))
  );
  const pidFile = path.join(paths.stateDir, 'daemon-stable.pid');
  let daemonPid = null;
  let daemonAlive = false;
  if (fs.existsSync(pidFile)) {
    daemonPid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10) || null;
    if (daemonPid) {
      daemonAlive = isQuotaInjectorDaemonPid(daemonPid);
    }
  }
  const extraExeNames = userCfg.antigravityExe ? [path.win32.basename(userCfg.antigravityExe)] : [];
  const resolvedExe = resolveAntigravityExecutable({ channel: 'stable', stateDir: paths.stateDir });
  const antigravityRunning = isAntigravityProcessRunning({ channel: 'stable', extraExeNames });
  const accountSwitch = getAccountSwitchSupport();
  const singleInstanceStatus = await readSingleInstanceStatus().catch(() => null);

  const report = {
    platform: process.platform,
    nodeVersion: process.version,
    nodeSupported: isNodeVersionSupported(),
    logPath: getDefaultLogPath(),
    portFile: paths.portFile,
    debugPort: port,
    conversationsDirExists: fs.existsSync(paths.conversationsDir),
    antigravityExe: resolvedExe.exePath || null,
    antigravityExeSource: resolvedExe.source || null,
    antigravityRunning,
    antigravityPages: antigravityPages.map((p) => ({ id: p.id, title: p.title, url: p.url.split('?')[0] })),
    daemonPid,
    daemonAlive,
    singleInstanceStatus,
    accountSwitchSupported: accountSwitch.supported,
    accountSwitchNote: accountSwitch.reason || null,
  };

  if (process.platform === 'darwin') {
    report.launchAgentInstalled = fs.existsSync(getLaunchAgentPath());
  } else if (process.platform === 'win32') {
    report.windowsAppEntry = getWindowsAppEntryStatus({ stateDir: paths.stateDir });
  }

  console.log(JSON.stringify(report, null, 2));
}

async function cmdVerify() {
  const paths = getAppDataPaths('stable');
  const port = readDebugPort(paths.portFile);
  if (!port) {
    console.error('Antigravity DevToolsActivePort not found.');
    process.exit(1);
  }
  const targets = await fetchCdpTargets(port);
  const page = targets.find(
    (t) => t.type === 'page' && /^https?:\/\/(?:127\.0\.0\.1|localhost)/i.test(String(t.url || ''))
  );
  if (!page?.webSocketDebuggerUrl) {
    console.error('No Antigravity page target found.');
    process.exit(1);
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, rej) => {
    const t = setTimeout(() => rej(new Error('CDP connect timeout')), 5000);
    ws.onopen = () => {
      clearTimeout(t);
      r();
    };
    ws.onerror = (err) => {
      clearTimeout(t);
      rej(err);
    };
  });

  const evalRes = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('CDP evaluate timeout')), 5000);
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id === 1) {
        clearTimeout(t);
        resolve(msg.result?.result?.value);
      }
    });
    ws.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression: `(() => ({
            version: window.__aq_version || null,
            hasStyle: Boolean(document.getElementById('aq-style')),
            hasContextChip: Boolean(document.getElementById('aq-context-chip')),
            contextText: document.getElementById('aq-context-chip')?.textContent || '',
            hasQuotaChip: Boolean(document.getElementById('aq-quota-chip')),
            quotaText: document.getElementById('aq-quota-chip')?.textContent || '',
            turnUsageCount: document.querySelectorAll('[data-aq-turn-usage]').length,
            cascadeId: window.__aqGetWatchedCascadeId ? window.__aqGetWatchedCascadeId() : ''
          }))()`,
          returnByValue: true,
        },
      })
    );
  });
  ws.close();
  console.log(JSON.stringify({ ok: Boolean(evalRes?.version && evalRes?.hasQuotaChip), ...evalRes }, null, 2));
}

async function cmdLaunch() {
  const code = await runLauncher({ once, explicitStart: true });
  if (typeof code === 'number' && code !== 0) {
    process.exit(code);
  }
}

function cmdInstallApp() {
  if (process.platform === 'win32') {
    const paths = getAppDataPaths('stable');
    const res = installWindowsAppEntry({
      projectRoot: PROJECT_ROOT,
      nodePath: process.execPath,
      stateDir: paths.stateDir,
      channel: 'stable',
    });
    console.log('已安装 Windows 手动应用入口（未设置开机自启动）：');
    for (const sc of res.shortcuts) {
      console.log(`  快捷方式: ${sc}`);
    }
    console.log(`  Node 路径: ${process.execPath}`);
    if (res.antigravityExe) {
      console.log(`  Antigravity: ${res.antigravityExe}`);
    } else {
      console.log(
        `  提示: 未在默认路径检测到 Antigravity.exe。如启动时提示找不到，请在 ${path.join(paths.stateDir, 'config.json')} 中添加 {"antigravityExe": "你的路径\\\\Antigravity.exe"}。`
      );
    }
    return;
  }

  console.log('当前系统无需安装 Windows 桌面快捷方式。可直接使用 `npm run launch` 手动联动启动，或 `npm start` 前台运行。');
}

async function cmdUninstallApp() {
  if (process.platform === 'win32') {
    const paths = getAppDataPaths('stable');
    const res = uninstallWindowsAppEntry({ stateDir: paths.stateDir });
    const stopped = await stopRunningDaemon('stable');
    const cleaned = await cleanupOpenTargets('stable');
    console.log(`已移除 Windows 应用入口（删除 ${res.removed.length} 个快捷方式），停止守护进程=${stopped}，清理 ${cleaned} 个已打开窗口。`);
    return;
  }

  await cmdUninstallService();
}

function cmdInstallService() {
  if (process.platform !== 'darwin') {
    console.error('Windows 不建议且未配置开机自启服务；请运行 `npm run install-app` 创建手动应用入口。');
    process.exit(1);
  }
  const paths = getAppDataPaths('stable');
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const logFile = path.join(paths.stateDir, 'daemon.log');
  const plistPath = getLaunchAgentPath();
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });

  const plist = buildPlistXml(process.execPath, path.join(PROJECT_ROOT, 'src', 'cli.mjs'), logFile);
  fs.writeFileSync(plistPath, plist, 'utf8');

  const uid = process.getuid();
  spawnSync('launchctl', ['bootout', `gui/${uid}`, plistPath], { stdio: 'ignore' });
  const res = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { encoding: 'utf8' });
  if (res.status !== 0) {
    console.error('Failed to load LaunchAgent:', res.stderr || res.stdout);
    process.exit(1);
  }
  console.log(`Installed and started ${LAUNCH_AGENT_LABEL}`);
  console.log(`Plist: ${plistPath}`);
  console.log(`Logs:  ${logFile}`);
}

async function cmdUninstallService() {
  if (process.platform === 'darwin') {
    const plistPath = getLaunchAgentPath();
    const uid = process.getuid();
    spawnSync('launchctl', ['bootout', `gui/${uid}`, plistPath], { stdio: 'ignore' });
    if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
  } else if (process.platform === 'win32') {
    const paths = getAppDataPaths('stable');
    uninstallWindowsAppEntry({ stateDir: paths.stateDir });
  }
  const stopped = await stopRunningDaemon('stable');
  const cleaned = await cleanupOpenTargets('stable');
  console.log(`Uninstalled service (stopped daemon=${stopped}) and cleaned ${cleaned} open Antigravity window(s).`);
}

if (cmd === 'start' || cmd === 'daemon') {
  const paths = getAppDataPaths('stable');
  const userCfg = readUserConfig(paths.stateDir);
  const { version } = buildClientScript(userCfg);
  console.log(`[antigravity-quota-injector] starting (${version}) once=${once} followApp=${followAppFlag}`);
  await runDaemon({ once, followApp: followAppFlag });
} else if (cmd === 'launch') {
  await cmdLaunch();
} else if (cmd === 'install-app') {
  cmdInstallApp();
} else if (cmd === 'uninstall-app') {
  await cmdUninstallApp();
} else if (cmd === 'install-service') {
  cmdInstallService();
} else if (cmd === 'uninstall-service') {
  await cmdUninstallService();
} else if (cmd === 'install') {
  if (process.platform === 'win32') {
    cmdInstallApp();
  } else {
    cmdInstallService();
  }
} else if (cmd === 'uninstall') {
  if (process.platform === 'win32') {
    await cmdUninstallApp();
  } else {
    await cmdUninstallService();
  }
} else if (cmd === 'doctor') {
  await cmdDoctor();
} else if (cmd === 'verify') {
  await cmdVerify();
} else {
  console.log(
    'Usage: node src/cli.mjs <launch|start|install-app|uninstall-app|install-service|uninstall-service|doctor|verify> [--once] [--follow-app]'
  );
}
