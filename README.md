# DSH Desktop

一个基于 **Tauri 2** 的 DeepSeek Harness（DSH）桌面端 MVP。它不复制或静态打包 DSH 的 Web 前端；应用启动时会先发现并验证本机已有的 DSH Web 服务，只有未找到时才启动真正的 `dsh web` 服务，随后将 Tauri WebView 导航至该 loopback 地址。

## 当前功能

- 启动时先扫描 Windows 的本机 loopback TCP 监听端口，验证后复用已运行的 DSH Web 服务。
- 复用验证要求首页是 HTML，且同时具有 DSH 注入标记 `window.__DSH_BOOT__`、DSH client connection entry 与 `/plugins/` 资源路径；普通本地 Web 服务不会被误用。
- 若没有已验证的服务，执行 `dsh web --host 127.0.0.1 --port <随机空闲端口>`。
- 仅连接或绑定回环地址，避免意外暴露 Web 服务到局域网。
- 通过 HTTP DSH 指纹探测等待服务就绪，再在同一 Tauri WebView 中打开 DSH。
- 启动中、启动失败和服务日志的桌面原生启动页。
- 失败后可在启动页重试；重试也优先复用发现的服务。
- 系统托盘：右键菜单使用精简的“显示 / 设置 / 关于 / 退出”；左键托盘图标或“显示”可恢复窗口。
- 桌面壳设置：可选择关闭主窗口时“最小化到托盘”或“退出应用”，设置保存到用户配置目录并在下次启动时恢复。
- 关于窗口：显示 DSH Desktop 版本和运行方式。
- 单实例：第二次启动只会激活现有窗口，不会重复创建 DSH Desktop 或另起一个自管 DSH 服务。
- 窗口状态持久化：自动恢复上次的窗口大小、位置和最大化状态。
- 运行中监测自管子进程和复用的外部 DSH 服务；服务失效时自动回到启动页，显示错误并提供重试。
- 退出应用时只回收本应用启动的 DSH 进程；不会停止复用的外部服务。Windows 使用 `taskkill /T /F` 清理自管服务的进程树。
- 支持 `DSH_DESKTOP_DSH_COMMAND` 指定 DSH 命令或可执行文件位置，`DSH_DESKTOP_URL` 指定优先复用的 loopback DSH URL。
- 支持通过 GitHub Releases 检查 DSH Desktop 新版本，并在启动时提示下载和安装；更新包使用 Tauri 签名校验。

## 前置条件

- Node.js 20+（建议使用当前 DSH 所要求的版本）
- pnpm
- Rust stable 与平台所需的 Tauri / WebView 构建依赖
- 可运行的 DSH CLI：`dsh web --help`

该 MVP 的运行策略是“使用系统已安装的 DSH”。正式发行版可在下一阶段改为携带固定版本的 Node runtime 与 DSH 资源。

## 开发

```powershell
pnpm install
pnpm tauri dev
```

`pnpm tauri dev` 会启动 Vite 的启动页。Tauri 主进程会先扫描并严格验证本机已运行的 DSH Web；发现后直接复用，不会再创建 DSH 子进程。若未发现服务，才由主进程启动 DSH Web。服务就绪后 WebView 会直接导航至 DSH，所以启动页仅在服务启动和故障恢复时可见。

若 `dsh` 不在桌面程序的 `PATH` 中，设置环境变量。Windows 下请指向 `.cmd` 或 `.exe`，不要指向 PowerShell 的 `.ps1` shim：

```powershell
$env:DSH_DESKTOP_DSH_COMMAND = "G:\nodejs\node_global\dsh.cmd"
pnpm tauri dev
```

要固定复用某一个已启动服务，可选地提供其 loopback URL（仍会通过 DSH 页面指纹验证，非 DSH 服务会被拒绝）：

```powershell
$env:DSH_DESKTOP_URL = "http://127.0.0.1:3080"
pnpm tauri dev
```

可参考 [`.env.example`](.env.example)。注意：本 MVP 尚未加载 `.env` 文件；请从启动终端或系统环境变量提供这些值。

## 生产构建

```powershell
pnpm build
pnpm tauri build
```

构建结果仍依赖用户环境中的 Node 和 DSH。这是有意保留的 MVP 边界。

## GitHub 发布与桌面自动更新

推送 `v<版本号>` 标签会触发 [`.github/workflows/release.yml`](.github/workflows/release.yml)：它在 Windows runner 上构建 NSIS 安装包、生成签名和 `latest.json`，随后创建同名 GitHub Release。桌面程序从 GitHub Releases 的 `latest/download/latest.json` 检查新版本，下载后由 Tauri 验证签名并调用 NSIS 更新安装包。

> 注意：桌面程序在用户机器上以匿名方式读取 Release 文件，因此**仓库必须保持公开**，否则更新检查会因 GitHub 返回 404 而静默失败。

首次启用前，请在 GitHub 仓库 **Settings → Secrets and variables → Actions** 设置以下 Actions secrets：

- `TAURI_SIGNING_PRIVATE_KEY`：本机 `src-tauri/keys/dsh-desktop.key` 的完整内容；严禁提交到 Git。
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：私钥密码；当前生成的私钥未设置密码时可留空，建议后续重新生成有密码的密钥后再设置。

公钥已经写入 `src-tauri/tauri.conf.json`，因此后续发布必须持续使用同一个私钥。私钥遗失后，已安装版本将无法信任用新密钥签名的自动更新。

发布示例：

```powershell
# 将三个 version 字段同步更新至下一版本后：
git add .
git commit -m "release: v0.2.6"
git tag v0.2.6
git push origin master --tags
```

产品化发布前建议：

1. 将匹配平台的 Node runtime 作为 Tauri resource/sidecar 打包；
2. 将固定版本的 DSH CLI 与依赖一起打包；
3. 由 Rust 使用资源目录中的 Node 启动 DSH CLI；
4. 为 DSH 版本升级和安全更新增加应用更新策略；
5. 以原生文件能力、独立 runtime 打包和自动更新完善桌面发行体验。

## 托盘与后台运行

- 默认点击主窗口关闭按钮会隐藏至系统托盘；可在“设置”中改为直接退出。DSH 连接和自管服务会继续运行，直到应用明确退出。
- 左键单击托盘图标，或右键菜单选择“显示”，可恢复并聚焦主窗口。
- 右键菜单的“退出”是明确退出入口，会停止此桌面端所创建的 DSH 子进程。
- 第二次运行 `dsh-desktop.exe` 或 `pnpm tauri dev` 时会恢复已存在实例的窗口，而非启动第二个实例。
- 窗口的尺寸、位置和最大化状态由 `tauri-plugin-window-state` 保存并在下一次启动时恢复。

## 架构

```text
Tauri (Rust)
  ├─ enumerate loopback TCP listeners (Windows)
  ├─ fingerprint candidate HTML for DSH boot markers
  ├─ reuse verified external DSH Web, or reserve a loopback port
  ├─ spawn: dsh web --host 127.0.0.1 --port <port> when no match exists
  ├─ collect stdout/stderr + HTTP readiness/fingerprint probe
  ├─ monitor the selected DSH service and return to launcher on failure
  ├─ keep the app resident with tray + single-instance + persisted window state
  ├─ navigate the existing WebView to the selected loopback URL
  └─ terminate only its own child process tree on explicit app exit

DSH Web
  └─ serves the actual DSH GUI and its runtime boot configuration
```

不要将 DSH 的 `apps/web` 单独当成静态站点嵌入 Tauri：DSH Web 服务会在运行时注入其启动配置（例如 `window.__DSH_BOOT__`），桌面端应保持对官方服务入口的复用。

## 安全边界

- 仅接受 `127.0.0.1` 或 `::1` 上的候选服务；`DSH_DESKTOP_URL` 也必须为 loopback URL。
- 发现逻辑不会因 HTTP 200 而盲目信任端口，必须命中多个 DSH 特有的运行时 boot 标记。
- 桌面端绝不终止复用的外部服务；仅管理自身创建的子进程。
- 未发现服务时，桌面端为自管服务选择空闲端口，减少固定端口冲突。
- 当前端导航到 DSH 地址后，页面由 DSH 自己提供；Tauri 启动页的 CSP 不应被误认为是 DSH 页面的安全策略。
- 端口选择与绑定之间理论上存在竞争窗口。后续若 DSH 支持由预绑定 socket 接管或稳定的 `--port 0` 机器可读就绪输出，应优先迁移到该机制。

## 项目布局

- `src-tauri/src/lib.rs`：DSH 子进程、托盘、桌面壳设置、关于窗口、状态、日志、健康检查与 Tauri 命令。
- `src-tauri/tauri.conf.json`：Tauri 窗口、安装包和 Windows EXE 版本元数据。
- `src/main.ts`：启动/错误页、桌面壳设置/关于页面及 WebView 导航逻辑。
- `src/styles.css`：启动页样式。
