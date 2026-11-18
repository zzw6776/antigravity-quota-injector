@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo [Antigravity Quota] 未检测到 node 命令。
  pause
  exit /b 1
)

node "%~dp0..\src\cli.mjs" uninstall-app
if errorlevel 1 (
  echo.
  echo 卸载失败，请检查上方错误信息。
  pause
  exit /b 1
)

echo.
pause
