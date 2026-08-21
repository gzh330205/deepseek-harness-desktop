# DSH Desktop Agent 指南

## 1. 项目概述

基于 **Tauri 2**（Rust 外壳 + Vite/TypeScript 前端）的 DeepSeek Harness（DSH）桌面端。应用启动时发现并验证本机已有的 DSH Web 服务（仅 loopback），未找到时才启动 `dsh web --host 127.0.0.1 --port <随机端口>`，随后将 WebView 导航至该地址。仓库：`https://github.com/gzh330205/deepseek-harness-desktop`（**必须保持公开**，桌面程序的自动更新依赖匿名下载 Release 资产）。

## 2. 关键约束（改动前必读）

- **版本号三处必须同步递增**：`package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` 中的 `version` 字段必须完全一致。
- **每次功能或构建变更必须递增 patch 版本**（如 `0.2.7 → 0.2.8`），**禁止重复使用已发布过的版本号**（GitHub Release 按标签唯一）。
- **签名私钥 `src-tauri/keys/dsh-desktop.key` 严禁提交到 Git**（已写入 `.gitignore`）；公钥已写入 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`。私钥遗失后，已安装版本将无法信任新签名，更新将不可用。
- **只连接/绑定 loopback（127.0.0.1 / ::1）**，不得改为局域网绑定，除非用户明确要求。
- **优先固定 3080 端口启动 DSH**（`PREFERRED_DSH_PORT`），仅在占用时回退随机端口：DSH 页面 localStorage 按 origin（含端口）隔离，固定端口保证其跨启动复用。
- 应用图标使用 `src-tauri/icons/whale-original.png` 及其派生资产，不要替换。
- 主窗口 `dragDropEnabled` 必须保持 `false`（Windows 下 Tauri 原生拖拽会拦截前端 HTML5 drag/drop）。
- 设置/关于为固定尺寸、不可最大化的原生辅助窗口，只保留标题栏原生关闭按钮；不要重新加入页面内关闭按钮。
- 更新顺序固定为：打开应用先启动 DSH Web 服务 → 进入 DSH 页面后先检查桌面更新（有更新则弹出居中的 `desktop-update` 窗口，下载安装期间锁定主窗口）→ 桌面无更新或用户选择“暂不更新”后才检查 DSH 更新（有更新则弹出居中的 `dsh-update-prompt` 窗口询问是否更新；用户选择更新后，右下角 `update-overlay` 无边框小窗口显示更新进度，更新完成后再回到居中弹窗询问立即重启或稍后重启；更新期间不阻塞 DSH 使用）；不要在设置/关于窗口内显示更新内容。
- 启动时主窗口保持 `visible: false`，由前端 `show_launcher` 命令在首帧绘制后显示，避免空白窗口。
- Windows 下所有子进程（dsh.cmd、netstat、taskkill 等）必须使用 `CREATE_NO_WINDOW` 隐藏控制台窗口。

## 3. 发版规范（GitHub Release + 自动更新）

发布采用**本地一键脚本**（参考 md-editor 的发布流程）：本机打包（NSIS + MSI，含 updater 签名）→ 生成 `latest.json` → 用 GitHub CLI 创建 Release 并上传资产。桌面程序启动时从 `https://github.com/gzh330205/deepseek-harness-desktop/releases/latest/download/latest.json` 检查新版本，用户确认后下载、验签并静默安装（Tauri updater 插件）。

### 3.1 前置条件（一次性）

- 已安装并登录 GitHub CLI：`winget install GitHub.cli`、`gh auth login`。
- 签名密钥存在（默认 `src-tauri/keys/dsh-desktop.key`，可用环境变量 `DSH_DESKTOP_SIGNING_KEY_PATH` 覆盖）。
- 仓库保持公开。

### 3.2 每次发版步骤（严格按序）

```bash
# 1. 同步修改三处版本号（必须一致，且高于上一个已发布版本）：
#    package.json               ->  "version": "0.2.8"
#    src-tauri/Cargo.toml       ->  version = "0.2.8"
#    src-tauri/tauri.conf.json  ->  "version": "0.2.8"

# 2. 一键发布（脚本内部：版本一致性检查 → pnpm tauri build（NSIS+MSI 签名产物）
#    → 生成 latest.json → gh release create v0.2.8 并上传 4 个资产）
bash scripts/release.sh 0.2.8

# 3. 提交并推送代码
git add -A && git commit -m "chore: release v0.2.8" && git push
```

### 3.3 发布脚本行为（scripts/release.sh）

1. **版本一致性检查**：`tauri.conf.json`、`package.json`、`Cargo.toml` 三处版本必须等于传入参数，否则退出。
2. **打包**：`pnpm tauri build`（`bundle.targets = "all"`），产出 NSIS `DSH Desktop_<版本>_x64-setup.exe` 与 MSI `DSH Desktop_<版本>_x64_en-US.msi` 及各自 `.sig` 签名文件。
3. **生成 `latest.json`**：写入版本、Release 页 notes、签名与安装包 URL。注意 GitHub 上传资产时会把文件名中的空格替换为点号（`DSH Desktop_…` → `DSH.Desktop_…`），清单 URL 必须用规范化后的名字，否则下载 404。
4. **发布**：`gh release create v<版本>` 上传 NSIS、NSIS.sig、MSI、latest.json 四个资产，标题 `v<版本>`，附中文说明。

### 3.4 发布后必做验证

```bash
# 更新清单匿名可访问，且 version 为新版本：
curl -sL https://github.com/gzh330205/deepseek-harness-desktop/releases/latest/download/latest.json

# 清单内 url 字段指向的安装包匿名可下载（应返回 200）：
curl -sIL "<清单中的 url>"
```

- 确认 Release 页存在且资产完整：`gh release view v0.2.8 --repo gzh330205/deepseek-harness-desktop`。
- 确认 `latest.json` 中的 `signature` 与 `url` 配套（同一构建产物），否则用户端验签失败。

### 3.5 注意事项

- **禁止**手动修改已发布 Release 的资产后重新上传同名文件；如需修复请递增版本重新发布。
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

- `src-tauri/src/lib.rs`：DSH 子进程管理、托盘、设置/关于/更新浮层窗口、Tauri 命令、update 状态机。
- `src-tauri/tauri.conf.json`：窗口、NSIS 配置、updater 公钥与端点、版本号。
- `src/main.ts`：启动页/错误页、WebView 导航；进入 DSH 前触发桌面更新检查窗口。
- `dsh-update-prompt.html` + `src/dsh-update-prompt.ts`：DSH 更新的居中询问弹窗（发现新版本询问是否更新 → 更新完成后询问立即/稍后重启）。
- `update-overlay.html` + `src/update-overlay.ts`：DSH 更新进行中右下角的进度浮层。
- `scripts/release.sh`：一键发布脚本（发版入口）。
- `src-tauri/keys/`：签名密钥（私钥勿提交，公钥入库）。
