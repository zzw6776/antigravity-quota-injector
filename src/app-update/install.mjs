import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const MACOS_BUNDLE_ID = 'com.zzw6776.antigravity-quota-injector';

export function cleanUpdateEnvironment(environment = process.env) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => !name.startsWith('ANTIGRAVITY_QUOTA_') && name !== 'NODE_OPTIONS'
    )
  );
}

export function resolveInstalledAppPath({
  platform = process.platform,
  execPath = process.execPath,
  existsSyncFn = fs.existsSync,
  readFileSyncFn = fs.readFileSync,
} = {}) {
  if (!execPath) return null;
  if (platform === 'darwin') {
    // Expected layout: <App>.app/Contents/Resources/Antigravity Quota Injector Worker
    const bundlePath = path.posix.resolve(execPath, '..', '..', '..');
    if (!bundlePath.endsWith('.app')) return null;
    const plistPath = path.posix.join(bundlePath, 'Contents', 'Info.plist');
    if (!existsSyncFn(plistPath)) return null;
    try {
      const plist = readFileSyncFn(plistPath, 'utf8');
      if (!plist.includes(MACOS_BUNDLE_ID)) return null;
      return bundlePath;
    } catch {
      return null;
    }
  }

  if (platform === 'win32') {
    const installDir = path.win32.dirname(execPath);
    const exeName = path.win32.basename(execPath).toLowerCase();
    if (exeName !== 'antigravity quota injector.exe') return null;
    return existsSyncFn(execPath) ? installDir : null;
  }

  return null;
}

export async function verifyMacBundle(bundle, asset, { execImpl = execFileAsync, signal } = {}) {
  const plist = path.posix.join(bundle, 'Contents', 'Info.plist');
  const readKey = async (key) =>
    (await execImpl('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { signal })).stdout.trim();

  if (
    (await readKey('CFBundleShortVersionString')) !== asset.version ||
    (await readKey('CFBundleIdentifier')) !== MACOS_BUNDLE_ID
  ) {
    throw new Error('新版本应用标识或版本号不匹配');
  }

  await execImpl('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { signal });

  for (const binPath of [
    path.posix.join(bundle, 'Contents', 'MacOS', 'Antigravity Quota Injector'),
    path.posix.join(bundle, 'Contents', 'Resources', 'Antigravity Quota Injector Worker'),
  ]) {
    const archs = (await execImpl('/usr/bin/lipo', ['-archs', binPath], { signal })).stdout
      .trim()
      .split(/\s+/);
    const expectedArch = asset.arch === 'x64' ? 'x86_64' : 'arm64';
    if (archs.length !== 1 || archs[0] !== expectedArch) {
      throw new Error(`新版本架构不匹配: ${archs.join(' ') || '未知'}`);
    }
  }

  for (const resName of ['AppIcon.icns', 'NODE_LICENSE.txt']) {
    if (!(await stat(path.posix.join(bundle, 'Contents', 'Resources', resName))).isFile()) {
      throw new Error(`新版本缺少资源文件: ${resName}`);
    }
  }
}

export async function verifyWindowsInstallerPE(filePath) {
  const buf = await readFile(filePath);
  const peOffset = buf.length >= 64 ? buf.readUInt32LE(0x3c) : -1;
  if (
    buf.toString('ascii', 0, 2) !== 'MZ' ||
    peOffset < 0 ||
    peOffset + 6 > buf.length ||
    buf.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0' ||
    ![0x14c, 0x8664].includes(buf.readUInt16LE(peOffset + 4))
  ) {
    throw new Error('Windows 安装包不是有效的 PE 可执行文件');
  }
  return true;
}

export async function prepareUpdateArtifact({
  asset,
  downloadPath,
  installedApp,
  updatesDir,
  execImpl = execFileAsync,
  signal,
}) {
  if (asset.platform === 'darwin') {
    const mount = path.posix.join(updatesDir, `mount-${randomUUID()}`);
    await mkdir(mount, { recursive: true });
    const stage = `${installedApp}.update-${randomUUID()}`;
    let attached = false;
    try {
      await execImpl(
        '/usr/bin/hdiutil',
        ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, downloadPath],
        { signal }
      );
      attached = true;
      const bundle = path.posix.join(mount, 'Antigravity Quota Injector.app');
      await verifyMacBundle(bundle, asset, { execImpl, signal });
      await execImpl('/usr/bin/ditto', [bundle, stage], { signal });
      await verifyMacBundle(stage, asset, { execImpl, signal });
      return { stage };
    } catch (err) {
      await rm(stage, { recursive: true, force: true }).catch(() => {});
      throw err;
    } finally {
      if (attached) {
        await execImpl('/usr/bin/hdiutil', ['detach', mount], { timeout: 20_000 }).catch(() => {});
      }
      await rm(mount, { recursive: true, force: true }).catch(() => {});
    }
  }

  await verifyWindowsInstallerPE(downloadPath);
  return { installer: downloadPath };
}

export function buildWindowsUpdateHelperScript() {
  return [
    'param([int]$OldPid, [string]$SetupExe, [string]$InstallDir, [string]$MainExe, [string]$LogFile)',
    "$ErrorActionPreference = 'Stop'",
    'function Write-UpdateLog([string]$msg) {',
    '  try {',
    '    Add-Content -LiteralPath $LogFile -Value ("[" + (Get-Date -Format "o") + "] " + $msg) -Encoding UTF8',
    '  } catch {}',
    '}',
    'try {',
    '  $logDir = Split-Path -Parent $LogFile',
    '  if ($logDir -and (Test-Path -LiteralPath $logDir)) {',
    '    Set-Location -LiteralPath $logDir',
    '  }',
    '  Write-UpdateLog "Waiting for old injector PID $OldPid to exit..."',
    '  $deadline = (Get-Date).AddSeconds(20)',
    '  while ((Get-Date) -lt $deadline) {',
    '    if (-not (Get-Process -Id $OldPid -ErrorAction SilentlyContinue)) { break }',
    '    Start-Sleep -Milliseconds 150',
    '  }',
    '  if (Get-Process -Id $OldPid -ErrorAction SilentlyContinue) {',
    '    Write-UpdateLog "Stopping residual injector PID $OldPid..."',
    '    Stop-Process -Id $OldPid -Force -ErrorAction SilentlyContinue',
    '    Start-Sleep -Milliseconds 300',
    '  }',
    '  Write-UpdateLog "Installing $SetupExe into $InstallDir..."',
    '  $proc = Start-Process -FilePath $SetupExe -ArgumentList @("/S", "/D=$InstallDir") -Wait -PassThru -WindowStyle Hidden',
    '  Write-UpdateLog "Installer exited with $($proc.ExitCode)"',
    '  if ($proc.ExitCode -ne 0) {',
    '    throw "Installer failed with exit code $($proc.ExitCode)"',
    '  }',
    '  Write-UpdateLog "Launching updated injector $MainExe..."',
    '  Start-Process -FilePath $MainExe -WorkingDirectory $InstallDir -WindowStyle Normal',
    '} catch {',
    '  Write-UpdateLog ("Update error: " + $_.Exception.Message)',
    '  if (Test-Path -LiteralPath $MainExe) {',
    '    try { Start-Process -FilePath $MainExe -WorkingDirectory $InstallDir -WindowStyle Normal } catch {}',
    '  }',
    '}',
  ].join('\r\n');
}

function escapePowerShellSingleQuoted(value) {
  return String(value ?? '').replace(/'/g, "''");
}

export function buildWindowsUpdateLauncherVbs({
  helperPath,
  oldPid = process.pid,
  setupExe,
  installDir,
  mainExe,
  logPath,
}) {
  const psInvoke = [
    `& '${escapePowerShellSingleQuoted(helperPath)}'`,
    `-OldPid ${Number(oldPid) || process.pid}`,
    `-SetupExe '${escapePowerShellSingleQuoted(setupExe)}'`,
    `-InstallDir '${escapePowerShellSingleQuoted(installDir)}'`,
    `-MainExe '${escapePowerShellSingleQuoted(mainExe)}'`,
    `-LogFile '${escapePowerShellSingleQuoted(logPath)}'`,
  ].join(' ');
  const encoded = Buffer.from(psInvoke, 'utf16le').toString('base64');
  const cmd = `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
  return `CreateObject("WScript.Shell").Run "${cmd}", 0, False\r\n`;
}

export async function applySelfUpdateAndRelaunch({
  asset,
  installedApp,
  prepared,
  updatesDir,
  onBeforeExit = async () => {},
  execImpl = execFileAsync,
  spawnImpl = spawn,
  exitImpl = (code) => process.exit(code),
  signal,
}) {
  if (!installedApp) {
    throw new Error('未能定位当前已安装的应用路径，无法原地更新');
  }

  if (asset.platform === 'darwin') {
    await rm(installedApp, { recursive: true, force: true });
    await rename(prepared.stage, installedApp);
    await verifyMacBundle(installedApp, asset, { execImpl, signal });

    await onBeforeExit();
    await execImpl('/usr/bin/open', ['-n', installedApp], {
      env: cleanUpdateEnvironment(),
    });
    exitImpl(0);
    return;
  }

  if (asset.platform === 'win32') {
    await mkdir(updatesDir, { recursive: true });
    const helperPath = path.win32.join(updatesDir, 'apply-update.ps1');
    const launcherVbsPath = path.win32.join(updatesDir, 'apply-update.vbs');
    const logPath = path.win32.join(updatesDir, 'updater.log');
    const mainExe = path.win32.join(installedApp, 'Antigravity Quota Injector.exe');
    await writeFile(helperPath, buildWindowsUpdateHelperScript(), 'utf8');
    await writeFile(
      launcherVbsPath,
      buildWindowsUpdateLauncherVbs({
        helperPath,
        oldPid: process.pid,
        setupExe: prepared.installer,
        installDir: installedApp,
        mainExe,
        logPath,
      }),
      'utf8'
    );

    await onBeforeExit();

    const child = spawnImpl('wscript.exe', ['//B', '//Nologo', launcherVbsPath], {
      cwd: updatesDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: cleanUpdateEnvironment(),
    });
    child?.unref?.();
    exitImpl(0);
    return;
  }

  throw new Error(`当前平台暂不支持自动替换安装: ${asset.platform}`);
}
