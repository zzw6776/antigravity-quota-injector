# 项目规则

## 版本升级与发布日志

- **每次改动必须升级版本**：工作区每次完成代码、资源、打包或配置交付改动时，必须同步递增应用版本号（默认递增补丁号 `patch`，如 `0.1.1` → `0.1.2`，用户另有指定除外），同步更新 `package.json` 与 `package-lock.json`（含顶层 `version` 与 `packages[""].version`）。
- **同步维护发布日志**：升级版本时必须同步维护 `docs/releases/<package.json版本号>.md`，首行固定为 `# <版本号>`，正文使用中文并至少包含一条面向使用者的具体变更说明（须通过 `npm test` 中的发布日志校验）。
- **合并未发布中间版本说明**：已推送发布的 `docs/releases/*.md` 保留不改；若上一版本号尚未推送发布，再次递增版本时应将未发布中间版本的变更合并整理到最新 `docs/releases/<新版本号>.md` 并移除未发布的中间说明文件，避免残留空跳版本记录。升级版本号与编写发布日志不代表自动获得 `git commit` / `git push` 授权。

## 开发版运行态判定与自动重启

- **改完必查运行态**：每次改动完成后，通过 `node src/cli.mjs doctor`（查看 `singleInstanceStatus`）确认本机当前注入器运行状态。
- **判断是否需要重启开发版**：若当前正在运行开发版（`singleInstanceStatus?.mode === "dev"`），按实际改动范围判断是否需要重启开发版守护进程：
  - **必须重启开发版**：修改了 `package.json` 版本号，或修改了 Node 侧守护进程/启动器/自更新代码（`src/launcher.mjs`、`src/daemon.mjs`、`src/accounts.mjs`、`src/platform.mjs`、`src/proto-metrics.mjs`、`src/single-instance.mjs`、`src/file-logger.mjs`、`src/macos-dev-console.mjs`、`src/app-update/*.mjs`），或运行中的 `singleInstanceStatus.version` / `runtimeIdentity` 与当前工作区不一致。
  - **无需重启守护进程（自动热重载）**：若仅修改前端热注入资源（`src/client-inject.js`、`src/formatting.mjs`、`src/i18n-zh.mjs`、`src/codex-theme.css`）且版本号与 Node 侧代码未变化，守护进程会在轮询周期内自动重算哈希并热更新页面脚本，无需重启进程，仅需核验页面注入版本已刷新。
- **自动热接管重启与核验**：确认需要重启开发版时，直接以常驻后台方式执行开发版启动脚本触发单实例热接管（macOS 执行 `/bin/bash scripts/start-injector-macos.sh`，Windows 执行 `scripts/start-injector-windows.ps1`），**严禁关闭或重启用户的 Antigravity 客户端本体**。重启后必须执行 `node src/cli.mjs doctor` 与 `node src/cli.mjs verify` 核对新 `pid`、`version`、`daemonAlive: true` 及页面注入就绪，不得把源码修改直接当成运行态已生效；若当前未运行开发版（未启动或正在运行 `formal` 正式版），不擅自切换为开发版，说明当前运行状态即可。
