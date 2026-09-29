# DSH Desktop

一个基于 **Tauri 2** 的 DeepSeek Harness（DSH）桌面端。它不复制或静态打包 DSH 的 Web 前端：应用**总是启动自己托管的 `dsh web` 服务**（仅绑定回环地址，固定端口 `41729`），随后把 Tauri WebView 导航至该地址；不再发现或复用本机已有的 DSH 实例。

桌面端同时把两者做成"一体"：启动时通过 `--patch` overlay 向 DSH 注入自带的面板插件 `dsh-desktop-shell`，于是 **DSH 设置页 → 桌面端** 就是桌面壳自己的设置界面（关闭行为、代理、更新检查、服务端口），并展示桌面端版本、DSH 版本与地址、面板注入状态等运行信息。

## 当前功能

- **总是自启服务**：`dsh web --patch <overlay> --host 127.0.0.1 --port 41729 --no-open`，只绑定回环地址。
- **启动三道闸门**：DSH 版本 ≥ `0.1.2-alpha.2`（浏览器会话认证基线）、`dsh --help` 含 `--patch`、固定端口可用。任一不满足都不启动服务，启动页给出原因并提供「更新 DSH」入口。
- **固定端口、占用即报错**：不退回随机端口；错误信息包含占用进程（`netstat` → PID → 进程名）与两条出路（关闭占用者，或设置 `DSH_DESKTOP_PORT`）。
- **访问面收敛**：依赖 DSH 自身的一次性 token + `dsh-auth` cookie 做浏览器认证；始终 `--no-open`；日志中的认证 token 脱敏；overlay 覆盖 `web-runtime` 强制打印认证地址、禁用自动打开浏览器、去掉 LAN trust。
- **桌面端设置界面在 DSH 里**：设置页「桌面端」可改关闭行为、代理、启动时更新检查开关、下次启动端口；修改保存到桌面壳的 `shell-settings.json`，代理等需要重启 DSH 的设置会在面板标出「有改动需要重启」。
- **重启联动**：面板的「保存并重启 DSH」经 Tauri 事件桥通知桌面壳，用新环境变量重启 DSH 子进程并重新认证导航。
- **运行状态展示**：桌面端版本、DSH 版本与地址、面板注入状态、当前生效代理，以及「检查桌面端更新」按钮。
- 启动中、启动失败和服务日志的桌面原生启动页；失败后可重试。
- 系统托盘：右键菜单为"显示 / 关于 / 退出"；左键托盘图标或"显示"可恢复窗口。
- 关于窗口：桌面端版本、运行方式、DSH 版本与地址、桌面面板状态、桌面端更新检查。
- 单实例：第二次启动只激活现有窗口。
- 窗口状态持久化：自动恢复上次的窗口大小、位置和最大化状态。
- 运行中监测自管的 DSH 子进程；服务退出时自动回到启动页并显示错误与重试。
- 退出应用时回收本应用启动的 DSH 进程（Windows 使用 `taskkill /T /F` 清理进程树）。
- 支持 `DSH_DESKTOP_DSH_COMMAND` 指定 DSH 命令，`DSH_DESKTOP_PORT` 覆盖端口，`DSH_DESKTOP_PLUGIN_PATH` 在开发时直接指定面板插件入口。
- 支持通过 GitHub Releases 检查 DSH Desktop 新版本，并在启动时提示下载和安装；更新包使用 Tauri 签名校验。

## 前置条件

- Node.js 20+（建议使用当前 DSH 所要求的版本）
- pnpm
- Rust stable 与平台所需的 Tauri / WebView 构建依赖
- 可运行的 DSH CLI：`dsh --version` ≥ `0.1.2-alpha.2` 且 `dsh --help` 含 `--patch`

## 开发

```powershell
pnpm install
pnpm tauri dev
```

`pnpm tauri dev` 会启动 Vite 启动页。Tauri 主进程先跑启动闸门，然后拉起自己的 `dsh web`；服务就绪后 WebView 直接导航至 DSH，启动页只在启动与故障恢复时可见。

开发模式下 `bundle.resources` 里的面板插件不一定落在资源目录，可用环境变量直接指定插件入口（生产安装包无需设置）：

```powershell
$env:DSH_DESKTOP_PLUGIN_PATH = "D:\workspace\research\deepseek-harness-desktop\src-tauri\resources\dsh-desktop-shell\index.js"
```

若 `dsh` 不在桌面程序的 `PATH` 中，同样用环境变量指定。Windows 下请指向 `.cmd` 或 `.exe`，不要指向 PowerShell 的 `.ps1` shim：

```powershell
$env:DSH_DESKTOP_DSH_COMMAND = "G:\nodejs\node_global\dsh.cmd"
```

端口被占用时（例如本机另有一个 `dsh web` 在跑）可以换端口：

```powershell
$env:DSH_DESKTOP_PORT = "41800"
```

可参考 [`.env.example`](.env.example)。注意：应用尚未加载 `.env` 文件；请从启动终端或系统环境变量提供这些值。

## 生产构建

```powershell
pnpm build
pnpm tauri build
```

构建结果仍依赖用户环境中的 Node 和 DSH。这是有意保留的边界。

## GitHub 发布与桌面自动更新

使用本地一键发布脚本（参考 `md-editor` 的发布流程）：本机打包（NSIS + MSI，含 updater 签名）→ 生成 `latest.json` → 用 GitHub CLI 创建 Release 并上传资产。桌面程序从 GitHub Releases 的 `latest/download/latest.json` 检查新版本，下载后由 Tauri 验证签名并调用 NSIS 更新安装包。

> 注意：桌面程序在用户机器上以匿名方式读取 Release 文件，因此**仓库必须保持公开**，否则更新检查会因 GitHub 返回 404 而静默失败。

### 首次准备（已完成）

1. 签名密钥对位于 `src-tauri/keys/dsh-desktop.key`（私钥请妥善备份，**严禁提交到 Git**；公钥已写入 `src-tauri/tauri.conf.json`，后续发布必须持续使用同一个私钥，遗失后已安装版本将无法信任新签名）。
2. 安装并登录 [GitHub CLI](https://cli.github.com/)：`winget install GitHub.cli`，然后 `gh auth login`。

### 每次发版

```bash
# 1. 修改版本号（三处保持一致）：
#    src-tauri/tauri.conf.json  ->  version
#    package.json               ->  version
#    src-tauri/Cargo.toml       ->  version

# 2. 一键发布（打包 → 签名 → latest.json → GitHub Release）
bash scripts/release.sh 0.2.9

# 3. 提交推送代码
git add -A && git commit -m "chore: release v0.2.9" && git push
```

发布后，已安装用户打开应用即会收到更新提示。

## 托盘与后台运行

- 默认点击主窗口关闭按钮会隐藏至系统托盘；可在 **DSH 设置 → 桌面端** 改为直接退出。DSH 连接和自管服务会继续运行，直到应用明确退出。
- 左键单击托盘图标，或右键菜单选择"显示"，可恢复并聚焦主窗口。
- 右键菜单的"退出"是明确退出入口，会停止此桌面端所创建的 DSH 子进程。
- 第二次运行 `dsh-desktop.exe` 或 `pnpm tauri dev` 时会恢复已存在实例的窗口，而非启动第二个实例。
- 窗口的尺寸、位置和最大化状态由 `tauri-plugin-window-state` 保存并在下一次启动时恢复。

## 架构

```text
Tauri (Rust)
  ├─ preflight: dsh --version / dsh --help(--patch) / fixed port availability
  ├─ write dsh-overlay.yml  (force web-runtime printUrl/openBrowser/trustedHosts + insert plugin)
  ├─ write desktop-facts.json (desktop version, DSH url/version, panel state)
  ├─ spawn: dsh web --patch <overlay> --host 127.0.0.1 --port 41729 --no-open
  │         env: HTTPS_PROXY/… (optional) + DSH_DESKTOP_BRIDGE_DIR
  ├─ parse the one-time auth URL from stdout, redact tokens in logs, navigate the WebView
  ├─ monitor the child and return to the launcher on failure
  ├─ listen("dsh-desktop-shell")  ← panel actions (settings-changed / restart-dsh / check update)
  ├─ emit_to("main", "dsh-desktop-state") → push state to the panel
  └─ terminate only its own child process tree on explicit app exit

DSH Web (child process)
  └─ dsh-desktop-shell plugin (injected by the overlay, shipped as a Tauri resource)
       ├─ host half: /dsh-desktop-shell/v1/{ping,state,bootstrap,settings}
       │             auth = cookie re-probe against GET /  +  same-origin checks
       └─ client half: settings.section「桌面端」 → reads/writes shell-settings.json via the host half
```

不要将 DSH 的 `apps/web` 单独当成静态站点嵌入 Tauri：DSH Web 服务会在运行时注入其启动配置（例如 `window.__DSH_BOOT__`），桌面端应保持对官方服务入口的使用。

## 安全边界

- 仅绑定回环地址 `127.0.0.1`；不提供局域网访问。
- 服务访问面依赖 DSH 自身的浏览器会话认证（一次性 token → `dsh-auth-*` HttpOnly/SameSite=Strict cookie）；未拿到认证地址的 DSH 会被**拒绝启动**。
- 日志中的 `?token=…` 一律脱敏，认证地址不写入文件、通知或剪贴板。
- 面板插件的 HTTP API 不受 DSH 认证保护（DSH 只在首页与 `/api` 上做认证），因此插件自行做：Cookie 回探 `GET /` 认证、同源校验、写操作一次性 token + JSON 限制。以同一用户身份运行的本地进程不在防御范围内（它本来就能直接读写设置文件）。
- 面板 → 桌面壳只走 Tauri **事件**（`core:event:default`），动作白名单固定、不带参数；不新增任何可执行任意命令或读写任意路径的命令。
- 当前端导航到 DSH 地址后，页面由 DSH 自己提供；Tauri 启动页的 CSP 不应被误认为是 DSH 页面的安全策略。
- 端口预检与子进程实际绑定之间存在理论竞争窗口；实际失败会以子进程退出体现，启动页显示错误并可重试。

## 项目布局

- `src-tauri/src/lib.rs`：启动闸门与固定端口、overlay/facts 注入、DSH 子进程、令牌脱敏、托盘、关于/更新浮层窗口、状态与 Tauri 命令、面板事件桥。
- `src-tauri/resources/dsh-desktop-shell/`：随安装包分发的 DSH 面板插件（`index.js` host 半、`client.js` client 半）。
- `src-tauri/tauri.conf.json`：Tauri 窗口、安装包资源与 Windows EXE 版本元数据。
- `src/main.ts`：启动/错误页、关于窗口与 WebView 导航逻辑。
- `src/styles.css`：启动页样式。
- `docs/desktop-dsh-integration.md`：一体化设计、安全模型与实测结论。
