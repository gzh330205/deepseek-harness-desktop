# DSH Desktop Agent 指南

## 0. 先读这一节：仓库里现在有**两个**桌面壳

**在跑的是 Electron 壳**（`electron/`，v0.3.6 起为 `releases/latest`），Tauri 壳（`src-tauri/`，v0.2.31）是**待退役的旧版**。

| | Electron 壳（当前） | Tauri 壳（旧版） |
|---|---|---|
| 代码 | `electron/` | `src-tauri/` + `src/` + `index.html` |
| 版本来源 | **`electron/package.json` 一处** | `package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` **三处必须同步** |
| 发布 | `electron/scripts/release-electron.mjs` | `scripts/release.sh` |
| 文档 | `docs/tauri-to-electron-migration.md`、`electron/README.md` | 本文件第 2–5 节 |
| dsh 运行时 | **随包**（`resources/runtime/dsh`，见 `docs/electron-runtime-bundling.md`） | 依赖机器上已装的 `dsh` |

- **为什么还留着 Tauri 壳**：已安装的旧版要靠它自己的更新器完成迁移（旧版检查更新 → 下载 Electron 安装包 → 静默安装 → 启动新版 → 新版提示卸载旧版）。它同时是面板插件资源的所在（`src-tauri/resources/dsh-desktop-shell/`，两个壳共用），所以**在旧版退役前不要删 `src-tauri/`**，也不要移动该插件目录。
- **改动要落在正确的壳上**：用户可见的功能改 `electron/`；`src-tauri/` 只做维持旧版能跑完迁移的最小改动。
- **本文件第 2–5 节描述的是旧版 Tauri 壳的规范**，其中「三处版本同步」「`scripts/release.sh`」等规则**不适用于 Electron 壳**；Electron 壳的规范在 `electron/README.md` 的「本项目特有的坑」一节。

## 1. 项目概述（Tauri 壳，旧版）

基于 **Tauri 2**（Rust 外壳 + Vite/TypeScript 前端）的 DeepSeek Harness（DSH）桌面端。应用**总是启动自己托管的 DSH Web 服务**（仅 loopback，固定端口 `41729`，可用环境变量 `DSH_DESKTOP_PORT` 覆盖），随后把 WebView 导航至该地址；不再发现或复用本机已有的 DSH 实例。启动前先过三道闸门——DSH 版本 ≥ 认证基线、`dsh --help` 含 `--patch`、固定端口可用——任一不满足都不启动服务，并在启动页给出原因与升级入口。桌面端还会通过 `--patch` overlay 向 DSH 注入自带的面板插件 `dsh-desktop-shell`：**DSH 设置页 → 桌面端** 就是桌面壳的设置界面，设置的真相源是桌面壳的 `shell-settings.json`。仓库：`https://github.com/gzh330205/deepseek-harness-desktop`（**必须保持公开**，桌面程序的自动更新依赖匿名下载 Release 资产）。

## 2. 关键约束（改动前必读）

- **版本号三处必须同步递增**：`package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` 中的 `version` 字段必须完全一致。
- **每次功能或构建变更必须递增 patch 版本**（如 `0.2.7 → 0.2.8`），**禁止重复使用已发布过的版本号**（GitHub Release 按标签唯一）。
- **签名私钥 `src-tauri/keys/dsh-desktop.key` 严禁提交到 Git**（已写入 `.gitignore`）；公钥已写入 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`。私钥遗失后，已安装版本将无法信任新签名，更新将不可用。
- **只连接/绑定 loopback（127.0.0.1 / ::1）**，不得改为局域网绑定，除非用户明确要求；DSH 的浏览器会话认证（一次性 token + `dsh-auth` cookie）是本机访问面的主要防线。
- **固定端口 41729，端口被占用即报错**：不退回随机端口。错误信息必须给出占用者（`netstat` → PID → 进程名）与两条出路（关闭占用者，或设置 `DSH_DESKTOP_PORT`）。设置文件 `service.port` 参与端口选择，优先级为 env > 设置文件 > 默认值。
- **启动必过三道闸门**：① `dsh --version` ≥ `MINIMUM_DSH_VERSION`（浏览器认证基线 `0.1.2-alpha.2`）；② `dsh --help` 含 `--patch`；③ 固定端口可用。任一不通过都不 spawn，状态置为 `updateRequired`，启动页显示「更新 DSH」。
- **overlay 注入顺序固定**：`dsh web --patch <overlay> --host … --port … --no-open`。`--patch` 是启动器级选项，**必须排在 web app 自己的参数之前**；放在 `--host` 之后会被透传并报 `unknown option '--patch'`。
- **日志中的认证 token 必须脱敏**：DSH 会把一次性认证地址（`?token=…`）打印到 stdout，`redact_auth_token` 负责把它变成 `token=***`；认证地址不得写入文件、通知或剪贴板。
- **面板桥 API 的防护**：`webServer.register` 注册的路由**不受** DSH 认证保护，因此插件对除 `/ping` 外的所有端点都做「Cookie 回探 `GET /`」认证 + 同源校验（拒绝 `Sec-Fetch-Site: cross-site`），写操作还要求一次性 bootstrap token 与 `application/json`。
- **客户端插件必须 fail-loud 安全**：client 半的 `apply` 若抛错或长时间 pending，整个 DSH 页面会变成 `Failed to load plugins`。必须全程 try/catch、只 inject 标准 web 组合里必然存在的服务、任何失败都降级为「无面板」。
- 应用图标使用 `src-tauri/icons/whale-original.png` 及其派生资产，不要替换。
- 主窗口 `dragDropEnabled` 必须保持 `false`（Windows 下 Tauri 原生拖拽会拦截前端 HTML5 drag/drop）。
- **只保留「关于」一个原生辅助窗口**（固定尺寸、不可最大化、只留标题栏关闭按钮）；桌面设置窗口已删除，设置统一走 DSH 设置页的「桌面端」页，不要在关于窗口内加设置表单或更新内容。
- 更新顺序：启动前置门禁通过 → 启动 DSH 服务 → 进入 DSH 页面后先静默检查桌面更新（检查期间不弹窗，仅发现新版本时弹出居中的 `desktop-update` 窗口，下载安装期间锁定主窗口）→ 桌面无更新或用户选择“暂不更新”后才检查 DSH 更新（同样静默检查，有更新则弹出居中的 `dsh-update-prompt` 窗口询问是否更新；用户选择更新后，右下角 `update-overlay` 无边框小窗口显示更新进度，更新完成后再回到居中弹窗询问立即重启或稍后重启；更新期间不阻塞 DSH 使用）。两个启动检查的开关由 DSH 面板的 `updates.checkDesktopOnStart` / `updates.checkDshOnStart` 控制。
- 启动时主窗口保持 `visible: false`，由前端 `show_launcher` 命令在首帧绘制后显示，避免空白窗口。
- Windows 下所有子进程（dsh.cmd、netstat、taskkill 等）必须使用 `CREATE_NO_WINDOW` 隐藏控制台窗口。

## 3. 发版规范（GitHub Release + 自动更新）

发布采用**本地一键脚本**（参考 md-editor 的发布流程）：本机打包（NSIS + MSI，含 updater 签名）→ 生成 `latest.json` → 用 GitHub CLI 创建 Release 并上传资产。桌面程序启动时从 `https://github.com/gzh330205/deepseek-harness-desktop/releases/latest/download/latest.json` 检查新版本，用户确认后下载、验签并静默安装（Tauri updater 插件）。

### 3.1 前置条件（一次性）

- 已安装并登录 GitHub CLI：`winget install GitHub.cli`、`gh auth login`。
- 签名密钥存在（默认 `src-tauri/keys/dsh-desktop.key`，可用环境变量 `DSH_DESKTOP_SIGNING_KEY_PATH` 覆盖）。
- 仓库保持公开。

### 3.2 每次发版步骤（严格按序）

> **每次发布必须附上改动内容**：在 `scripts/release.sh` 的 `--notes` 中写明本次新增功能、修复的 bug、交互调整等（用户可见的说明），模板见 3.2 第 2 步。禁止发布"仅版本号"的空说明。

```bash
# 1. 同步修改三处版本号（必须一致，且高于上一个已发布版本）：
#    package.json               ->  "version": "0.2.8"
#    src-tauri/Cargo.toml       ->  version = "0.2.8"
#    src-tauri/tauri.conf.json  ->  "version": "0.2.8"

# 2. 更新 scripts/release.sh 中 gh release create 的 --notes 内容：
#    格式固定为「## 本次更新」+ 分条列出改动（- **功能**：… / - **修复**：…）
#    + 「## 使用」+ 下载/更新提示。示例：
#      **DSH Desktop v$VERSION**
#      ## 本次更新
#      - **新增**：xxx
#      - **修复**：xxx
#      ## 使用
#      下载 **$ASSET_NAME** 安装；已安装用户重启应用即可收到自动更新。

# 3. 一键发布（脚本内部：版本一致性检查 → pnpm tauri build（NSIS+MSI 签名产物）
#    → 生成 latest.json → gh release create v0.2.8 并上传 4 个资产，notes 取第 2 步内容）
bash scripts/release.sh 0.2.8

# 4. 提交并推送代码（注意 git add -A 前清理测试残留文件，避免把日志等误提交）
git add -A && git commit -m "chore: release v0.2.8" && git push
```

### 3.3 发布脚本行为（scripts/release.sh）

1. **版本一致性检查**：`tauri.conf.json`、`package.json`、`Cargo.toml` 三处版本必须等于传入参数，否则退出。
2. **打包**：`pnpm tauri build`（`bundle.targets = "all"`），产出 NSIS `DSH Desktop_<版本>_x64-setup.exe` 与 MSI `DSH Desktop_<版本>_x64_en-US.msi` 及各自 `.sig` 签名文件。
3. **生成 `latest.json`**：写入版本、Release 页 notes、签名与安装包 URL。注意 GitHub 上传资产时会把文件名中的空格替换为点号（`DSH Desktop_…` → `DSH.Desktop_…`），清单 URL 必须用规范化后的名字，否则下载 404。
4. **发布**：`gh release create v<版本>` 上传 NSIS、NSIS.sig、MSI、latest.json 四个资产，标题 `v<版本>`，附 `--notes` 中的改动说明。

### 3.4 发布后必做验证

```bash
# 更新清单匿名可访问，且 version 为新版本：
curl -sL https://github.com/gzh330205/deepseek-harness-desktop/releases/latest/download/latest.json

# 清单内 url 字段指向的安装包匿名可下载（应返回 200）：
curl -sIL "<清单中的 url>"
```

- 确认 Release 页存在且资产完整：`gh release view v0.2.8 --repo gzh330205/deepseek-harness-desktop`。
- 确认 `latest.json` 中的 `signature` 与 `url` 配套（同一构建产物），否则用户端验签失败。
- 确认 Release 页 notes 已包含本次改动内容；若描述有误可用 `gh release edit v<版本> --notes "…"` 修正（仅改说明元数据，不动资产）。

### 3.5 注意事项

- **发布必须使用 `scripts/release.sh` 一键脚本**（它会配置签名环境并产出签名产物 + latest.json + Release）；不要单独执行 `pnpm tauri build` 或 `cargo build --release` 手动拼装——缺少签名环境变量会失败，且不会走发布流程。
- **禁止**手动修改已发布 Release 的资产后重新上传同名文件；如需修复请递增版本重新发布。
- **禁止发布重复版本号**（GitHub Release 按标签唯一）；每版必带改动说明。
- 自动更新仅对 NSIS 安装包生效；MSI 安装的用户需手动下载新版。
- 若密钥文件被删除或更换，`tauri.conf.json` 中的公钥必须同步更换，且所有已安装用户将收不到更新（旧密钥验签失败）。
- `.github/workflows/ci.yml` 仅做构建校验（pnpm build + cargo check），不负责发布；发布通道只有 `scripts/release.sh`。

## 4. 常用命令

```bash
pnpm install           # 安装前端依赖
pnpm tauri dev         # 开发模式（Vite 热更新 + Rust）
pnpm build             # 仅前端构建（tsc --noEmit + vite build）
pnpm tauri build       # 完整打包（NSIS + MSI + 签名产物）
bash scripts/release.sh <version>   # 一键发布（见第 3 节）
```

## 5. 关键文件

- `src-tauri/src/lib.rs`：DSH 子进程管理、启动三道闸门与固定端口、overlay/facts 注入与令牌脱敏、托盘、关于/更新浮层窗口、Tauri 命令与 DSH 面板事件桥、update 状态机。
- `src-tauri/resources/dsh-desktop-shell/`：随安装包分发的 DSH 面板插件（`index.js` host 半：事实/设置读写 API；`client.js` client 半：DSH 设置页「桌面端」）。经 `--patch` overlay 注入，不写用户 profile。
- `src-tauri/tauri.conf.json`：窗口、`bundle.resources`（含面板插件）、NSIS 配置、updater 公钥与端点、版本号。
- `src/main.ts`：启动页/错误页、WebView 导航、关于窗口的运行状态展示；进入 DSH 前触发桌面更新检查窗口。（桌面设置窗口已删除，设置统一在 DSH 设置页「桌面端」。）
- `docs/desktop-dsh-integration.md`：桌面端与 DSH 一体化的设计、安全模型与 P0 实测结论。
- `dsh-update-prompt.html` + `src/dsh-update-prompt.ts`：DSH 更新的居中询问弹窗（发现新版本询问是否更新 → 更新完成后询问立即/稍后重启）。
- `update-overlay.html` + `src/update-overlay.ts`：DSH 更新进行中右下角的进度浮层。
- `scripts/release.sh`：一键发布脚本（发版入口）。
- `src-tauri/keys/`：签名密钥（私钥勿提交，公钥入库）。
