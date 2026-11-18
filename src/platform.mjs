import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MIN_NODE_MAJOR = 22;
export const MIN_NODE_MINOR = 13;
export const WINDOWS_SHORTCUT_NAME = 'Antigravity Quota';

export function parseNodeVersion(versionStr = process.versions?.node || process.version) {
  const clean = String(versionStr || '').replace(/^v/i, '');
  const [major = 0, minor = 0, patch = 0] = clean.split('.').map((n) => Number.parseInt(n, 10) || 0);
  return { major, minor, patch };
}

export function isNodeVersionSupported(
  versionStr = process.versions?.node || process.version,
  minMajor = MIN_NODE_MAJOR,
  minMinor = MIN_NODE_MINOR
) {
  const { major, minor } = parseNodeVersion(versionStr);
  return major > minMajor || (major === minMajor && minor >= minMinor);
}

export function encodePowerShellCommand(script) {
  return Buffer.from(String(script || ''), 'utf16le').toString('base64');
}

export function escapePowerShellSingleQuoted(value) {
  return String(value ?? '').replace(/'/g, "''");
}

export function getAntigravityExeNames(channel = 'stable') {
  return channel === 'insiders'
    ? ['Antigravity - Insiders.exe', 'Antigravity.exe']
    : ['Antigravity.exe'];
}

function readConfiguredExe(stateDir, readFileSyncFn = fs.readFileSync, existsSyncFn = fs.existsSync) {
  if (!stateDir) return '';
  try {
    const cfgPath = path.join(stateDir, 'config.json');
    if (!existsSyncFn(cfgPath)) return '';
    const parsed = JSON.parse(readFileSyncFn(cfgPath, 'utf8'));
    return typeof parsed?.antigravityExe === 'string' ? parsed.antigravityExe.trim() : '';
  } catch {
    return '';
  }
}

export function resolveAntigravityExecutable({
  channel = 'stable',
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
  stateDir = '',
  existsSyncFn = fs.existsSync,
  readFileSyncFn = fs.readFileSync,
} = {}) {
  const joinPath = platform === 'win32' ? path.win32.join : path.posix.join;

  const envExe = String(env?.ANTIGRAVITY_EXE || '').trim();
  if (envExe && existsSyncFn(envExe)) {
    return { exePath: envExe, source: 'env' };
  }

  const cfgExe = readConfiguredExe(stateDir, readFileSyncFn, existsSyncFn);
  if (cfgExe && existsSyncFn(cfgExe)) {
    return { exePath: cfgExe, source: 'config' };
  }

  if (platform === 'darwin') {
    const bundleName = channel === 'insiders' ? 'Antigravity - Insiders.app' : 'Antigravity.app';
    const candidates = [
      joinPath('/Applications', bundleName),
      joinPath(homedir, 'Applications', bundleName),
    ];
    for (const candidate of candidates) {
      if (existsSyncFn(candidate)) {
        return { exePath: candidate, source: 'standard' };
      }
    }
    return { exePath: '', source: '' };
  }

  if (platform === 'win32') {
    const folderNames =
      channel === 'insiders'
        ? ['Antigravity - Insiders', 'Antigravity Insiders']
        : ['Antigravity'];
    const exeNames = getAntigravityExeNames(channel);
    const bases = [
      env?.LOCALAPPDATA ? joinPath(env.LOCALAPPDATA, 'Programs') : '',
      env?.LOCALAPPDATA || '',
      env?.ProgramFiles || env?.PROGRAMFILES || '',
      env?.['ProgramFiles(x86)'] || '',
    ].filter(Boolean);

    const seen = new Set();
    for (const base of bases) {
      for (const folder of folderNames) {
        for (const exeName of exeNames) {
          const candidate = joinPath(base, folder, exeName);
          const key = candidate.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          if (existsSyncFn(candidate)) {
            return { exePath: candidate, source: 'standard' };
          }
        }
      }
    }

    const pathEnv = String(env?.PATH || env?.Path || '');
    for (const rawDir of pathEnv.split(';')) {
      const dir = rawDir.trim().replace(/^"+|"+$/g, '');
      if (!dir) continue;
      for (const exeName of exeNames) {
        const candidate = joinPath(dir, exeName);
        const key = candidate.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        if (existsSyncFn(candidate)) {
          return { exePath: candidate, source: 'path' };
        }
      }
    }
    return { exePath: '', source: '' };
  }

  // Linux / other POSIX
  const binNames = channel === 'insiders' ? ['antigravity-insiders', 'antigravity'] : ['antigravity'];
  const pathEnv = String(env?.PATH || '');
  for (const rawDir of pathEnv.split(':')) {
    const dir = rawDir.trim();
    if (!dir) continue;
    for (const binName of binNames) {
      const candidate = joinPath(dir, binName);
      if (existsSyncFn(candidate)) {
        return { exePath: candidate, source: 'path' };
      }
    }
  }
  return { exePath: '', source: '' };
}

export function parseWindowsTasklistCsv(stdout, targetExeNames = ['Antigravity.exe']) {
  const expected = new Set(targetExeNames.map((n) => String(n || '').toLowerCase()));
  const lines = String(stdout || '').split(/\r?\n/);
  const pids = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith('"')) continue;
    const match = line.match(/^"([^"]+)"\s*,\s*"(\d+)"/);
    if (!match) continue;
    const imageName = match[1].toLowerCase();
    const pid = Number.parseInt(match[2], 10);
    if (expected.has(imageName) && Number.isFinite(pid) && pid > 0) {
      pids.push(pid);
    }
  }
  return pids;
}

export function isAntigravityProcessRunning({
  channel = 'stable',
  platform = process.platform,
  extraExeNames = [],
  execFileSyncFn = execFileSync,
} = {}) {
  try {
    if (platform === 'win32') {
      const exeNames = [
        ...new Set([
          ...getAntigravityExeNames(channel),
          ...extraExeNames.filter((n) => typeof n === 'string' && /\.exe$/i.test(n.trim())).map((n) => n.trim()),
        ]),
      ];
      for (const exeName of exeNames) {
        const out = execFileSyncFn(
          'tasklist',
          ['/FI', `IMAGENAME eq ${exeName}`, '/FO', 'CSV', '/NH'],
          {
            timeout: 2500,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          }
        );
        if (parseWindowsTasklistCsv(out, [exeName]).length > 0) {
          return true;
        }
      }
      return false;
    }

    if (platform === 'darwin') {
      const appName = channel === 'insiders' ? 'Antigravity - Insiders' : 'Antigravity';
      const marker = `/${appName}.app/Contents/MacOS/`;
      const out = execFileSyncFn('ps', ['-axo', 'comm='], {
        timeout: 1500,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return String(out || '')
        .split(/\r?\n/)
        .some((line) => line.trim().includes(marker));
    }

    const expected = channel === 'insiders' ? ['antigravity-insiders', 'antigravity'] : ['antigravity'];
    const out = execFileSyncFn('ps', ['-eo', 'comm='], {
      timeout: 1500,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return String(out || '')
      .split(/\r?\n/)
      .some((line) => expected.includes(path.posix.basename(line.trim())));
  } catch {
    return false;
  }
}

export function launchAntigravityExecutable({
  channel = 'stable',
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
  stateDir = '',
  spawnFn = spawn,
  spawnSyncFn = spawnSync,
  existsSyncFn = fs.existsSync,
  readFileSyncFn = fs.readFileSync,
} = {}) {
  const { exePath, source } = resolveAntigravityExecutable({
    channel,
    platform,
    env,
    homedir,
    stateDir,
    existsSyncFn,
    readFileSyncFn,
  });

  if (!exePath) {
    return {
      launched: false,
      exePath: '',
      source: '',
      reason:
        platform === 'win32'
          ? '未自动找到 Antigravity.exe，请在 config.json 中配置 antigravityExe 路径，或先手动打开 Antigravity。'
          : '未自动找到 Antigravity 应用，请先手动打开 Antigravity。',
    };
  }

  if (platform === 'darwin') {
    const child = spawnFn('open', ['-a', exePath], {
      detached: true,
      stdio: 'ignore',
    });
    child?.unref?.();
    return { launched: true, exePath, source };
  }

  if (platform === 'win32') {
    // Launch via ShellExecute (Start-Process -WindowStyle Normal) so a hidden wscript/node launcher
    // never passes SW_HIDE into Antigravity's initial window state.
    const psScript = `Start-Process -FilePath '${escapePowerShellSingleQuoted(exePath)}' -WindowStyle Normal`;
    const res = spawnSyncFn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodePowerShellCommand(psScript),
      ],
      {
        timeout: 8000,
        stdio: 'ignore',
        windowsHide: true,
      }
    );
    if (res?.status === 0) {
      return { launched: true, exePath, source };
    }
  }

  const child = spawnFn(exePath, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child?.unref?.();
  return { launched: true, exePath, source };
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isQuotaInjectorDaemonPid(
  pid,
  {
    platform = process.platform,
    execFileSyncFn = execFileSync,
  } = {}
) {
  if (!isPidAlive(pid)) return false;
  try {
    if (platform === 'win32') {
      const psScript = [
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue`,
        'if ($p) { Write-Output ($p.Name + "`n" + $p.CommandLine) }',
      ].join('\n');
      const out = execFileSyncFn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-WindowStyle',
          'Hidden',
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
          encodePowerShellCommand(psScript),
        ],
        {
          timeout: 3000,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        }
      );
      const text = String(out || '');
      if (/cli\.mjs/i.test(text) || /antigravity-quota-injector/i.test(text)) {
        return true;
      }
      if (text.trim()) return false;

      const csv = execFileSyncFn('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        timeout: 2500,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      return parseWindowsTasklistCsv(csv, ['node.exe']).includes(pid);
    }

    const out = execFileSyncFn('ps', ['-p', String(pid), '-o', 'command='], {
      timeout: 1500,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const cmdline = String(out || '').trim();
    if (!cmdline) return false;
    return /cli\.mjs|antigravity-quota-injector/i.test(cmdline);
  } catch {
    return false;
  }
}

export async function stopDaemonPid(pid, { platform = process.platform, execFileSyncFn = execFileSync } = {}) {
  if (!isQuotaInjectorDaemonPid(pid, { platform, execFileSyncFn })) {
    return false;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false;
  }
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isPidAlive(pid);
}

/**
 * State machine deciding when a follow-app daemon should exit once Antigravity closes.
 */
export function createFollowAppController({
  startupGraceMs = 60_000,
  exitConfirmTicks = 3,
  nowFn = () => Date.now(),
} = {}) {
  const startedAt = nowFn();
  let seenAppAlive = false;
  let absentTicks = 0;

  return {
    update({
      hasAttachedTargets = false,
      hasLiveCdpTargets = false,
      isProcessAlive = false,
      switchInFlight = false,
    } = {}) {
      if (hasAttachedTargets || hasLiveCdpTargets || isProcessAlive) {
        seenAppAlive = true;
        absentTicks = 0;
        return { shouldExit: false, reason: '', seenAppAlive, absentTicks };
      }

      if (switchInFlight) {
        absentTicks = 0;
        return { shouldExit: false, reason: '', seenAppAlive, absentTicks };
      }

      if (seenAppAlive) {
        absentTicks += 1;
        if (absentTicks >= exitConfirmTicks) {
          return { shouldExit: true, reason: 'app-closed', seenAppAlive, absentTicks };
        }
        return { shouldExit: false, reason: '', seenAppAlive, absentTicks };
      }

      if (nowFn() - startedAt >= startupGraceMs) {
        return { shouldExit: true, reason: 'startup-timeout', seenAppAlive, absentTicks };
      }

      return { shouldExit: false, reason: '', seenAppAlive, absentTicks };
    },
    getState() {
      return { seenAppAlive, absentTicks, startedAt };
    },
  };
}

export function showWindowsNotice(title, message, { icon = 48, spawnSyncFn = spawnSync } = {}) {
  if (process.platform !== 'win32') return false;
  const safeTitle = escapePowerShellSingleQuoted(title);
  const safeMsg = escapePowerShellSingleQuoted(message);
  const psScript = `$ws = New-Object -ComObject WScript.Shell; [void]$ws.Popup('${safeMsg}', 0, '${safeTitle}', ${Number(icon) || 48})`;
  const res = spawnSyncFn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodePowerShellCommand(psScript),
    ],
    {
      timeout: 10_000,
      stdio: 'ignore',
      windowsHide: true,
    }
  );
  return res?.status === 0;
}

export function buildWindowsInstallShortcutsScript({
  shortcutName = WINDOWS_SHORTCUT_NAME,
  vbsPath,
  workingDir,
  iconLocation,
  description = 'Launch Antigravity with Quota Injector (manual trigger, no auto-start)',
}) {
  const sName = escapePowerShellSingleQuoted(`${shortcutName}.lnk`);
  const sVbs = escapePowerShellSingleQuoted(vbsPath);
  const sWorkDir = escapePowerShellSingleQuoted(workingDir);
  const sIcon = escapePowerShellSingleQuoted(iconLocation);
  const sDesc = escapePowerShellSingleQuoted(description);

  return [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$ws = New-Object -ComObject WScript.Shell",
    "$targets = @(",
    "  (Join-Path ([Environment]::GetFolderPath('Desktop')) '" + sName + "'),",
    "  (Join-Path ([Environment]::GetFolderPath('Programs')) '" + sName + "')",
    ")",
    "$wscript = Join-Path $env:SystemRoot 'System32\\wscript.exe'",
    "$created = @()",
    "foreach ($lnkPath in $targets) {",
    "  $dir = Split-Path -Parent $lnkPath",
    "  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }",
    "  $sc = $ws.CreateShortcut($lnkPath)",
    "  $sc.TargetPath = $wscript",
    "  $sc.Arguments = '//Nologo \"' + '" + sVbs + "' + '\"'",
    "  $sc.WorkingDirectory = '" + sWorkDir + "'",
    "  $sc.WindowStyle = 1",
    "  $sc.Description = '" + sDesc + "'",
    "  if ('" + sIcon + "') { $sc.IconLocation = '" + sIcon + "' }",
    "  $sc.Save()",
    "  $created += $lnkPath",
    "}",
    "Write-Output ($created -join \"`n\")",
  ].join('\n');
}

export function buildWindowsRemoveShortcutsScript({ shortcutName = WINDOWS_SHORTCUT_NAME } = {}) {
  const sName = escapePowerShellSingleQuoted(`${shortcutName}.lnk`);
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$targets = @(",
    "  (Join-Path ([Environment]::GetFolderPath('Desktop')) '" + sName + "'),",
    "  (Join-Path ([Environment]::GetFolderPath('Programs')) '" + sName + "')",
    ")",
    "$removed = @()",
    "foreach ($lnkPath in $targets) {",
    "  if (Test-Path -LiteralPath $lnkPath) {",
    "    Remove-Item -LiteralPath $lnkPath -Force",
    "    $removed += $lnkPath",
    "  }",
    "}",
    "Write-Output ($removed -join \"`n\")",
  ].join('\n');
}

export function installWindowsAppEntry({
  projectRoot,
  nodePath = process.execPath,
  stateDir,
  channel = 'stable',
  shortcutName = WINDOWS_SHORTCUT_NAME,
  spawnSyncFn = spawnSync,
} = {}) {
  fs.mkdirSync(stateDir, { recursive: true });
  const nodePathFile = path.join(stateDir, 'node-path.txt');
  fs.writeFileSync(nodePathFile, `${nodePath}\r\n`, 'utf8');

  const vbsPath = path.join(projectRoot, 'windows', 'launch.vbs');
  const resolved = resolveAntigravityExecutable({ channel, platform: 'win32', stateDir });
  const iconLocation = resolved.exePath
    ? `${resolved.exePath},0`
    : `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\shell32.dll,24`;

  const psScript = buildWindowsInstallShortcutsScript({
    shortcutName,
    vbsPath,
    workingDir: projectRoot,
    iconLocation,
  });

  const res = spawnSyncFn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodePowerShellCommand(psScript),
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
    }
  );
  if (res.status !== 0) {
    throw new Error(`创建 Windows 快捷方式失败: ${String(res.stderr || res.stdout || '').trim()}`);
  }
  const shortcuts = String(res.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    shortcuts,
    nodePathFile,
    antigravityExe: resolved.exePath,
    iconLocation,
  };
}

export function uninstallWindowsAppEntry({
  stateDir,
  shortcutName = WINDOWS_SHORTCUT_NAME,
  spawnSyncFn = spawnSync,
} = {}) {
  const psScript = buildWindowsRemoveShortcutsScript({ shortcutName });
  const res = spawnSyncFn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodePowerShellCommand(psScript),
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
    }
  );
  const removed = String(res.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const nodePathFile = path.join(stateDir, 'node-path.txt');
  try {
    if (fs.existsSync(nodePathFile)) fs.unlinkSync(nodePathFile);
  } catch {}

  if (res.status !== 0) {
    throw new Error(`删除 Windows 快捷方式失败: ${String(res.stderr || res.stdout || '').trim()}`);
  }
  return { removed };
}

export function getWindowsAppEntryStatus({
  stateDir,
  shortcutName = WINDOWS_SHORTCUT_NAME,
  spawnSyncFn = spawnSync,
} = {}) {
  const nodePathFile = path.join(stateDir, 'node-path.txt');
  const nodePathConfigured = fs.existsSync(nodePathFile);
  if (process.platform !== 'win32') {
    return { installed: false, desktopShortcut: false, startMenuShortcut: false, nodePathConfigured };
  }
  const sName = escapePowerShellSingleQuoted(`${shortcutName}.lnk`);
  const psScript = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$d = Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath('Desktop')) '" + sName + "')",
    "$p = Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath('Programs')) '" + sName + "')",
    'Write-Output ("$d|$p")',
  ].join('\n');
  const res = spawnSyncFn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodePowerShellCommand(psScript),
    ],
    {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    }
  );
  const [desktopRaw = '', programsRaw = ''] = String(res.stdout || '').trim().split('|');
  const desktopShortcut = /^true$/i.test(desktopRaw);
  const startMenuShortcut = /^true$/i.test(programsRaw);
  return {
    installed: (desktopShortcut || startMenuShortcut) && nodePathConfigured,
    desktopShortcut,
    startMenuShortcut,
    nodePathConfigured,
  };
}
