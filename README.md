# Antigravity Quota Injector

为 macOS 和 Windows 版 Antigravity 桌面客户端提供无侵入 CDP 运行时注入，支持双端独立应用入口、GitHub Releases 自动打包与原地自动更新：

1. **每轮对话底部 Token 摘要**：只读解析 `~/.gemini/antigravity/conversations/<cascadeId>.db`，在每轮回复底部展示 `本轮 Token · 缓存命中率 · 累计 · 首字 · 速率`，悬停展示输入/缓存/思考链/正文与工具调用明细。
2. **输入框右下角上下文与额度胶囊**：在 `Turbo v` 左侧注入当前会话上下文占用/上限与实时额度（如 `138k/256k`、`95%/99%`），对话期间自动刷新额度，悬停展开全部分组额度与重置倒计时，点击固定面板可一键切换已保存账号或点击底部版本号检查更新。
3. **无重启原地自动更新**：由于只通过 CDP 注入页面、不修改客户端本体，正式版检测到 GitHub Releases 新版本后会自动在后台预下载并校验 SHA-256，点击面板底部的版本号提示（如 `v0.1.0 → v0.1.1`）即可原地替换注入器并重新注入，全程**不重启 Antigravity**。
4. **跟随主应用退出**：无论是正式版入口还是开发版入口，退出 Antigravity 后注入器都会自动退出，不做开机自启动、不驻留后台。

## 安装与使用（正式版，无需预装 Node.js）

### macOS

1. 从 [GitHub Releases](https://github.com/zzw6776/antigravity-quota-injector/releases) 下载对应架构的安装包：Apple Silicon 选择 `Antigravity-Quota-Injector-<版本号>-macos-arm64.dmg`，Intel Mac 选择 `Antigravity-Quota-Injector-<版本号>-macos-x64.dmg`。
2. 打开 DMG，将 `Antigravity Quota Injector.app` 拖入“应用程序”。
3. 双击 `Antigravity Quota Injector`：
   - 若 Antigravity 未打开，会自动拉起 Antigravity 并开始注入；
   - 若 Antigravity 已打开，会直接附着注入；
   - 退出 Antigravity 后，注入器与包装应用会自动退出。

> 当前自动构建使用 ad-hoc 签名，首次打开若被 Gatekeeper 拦截，可在“系统设置 → 隐私与安全性”中点击“仍要打开”。

### Windows

1. 从 [GitHub Releases](https://github.com/zzw6776/antigravity-quota-injector/releases) 下载 `Antigravity-Quota-Injector-<版本号>-windows-x64-Setup.exe`。
2. 运行安装程序（默认安装到 `%LOCALAPPDATA%\Programs\Antigravity Quota Injector`，仅创建桌面与开始菜单快捷方式，**不设置开机自启动**）。
3. 双击桌面或开始菜单中的 `Antigravity Quota Injector`（无黑窗）：
   - 若 Antigravity 未打开，会自动拉起 `Antigravity.exe` 并开始注入；
   - 若 Antigravity 已打开，会直接附着注入；
   - 关闭 Antigravity 后，注入器自动退出。

> 若 Antigravity 安装在非默认便携目录导致未自动识别，可在 `%USERPROFILE%\.gemini\antigravity\quota-injector\config.json` 中添加 `{"antigravityExe": "D:\\Tools\\Antigravity\\Antigravity.exe"}`。
> 说明：多账号快照与一键切号依赖 macOS Keychain，Windows 上会保留该区域 UI 并禁用操作按钮，提示“Windows 暂不支持账号快照与一键切换”。

## 本地开发与调试

需要 Node.js `>= 22.13.0`：

- **macOS 开发入口**：双击根目录的 [启动开发版.app](启动开发版.app) 或 [启动开发版.command](启动开发版.command)（打开终端实时查看日志；开发版启动后会自动接管并替换正在运行的正式版，且退出终端仅停止看日志不影响注入；打开正式版 `.app` 时会自动接管开发版并关闭开发日志终端）。
- **Windows 开发入口**：双击根目录的 [启动开发版.cmd](启动开发版.cmd)（弹出日志控制台并后台启动开发版，自动替换正在运行的正式版）；也可运行 [windows/install-entry.cmd](windows/install-entry.cmd) 创建源码模式的无黑窗桌面快捷方式。

常用开发命令：

```bash
# 运行全部单元测试
npm test

# 运行本地开发版接管与跟随退出测试脚本（加 --live 可顺带验证本机运行中的 Antigravity）
npm run test:dev-launch

# 直接以开发模式启动（自动接管正式版）
npm run launch

# 状态诊断与页面注入校验
npm run doctor
npm run verify
```

## GitHub 自动打包与发布

工作流位于 [.github/workflows/build-packages.yml](.github/workflows/build-packages.yml)：

- 推送到 `master` / `main` 或 `v*` 标签（以及手动 `workflow_dispatch`）时：
  1. 在 `ubuntu-latest`、`macos-latest`、`windows-latest` 三端运行单元测试；
  2. 校验 `docs/releases/<package.json version>.md` 更新日志；
  3. 分别打包 `macos-arm64.dmg`、`macos-x64.dmg`、`windows-x64-Setup.exe`（Windows CI 中执行静默安装、快捷方式/非自启校验与卸载冒烟测试）；
  4. 生成包含 SHA-256 摘要的 `update.json` 清单，并发布为 GitHub Latest Release。

## 日志目录

- macOS：`~/Library/Logs/Antigravity Quota Injector/injector.log`
- Windows：`%LOCALAPPDATA%\Antigravity Quota Injector\Logs\injector.log`
