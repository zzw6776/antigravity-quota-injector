@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo [Antigravity Quota] 未检测到 node 命令，请先安装 Node.js ^>= 22.13.0。
  pause
  exit /b 1
)

node "%~dp0..\src\cli.mjs" install-app
if errorlevel 1 (
  echo.
  echo 安装失败，请检查上方错误信息。
  pause
  exit /b 1
)

echo.
echo 完成。你现在可以从桌面或开始菜单双击 "Antigravity Quota" 手动启动。
pause
