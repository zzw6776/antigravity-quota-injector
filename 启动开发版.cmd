@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"
echo Starting Antigravity Quota Injector development version...
echo This window displays startup and runtime logs.
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0scripts\dev-launch-console.ps1"
set "launcherExitCode=%errorlevel%"
echo.
echo Development launcher exited with code %launcherExitCode%.
echo Log: "%LOCALAPPDATA%\Antigravity Quota Injector\Logs\injector.log"
pause
exit /b %launcherExitCode%
