param([switch]$Console)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$localAppDataRoot = if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  Join-Path $HOME "AppData\Local"
} else {
  $env:LOCALAPPDATA
}
$logRoot = Join-Path $localAppDataRoot "Antigravity Quota Injector\Logs"
$bootstrapLog = Join-Path $logRoot "launcher.log"
$stdoutLog = Join-Path $logRoot "injector-stdout.log"
$stderrLog = Join-Path $logRoot "injector-stderr.log"

New-Item -ItemType Directory -Path $logRoot -Force | Out-Null

foreach ($name in @("ANTIGRAVITY_QUOTA_ROLE", "ANTIGRAVITY_QUOTA_UPDATE_CONTROL")) {
  Remove-Item -LiteralPath "Env:$name" -Force -ErrorAction SilentlyContinue
}

function Write-LauncherLog([string]$message) {
  Add-Content -LiteralPath $bootstrapLog -Value "$(Get-Date -Format o) $message" -Encoding UTF8
  if ($Console) {
    Write-Host $message
  }
}

try {
  Write-LauncherLog "Starting Windows development launcher"

  $projectNode = Join-Path $projectRoot "build\node-runtimes\node-v22.23.1-win-x64\node.exe"
  if (Test-Path -LiteralPath $projectNode) {
    $nodeExecutable = $projectNode
  } else {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) {
      throw "Node.js >= 22.13.0 was not found"
    }
    $nodeExecutable = $nodeCommand.Path
    $verOut = (& $nodeExecutable -e "const [ma,mi]=process.versions.node.split('.').map(Number); console.log(process.version); process.exit((ma>22||(ma===22&&mi>=13))?0:1)" 2>&1)
    if ($LASTEXITCODE -ne 0) {
      throw "Windows development launcher requires Node.js >= 22.13.0, found $verOut"
    }
  }

  $env:ANTIGRAVITY_QUOTA_EXPLICIT_START = "1"
  Remove-Item -LiteralPath $stdoutLog, $stderrLog -Force -ErrorAction SilentlyContinue

  $launcher = Join-Path $projectRoot "src\launcher.mjs"
  $process = Start-Process `
    -FilePath $nodeExecutable `
    -ArgumentList @("`"$launcher`"", "--explicit-start") `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru

  Write-LauncherLog "Injector started in background; PID=$($process.Id); Node=$nodeExecutable"
} catch {
  Write-LauncherLog "Launcher failed: $($_.Exception.Message)"
  Write-LauncherLog ($_ | Out-String)
  exit 1
}
