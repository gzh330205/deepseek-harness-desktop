# Tauri → Electron 迁移评估 · 兼官方桌面端技术栈测绘

> 调研时间：2026-09-28
> 调研对象：
> - 官方桌面端 `deepseek-ai/deepseek-harness` 的 `apps/desktop`（本地浅克隆：`D:\workspace\research\.refs\official-dsh`）
> - 同类 Electron 参考实现 `ChisaAlter/Deepseek-Harness-Desktop`（本地浅克隆：`D:\workspace\research\.refs\whale-isle`）
> - 本项目现状：Tauri 2 壳（`src-tauri/src/lib.rs` 2235 行 + `src/` 814 行），版本 0.2.31

---

## 一、结论先行

**1. 官方桌面端不是「WebUI 套壳」，而是「Electron 壳 + 随包 dsh 运行时」。**
Electron 只是它体积的约 285 MB；剩下的是内置 Node 24 + Python 3.12 + pnpm + 打包进去的 dsh 与插件（合计约 1 GB）。它的技术含量在三处：**自定义特权 scheme 的加载模型**、**Electron RunAsNode 复用自身当 Node 运行时**、**壳与 Host 之间的结构化 IPC 控制面**。([官方 README](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.zh.md)、[第三方拆包实测](https://www.eet-china.com/mp/a527567.html))

**2. 迁移到 Electron 对我们完全可行，且能顺手解决三个现存的真问题：**
- `withGlobalTauri: true` 让 DSH 页面（含任意插件前端代码）拿到 `window.__TAURI__`；Electron 用 preload + `contextBridge` 可以收窄到「只暴露壳自己的窄 API」。
- 认证 token 现在会随 `loadURL(...?token=…)` 进入 WebView；Electron 可以改成「主进程用 `net.fetch` 换取 `dsh-auth` cookie → 写进 session → 只加载不带 token 的 `/`」。
- 版本号三处同步（`package.json` / `Cargo.toml` / `tauri.conf.json`）收敛成一处。

**3. 最值得抄的 5 条（详见第三节）**
① preload + `contextBridge` + 「校验 sender 来源」的 IPC 安全模型；② 认证 Cookie 由壳持有、页面不到 token；③ 结构化控制面（ready / fatal / tasks）替代 stdout 正则；④ 构建期一致性检查（打包后不可解析的 import 直接让构建失败）；⑤ 打包运行日志 + 脱敏 + 崩溃报告。

**4. 两个必须提前想清楚的风险（详见 4.4 / 4.5）**
- **自动更新体系不可平移**：Tauri updater 用 minisign 自签 + `latest.json`；electron-updater 用 `latest.yml` + blockmap 差分，Windows 上验的是 Authenticode `publisherName`，**没有代码签名证书时这一步会被跳过**（electron-builder 对此只发警告，见 [PR #10056](https://github.com/electron-userland/electron-builder/pull/10056)），等于丢掉现在「自签验签」带来的那层保证（需要自建校验或买证书）。好消息：**可以用现有 minisign 私钥给 Electron 的 NSIS 安装包签名并写进老 `latest.json`，让 Tauri 老用户无感升级到 Electron 版**（见 4.4）。
- **体积与冷启动**：Electron 壳 + 打包运行时至少 +100 MB；若保留现在的轻壳（依赖用户已装 dsh）则约 10–100 MB，但**已决议改为随包运行时**（见下方「路线决议」）。

---

## 一·补、路线决议（2026-09-28 已确认）

| 决策 | 选择 | 影响 |
|---|---|---|
| D1 页面加载 | 仍走环回地址（先按 A2 去掉 URL 里的 token） | 官方那套 `dsh-app://` + boot 注入**无法照抄**，原因见下 |
| D2 更新 | **自建通道：minisign + `latest.json`，不采购代码签名证书** | 已定，见 [更新通道设计](update-channel-design.md) |
| **D3 dsh 运行时** | **随包（对齐官方）** | ✅ 完成（[记录](electron-runtime-bundling.md)）——含 profile 隔离与随包 pnpm |

**硬约束（已查证）**：官方 `apps/desktop` 依赖的 `@deepseek-ai/dsh-desktop-host` **未发布到 npm**（`npm view` 返回 404），它只存在于 monorepo 内部并经 `apps/desktop` 打包。因此：

- 官方「自定义 scheme 提供 Web 前端 + 由私有 Host 通过 IPC 注入 `injections` / `streamBaseUrl`」的模型，**第三方外壳拿不到**；
- 我们「随包运行时」能随的是**公开的 `@deepseek-ai/dsh` 生产依赖树**（`@deepseek-ai/dsh-web-frontend` 本身已发布，0.0.1-rc.5），运行时仍由 `dsh web` 自己提供 HTTP 服务；
- 「对齐官方」在**打包与运行时形态**上可完全对齐（Electron RunAsNode 当 Node、依赖树进 asar、完整性清单、独占 profile），在**加载模型**上只能对齐到「反向代理」这一层（见 4.6 末）。

### P0 实测补记（2026-09-28）

P0 脚手架与三个技术验证已完成，证据见 [`docs/electron-p0-verification.md`](electron-p0-verification.md)。三条结论直接改写上面的判断：

1. **S1 通过，但多一条硬约束**：Electron 必须**精确锁定 `44.0.0`**（不能写 `^44.0.0`）。dsh 的原生插件内嵌 V8 指纹白名单，`44.4.5` 的 V8 `15.2.124.28` 与白名单的 `15.2.124.13` 不匹配，dsh 直接以 `Unsupported/no-context` 退出。**「随包运行时」因此把 Electron 版本与 dsh 版本绑成一对**。
2. **S2 否决**：`dsh-app://app/` 反向代理下 HTTP 面全通（静态/API/插件 bundle 17 个请求全 200、首屏正常），但客户端推导出的会话流是 `ws://app/api/remote.mux` → 必断（界面停在「重新连接中...」）。带 host:port 的变体又被 Electron 自定义 scheme 剥掉端口。**结论：加载模型采用 Cookie 模式（D1 落地为 A2），不采用代理。**
3. **S3 通过**：`DSH_HOME` 指向独立目录后，dsh 自行初始化完整 Harness home、面板插件照常注入、界面完整可用，与用户 `~/.dsh` 零交叉。

---

## 二、官方桌面端技术栈全景

### 2.1 选型清单

| 维度 | 官方选择 | 备注 |
|---|---|---|
| 外壳 | Electron `^44.0.0` | 私有包 `@deepseek-ai/dsh-desktop`，版本与 dsh 严格同版本 |
| 壳语言 | TypeScript 6（ESM） | `src/` 约 6930 行，`main.ts` 单文件 1316 行 |
| 主进程/预加载构建 | `tsdown`（rolldown） | 主进程 ESM；**5 个 preload 打成 CJS**（沙箱 preload 只能 CJS） |
| 欢迎页 UI | Vite + React 18（lib/IIFE 单包） | `renderer/welcome.html` + `src/client/welcome.tsx` |
| 打包 | `electron-builder ^26.15.3` | `asar: true` + `asarUnpack` 原生模块 |
| 更新 | `electron-updater ^6.8.9` | generic provider（自建 COS/CDN），`nightly.yml` / `latest.yml`，blockmap 差分 |
| 安装器 | 自研 NSIS 原生页面（`.nsh` + `window-frame.cpp` GDI+） | 目录改名替换 + 失败回滚 + `/KEEP_APP_DATA` |
| 签名 | Windows EV（SafeNet Token + 签名缓存 + 串行锁）；macOS hardened runtime + 公证 | 有硬件 token 互锁与审计文件 |
| 运行时 | Electron `ELECTRON_RUN_AS_NODE=1` + `--expose-internals` 跑 dsh Host | 不依赖系统 Node |
| 随包依赖 | Node 24 + Python 3.12 + pnpm 11.7 + LibreOfficeKit | 约 378 MB |
| 埋点 | `packages/client/product-analytics` | 明确不含 Web 使用情况 |

### 2.2 进程与数据流

```
┌─ Electron 主进程 (lib/main.js) ──────────────────────────────┐
│  protocol.registerSchemesAsPrivileged(['dsh-app'])           │
│  protocol.handle('dsh-app', …)   ← 静态资源 / 转发 / 壳文档   │
│  持有 dsh-auth cookie（页面永远拿不到 token）                 │
│  窗口：main / welcome / update-dialog / mandatory overlay     │
└──────────┬────────────────────────────────────┬──────────────┘
           │ spawn(process.execPath,            │ http(s) 转发
           │   ELECTRON_RUN_AS_NODE=1,          │ (forwardWebRequest)
           │   --expose-internals <entry>,      │
           │   stdio: [...,'ipc'])              │
           ▼                                    ▼
   ┌─ dsh Host（Node 模式子进程）─┐      ┌─ dsh-web-frontend/dist ─┐
   │ @deepseek-ai/dsh-desktop-host│      │ 从 asar 直接读取          │
   │ 私有包，非公开 CLI            │      │ index.html 注入           │
   │ IPC 事件：ready / fatal /    │      │ __DSH_BOOT_READY__        │
   │ platform-session /           │      └──────────────────────────┘
   │ update-tasks /               │
   │ quit-inspection / shutdown   │
   └──────────────────────────────┘
```

关键点：**控制面走 Node IPC（`stdio: [..., 'ipc']`），不走 stdout 文本**。`ready` 事件带回 `url` 与 `injections`；`update-tasks`/`quit-inspection` 让壳在安装更新或退出前问 Host「会不会打断正在跑的任务」，2 秒超时按「有任务」处理。

### 2.3 加载与认证模型（最值得看的部分）

`src/main.ts:635` 的 `protocol.handle(SCHEME, …)` 按 hostname 分流：

| URL | 行为 |
|---|---|
| `dsh-app://shell/…` | 壳自己的文档（更新弹窗、蒙层），从 `renderer/` 读，不碰 Host |
| `dsh-app://app/` `/index.html` `/assets/*` | 从 asar 里的 `dsh-web-frontend/dist` 读（`src/web-document.ts:serveWebDocument`） |
| `dsh-app://app/` 其他路径 | `forwardWebRequest` 转发到已认证 Host |

`forwardWebRequest`（`src/web-document.ts:77`）做三件事：
1. 校验 `Origin` 必须是 `dsh-app://app`，否则 403；
2. 剥掉 `host`/`origin`/`cookie`/`sec-fetch-site`，**由壳注入自己持有的 cookie**；
3. 回程剥掉 `set-cookie` 与 Node fetch 的连接级头（`content-encoding`/`content-length`/`transfer-encoding`…），`/plugins/*` 的 bundle 强制 `cache-control: no-store`（因为 revision 每次启动都变，Chromium 磁盘缓存只会白攒）。

认证本身（`authenticateWebHost`）：主进程 `fetch(url, { redirect: 'manual' })` 拿到 303 的 `set-cookie`，**只在主进程内存里保存**；页面 origin 是 `dsh-app://app`，所以 `?token=…` 既不进页面 URL 历史，也不进页面 cookie jar。

WS 单独处理：`session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['ws://127.0.0.1/*'] })` 只为**主窗口的 webContentsId** 补 cookie（`src/main.ts:683`）。

### 2.4 安全基线

- scheme privileges：`standard / secure / supportFetchAPI / corsEnabled / stream / codeCache`（`src/main.ts:129`）。
- 所有窗口统一：`nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`、`webSecurity: true`；`webviewTag` **仅主窗口**开启。
- preload 只在 `location.protocol === 'dsh-app:' && hostname === 'app'` 时才 `exposeInMainWorld`；不同用途各一个 preload（welcome / platform / update-dialog / mandatory / browser）。
- IPC 双重校验：`assertDesktopSender(event, ['app'])` 检查 `senderFrame.url` 的 scheme+hostname（`src/ipc.ts:91`），关键通道再加 `event.sender === mainWindow.webContents && event.senderFrame === sender.mainFrame`。
- 产品页拿到的 API 是**白名单对象**（`DshDesktopProductApi`：browser / keyboard / shortcuts / updates），文档注释写得很直白：「Product documents cannot supply update versions, package URLs, or installation authorization」——**渲染进程永远拿不到 fs、原始 IPC、shell、任意 pnpm 参数**。
- `setWindowOpenHandler` → 只有 http/https 交给系统浏览器，其余一律 deny；`will-attach-webview` 默认 `preventDefault()`，guest 必须匹配主进程签发的 lease + partition。
- Platform 内嵌视图：按账号 ID 哈希出的持久分区，打开前清 cookie/IndexedDB/CacheStorage/SW；跨来源导航阻断；token 通过**同步 IPC** 在页面脚本执行前读进 preload 内存，getter 不再走 IPC。

### 2.5 更新体系

- **发布身份**：Electron 壳 + 匹配的 dsh 运行时 + pnpm 组成**一个签名更新单元**，壳与 dsh 版本严格相同——即使壳代码没改，升级 dsh 也必须发新 Desktop 版本。
- **节奏**：固定 nightly 通道，十分钟基础间隔 ±20% 抖动，失败指数退避到 1 小时上限，成功重置；回到前台/系统恢复遵守同一单调时钟截止。
- **长链路**：检查 → 下载 → 校验 → **Host 任务收尾检查**（`update-tasks lock` 先锁准入并 drain 已接收请求，再检查是否有活跃 agent/排队消息/后台任务）→ 用户**二次确认** → 安装 → `--updated` 重启并前置窗口一次。
- **强制更新**：服务端策略（`/api/v0/check_client_update`）+ 壳拥有的模态蒙层 + 白名单下载页；「共享 DOM 只约束展示，不构成安全边界」——产品脚本可以隐藏蒙层，但清不掉主进程的策略状态。
- **资格测试**：`test:updates:local` 用真 Electron HTTP + 真实 `NsisUpdater` + 私有环回服务器，跑通下载 / SHA-512 拒绝 / 重试 / 并发合并 / 清单替换 / 安装交接，并明确「截图失败不算视觉验收通过」。

### 2.6 打包 / 签名 / 安装器

- `asarUnpack`: `**/*.{node,dylib,dll,so,exe}`、`**/*.so.*`、`spawn-helper`、`rg`、libreoffice 目标包。
- `electronFuses: { runAsNode: true }` —— 他们**故意打开**这个 fuse，因为要用 Electron 自己当 Node 运行时（安全上要清楚这是有意为之）。
- `files` 里显式列 `lib/main.js`、5 个 `.cjs` preload、`renderer/**`，再把准备好的 `dsh` 树和 `dsh/node_modules` 整棵塞进 `app.asar/dsh`。
- Windows 安装器：**同卷目录改名替换**（先解压到 `.new-*`，再改名），失败回滚旧目录；运行中的应用最多等 10 秒退出；7-Zip 固定 `BCJ` 过滤器（否则 ARM64 二进制在 NSIS 解码器里解不开）；解压失败写 `installer-logs/extract-failure-*.log` 并提供「复制错误信息」。
- 卸载：删 Electron userData（`%APPDATA%` 下按包作用域的浏览器存储与缓存）+ `%LOCALAPPDATA%` 更新缓存，**绝不碰 `~/.dsh`**；`--updated` / `/KEEP_APP_DATA` 保留数据。
- Windows 签名：EV 证书 + SafeNet Token，**PIN 连错 5 次锁 Token**，所以有硬件尝试互锁文件与审计；签名缓存按原始字节+证书+工具链做键；时间戳仅对「正常退出但失败」重试最多 3 次。
- macOS：`CSC_LINK` p12 临时钥匙串、ZIP/DMG **两条产物线并行公证**、App 钉票、DMG 单独公证。

### 2.7 质量工程（17634 行 scripts + tests）

- **构建期护栏**：`desktop-bundle-imports` 让任何在打包应用里解析不到的静态/动态/`require()` 导入**直接让构建失败**（否则运行时才 `ERR_MODULE_NOT_FOUND`）。
- **打包顺序护栏**：主进程 bundle 必须在 workspace tsdown 之后（因为要内联 workspace devDependencies）。
- **冒烟**：产物 smoke（解析 ripgrep、跑文本搜索）、Host smoke（用随包 Python 真造 DOCX/XLSX/PPTX 并转 PDF）、Windows 安装器 smoke（真装真卸、中英双变体）。
- **运行日志**：`packaging-runs/<唯一目录>/{run.json, events.jsonl, stdout.log, stderr.log, result.json}`，脱敏已知凭据值，「缺 result.json 表示完成状态未经确认」。
- **崩溃报告**：`crash-<UTC>-<source>.log`（source ∈ host / web-boot / renderer / main），含 Host stderr 尾部 64 KiB、渲染进程最近 error 级 console 64 KiB，启动时保留最新 10 份。
- **开发隔离**：`apps/desktop/.desktop-build/development/{home, project, electron-user-data}`，会话/设置/凭据/浏览器数据都不污染用户 `~/.dsh`。

### 2.8 与我们现状的对比

| 维度 | 我们（Tauri 2） | 官方（Electron 44） |
|---|---|---|
| 外壳 | Rust，2235 行 `lib.rs` + 814 行 TS | TS，6930 行 `src/` + 17634 行 scripts/tests |
| 渲染引擎 | WebView2（Windows） | Chromium 44（与 Electron 同版本，跨平台一致） |
| dsh 来源 | **用户已装**的 `dsh` CLI（系统 dsh / npm） | **随包**私有 Host 包 + 完整依赖树 |
| 启动方式 | `dsh web --patch <overlay> --host … --port 41729 --no-open` | `Electron --expose-internals <desktop-host entry>` + Node IPC |
| 就绪信号 | **stdout 正则**解析认证 URL（`redact_auth_token` 脱敏） | **结构化 IPC** `ready { url, injections }` |
| 页面来源 | `loadURL('http://127.0.0.1:41729/?token=…')` | `loadURL('dsh-app://app/')`，静态资源来自 asar |
| 认证凭据 | WebView 亲自走 token→cookie | 主进程持有 cookie，页面不到 token |
| 页面能力 | `withGlobalTauri: true` → 页面有 `window.__TAURI__` | preload 白名单 API，**无 fs / 无原始 IPC** |
| 任务感知 | 无「Host 会不会被打断」的查询 | `update-tasks` / `quit-inspection` |
| 更新 | tauri-plugin-updater + minisign + GitHub `latest.json` | electron-updater + blockmap 差分 + 自建 COS |
| 安装包 | NSIS + MSI，签名用 minisign（无需 CA） | NSIS + DMG/ZIP，EV / Apple 公证 |
| 体积 | 约 10 MB | 约 1 GB |
| 面板插件 | `src-tauri/resources/dsh-desktop-shell/`（host 441 行 + client 555 行，经 `--patch` 注入） | 无此概念（壳即 Host 的拥有者） |

> **重要判断**：我们的 `dsh-desktop-shell` 是 **DSH 侧插件**，与外壳语言无关，**可以 100% 复用**。迁移 Electron 时这份 996 行资产零改动。

---

## 三、可以学的（按性价比分级）

### A 级 —— 与外壳语言无关，现在就能做

**A1. 把「就绪/控制」从 stdout 正则搬到结构化通道。**
我们已经有 `dsh-desktop-shell` 的 host 半运行在 dsh 进程内，并且已经用 `webServer.register` 注册了不受 DSH 认证保护的本地路由（配 cookie 回探 + 同源校验 + 一次性 bootstrap token）。把官方的 `ready / fatal / update-tasks / quit-inspection` 四个语义搬过来即可：
- 就绪：插件在 Host 起来后把「已就绪 + 端口 + 是否浏览器认证」通过路由暴露，壳轮询或订阅，替代对 stdout 的格式猜测；
- 任务：插件回答「当前是否有运行中的 agent / 排队消息 / 后台任务」——这是官方更新与退出确认的核心依据，我们现在完全没有。

**A2. 认证 token 不落页面。**
现在是 `loadURL(...?token=…)`。可改为：壳先 `fetch(authenticatedUrl, { redirect:'manual' })` 取 `set-cookie`，把 cookie 写进 WebView/session，再加载**不带 token** 的 `http://127.0.0.1:41729/`。
（可行性依据：我们的插件已经用「Cookie 回探 `GET /`」判定认证，说明带 cookie 直接访问 `/` 是成立的。）

**A3. 收窄页面能力面。**
`withGlobalTauri: true` 意味着 DSH 页面里的任何代码（包括第三方插件前端）都能看到 `window.__TAURI__`。官方做法是「preload 只暴露白名单对象 + 每个 handler 校验 sender origin 与 main frame」。即使不迁移，也值得复核：capabilities 是否最小、每个 command 是否校验调用来源、有没有把「安装产物/授权安装」这类能力暴露给页面。

**A4. 安装器与卸载的数据边界。**
官方明确：卸载删壳自己的 userData 与更新缓存，**不碰 `~/.dsh`**；`--updated` 保留数据。我们现在把 `shell-settings.json`/`desktop-facts.json` 放在 `%APPDATA%\ai.deepseek.dsh-desktop`，正好符合这个边界，值得写进决策并加一层「受保护目录拒绝」的防护（官方卸载器拒绝与安装目录或 home 重叠的路径、拒绝重解析点）。

**A5. 构建/发布可观测性。**
`packaging-runs/<run>/{run.json, events.jsonl, result.json}` + 脱敏 + 「缺 result.json = 未确认完成」。我们的 `scripts/release.sh` 目前是一路 bash，出问题只能看终端回滚缓冲，值得照抄这个最少结构。

### B 级 —— Electron 化时顺带做

**B1. 构建期 imports 护栏**：打包后解析不到的导入直接让构建失败，而不是运行时才报 `ERR_MODULE_NOT_FOUND`。
**B2. 崩溃报告**：`crash-<UTC>-<source>.log`，含子进程 stderr 尾部、渲染进程最近 error 级 console，保留 10 份。Electron 比 Tauri 更容易做（主进程就是 Node）。
**B3. 开发数据隔离**：`<repo>/.desktop-build/development/{home,project,user-data}`，开发不污染 `~/.dsh` 与真实 userData。官方连调试端口都有约定（main 9229 / renderer 9222 / host 9230）。
**B4. 窗口材质细节**：macOS `vibrancy: 'sidebar'` + `visualEffectState: 'active'`，最小化/隐藏时切不透明底（规避 `electron/electron#25368` 重附着空窗）；Windows `titleBarStyle: 'hidden'` + `titleBarOverlay` 跟随应用调色板。我们现在是纯原生标题栏，属于体验升级项。
**B5. 更新资格测试**：真 Electron + 环回服务器 + 真 updater，验证下载/校验失败/重试/交接，且「截图失败不算通过」。

### C 级 —— 看过就好，不适合我们

- **随包 Node + Python 3.12 + LibreOfficeKit（约 378 MB）**：那是「办公套件焊死在底座上」的产品决策，我们走轻壳 + 用户已装 dsh 的路线，不该跟。
- **强制更新服务端策略 + 飞书测试鉴权**：我们靠 GitHub Release，没有服务端策略面。
- **EV 硬件签名 + 硬件尝试互锁 + macOS 并行公证**：需要采购与发布环境，现阶段不现实。
- **`dsh-app://` 自定义 scheme 服务 Web 前端**：官方能这么做，是因为它跑的是**私有** `@deepseek-ai/dsh-desktop-host`（npm 上不存在，404），能通过 `dshDesktopBoot.ready()` 提供 `injections` / `streamBaseUrl`。公开的 `dsh web` 没有这套桌面注入契约。**P0 已实测否决反向代理变体**（见 [验证记录](electron-p0-verification.md) 第 3 节）：HTTP 面全通但会话 WebSocket 必断，且带端口变体被 scheme 剥端口。**结论：产品页直接加载环回地址，token 由主进程换成 cookie。**

---

## 四、迁移方案

### 4.1 模块对照（Rust → Electron 主进程 TS）

建议拆成与官方同构的模块，而不是一个巨型 `main.ts`：

| 现在 | Electron 对应 | 建议模块 |
|---|---|---|
| `lib.rs` 三道闸门 / 版本探测 / 端口探测 | 同逻辑，`child_process.execFile` + `windowsHide: true` | `src/gate.ts` |
| `start_dsh_web` / spawn + stdout 解析 + `redact_auth_token` | `spawn` + 结构化就绪（A1） | `src/host-process.ts` |
| `dsh_status` / `restart_dsh_web` / `update_dsh_in_background` | 保留语义 | `src/backend-controller.ts` |
| `set_main_window_locked` | `BrowserWindow.setEnabled` + 蒙层窗口 | `src/window-lock.ts` |
| `show_launcher` / 启动页 / 错误页 | 同一个 `BrowserWindow` 的本地 HTML（`file://` 或自定义 scheme） | `src/launcher-window.ts` |
| `show_about` | `BrowserWindow` + `Menu` 的「关于」 | `src/about-window.ts` |
| 三个更新浮层（`desktop-update` / `dsh-update-prompt` / `update-overlay`） | 三个无边框 `BrowserWindow`（`frame:false` / `alwaysOnTop`） | `src/update-*.ts` |
| `TrayIconBuilder` | `Tray` + `Menu`（Windows 常驻，macOS 不给菜单栏图标） | `src/tray.ts` |
| `tauri-plugin-single-instance` | `app.requestSingleInstanceLock()` | `src/single-instance.ts` |
| `tauri-plugin-window-state` | 自研 JSON（或 `electron-window-state`） | `src/window-state.ts` |
| `tauri-plugin-notification` | Electron 内置 `Notification` | — |
| `tauri-plugin-updater` | `electron-updater` | `src/update-coordinator.ts` |
| `CREATE_NO_WINDOW` | `spawn(..., { windowsHide: true })` | 统一封装 |
| `#[tauri::command]` × 16 | `ipcMain.handle` + `preload.ts` + `contextBridge` | `src/ipc.ts` |
| `app.listen("dsh-desktop-shell")` 事件桥 | `ipcMain` / HTTP 桥不变 | `src/panel-bridge.ts` |
| `dsh-desktop-shell` 插件（host+client） | **原样复用** | `resources/dsh-desktop-shell/**` |
| `tauri.conf.json` 三处版本同步 | 只 `package.json` 一处（`extraMetadata`/`app.getVersion()`） | — |
| `scripts/release.sh`（tauri build + minisign + latest.json） | electron-builder + blockmap + `latest.yml` + `gh release` | `scripts/release.mjs` |

### 4.2 三个需要拍板的决策

| | 选项 A（省事 / 1:1 迁移） | 选项 B（对齐官方） | 建议 |
|---|---|---|---|
| **D1 页面加载** | `win.loadURL('http://127.0.0.1:41729/')`，先按 A2 把 token 换成 session cookie | `dsh-app://` 自定义 scheme + 转发 | **A**。B 依赖 dsh 私有 host 契约（见 C 级），不可行 |
| **D2 更新** | electron-updater + GitHub provider；Windows 无证书 → 验签被跳过，**自建**「下载后 SHA-512 + 自有 manifest 签名」校验 | 买 EV 证书走 `publisherName` 真验签 | 先 A，发布量上来再考虑证书 |
| **D3 dsh 运行时** | 继续依赖用户已装 dsh（保留三道闸门） | 随包 Node + dsh 依赖树 | **已选 B（随包）**；落地要点见 4.6 |
| **D4 安装身份** | 新 appId（旧版无法自动升到新版） | 沿用 `ai.deepseek.dsh-desktop` + 同安装目录 | 见 4.4 |

### 4.3 分阶段路线

**P0 脚手架（先跑起来）**
- `electron` + `electron-builder` + TS + `tsdown`（主进程 ESM / preload CJS）+ `vite`（启动页）
- 最小闭环：三道闸门 → spawn dsh → 就绪 → `loadURL` 环回 → 启动页首帧后 show
- 保留 `src-tauri/` 不动，Electron 走独立目录，直到功能对齐再删

**P1 功能等价（对齐现有 16 个 command）**
- 托盘、关于窗、三个更新浮层、单实例、窗口状态、日志脱敏、锁定主窗、重启应用/服务
- IPC 安全基线：`nodeIntegration:false` / `contextIsolation:true` / `sandbox:true` + preload 白名单 + sender 校验

**P2 面板桥与设置**
- `dsh-desktop-shell` 原样复用；`shell-settings.json` / `desktop-facts.json` 路径改 `app.getPath('userData')`
- 把 A1（结构化就绪 + 任务查询）落到插件新路由上

**P3 更新链**
- electron-updater + `latest.yml` + blockmap；release 脚本重写；本地资格测试（环回服务器）
- 过渡通道见 4.4

**P4 加固与体验**
- A2/A3/A5、崩溃报告、开发数据隔离、窗口材质、冒烟测试

### 4.4 更新通道的平滑迁移（关键）

现状：`latest.json` 指向 GitHub Release 的 NSIS/MSI，签名是 Tauri minisign 私钥（`src-tauri/keys/dsh-desktop.key`）。Electron 版无法被 Tauri updater 直接安装——**除非我们主动做桥**：

1. 用 **electron-builder** 打出 Electron 版的 NSIS 安装包；
2. 在 release 脚本里**额外用现有 Tauri minisign 私钥**给这个 NSIS 包生成 `.sig`（`tauri signer sign` 对任意文件签名即可）；
3. 写一份 `latest.json`，`version` 指向 Electron 版版本号，`url` 指向该 NSIS 包 → **老 Tauri 客户端会在下次检查更新时下载并静默安装 Electron 版**，从而完成静默切换；
4. 之后 Electron 版自己的更新走 `latest.yml`。两套清单并存一段时间（同一 Release 里既放 Tauri 的 `latest.json`，又放 electron-builder 的 `latest.yml` + `.blockmap`）。

注意事项：
- 必须**递增版本号**（旧版只接受更高版本）；
- **需实测**：electron-builder 的 NSIS（`oneClick: false`）能否接受 Tauri updater 传入的静默参数（`/S`）并无人值守完成安装；这条不通，桥就不成立；
- 安装身份：electron-builder 的 NSIS 与 Tauri 的 NSIS 是两套卸载注册项，建议 Electron 安装器在 `customInit` 里检测并静默卸载旧 Tauri 版（或至少提示），否则会出现两个「DSH Desktop」；
- `.sig` 必须与 `latest.json` 中同一份构建产物匹配，否则老客户端验签失败；
- **msi 用户仍需手动下载**（现状已如此）。

### 4.5 风险清单

| 风险 | 影响 | 对策 |
|---|---|---|
| 无代码签名证书 → electron-updater 跳过 Windows 验签 | 下载链路的完整性保证弱于现在的 minisign | 自建「SHA-512 + 自有签名 manifest」校验；或采购证书 |
| 安装包体积从 ~10 MB 涨到 ~100 MB+ | 下载与更新带宽 | 用 blockmap 差分；`electronLanguages` 裁语言；`compression: maximum` |
| WebView2 → Chromium 44 的渲染差异 | DSH Web 前端回归 | 复用同一套 DSH 版本做冒烟；官方已在 Chromium 44 上跑通，风险低 |
| 双 NSIS 安装身份并存 | 用户看到两个应用 | Electron 安装器检测旧版并卸载；或在 4.4 桥接里先行覆盖 |
| 自动化发布脚本重写 | 发版流程短暂不可用 | P3 阶段两套脚本并存，用同一版本号各发一次并对拍 `latest.json` / `latest.yml` |
| 回滚成本 | 一旦发 Electron 版，回 Tauri 需再发一次更高版本 | 先在 `0.3.x` 走「并存 + 双清单」，确认老用户升级率后再删 Tauri |
| **随包运行时的 profile 冲突** | 壳内 dsh 与用户全局 dsh 争同一个 `~/.dsh`，互改版本/锁文件 | 引入 `$DSH_HOME/profiles/desktop` + 进程单实例锁；壳只碰自己的 profile |
| **原生模块必须 unpack** | `asar` 内 `.node` 无法 `dlopen`，运行时才炸 | `asarUnpack` 覆盖 `**/*.{node,dll,exe,so}`；打包后做「解包完整性」校验 |
| **运行时完整性校验失败** | 装机后启动即失败，且用户无法自助修复 | 启动时校验 `desktop-runtime.json`；失败走原生「修复/重装」路径；安装器用同卷目录替换 + 回滚 |
| **三道闸门语义迁移** | 老用户那套「dsh 太旧 → 去升级」的提示失效 | 过渡版本里两套逻辑并存：包内运行时优先，包外仅作开发/降级回退 |
| **体积** | +100～150 MB（不含 Python/LibreOffice） | `electronLanguages` 裁语言、`compression: maximum`、blockmap 差分 |

---

### 4.6 选定路线（D3 = 随包运行时）的落地要点

既然对齐官方走「随包」，下面这些约束就必须一起接受——它们不是可选项，官方 README 的决策表已经把因果写死了。

1. **「随包 Node」其实就是 Electron 自己**。用 `ELECTRON_RUN_AS_NODE=1` + `process.execPath` 当 Node 跑 dsh 入口，不需要再带一个 Node 二进制（官方 `node-environment.ts` 只有 18 行）。入口指向包内 dsh 的 `lib/bin.js`；我们不需要 `--expose-internals`（那是私有 Host 用 Node 内部模块才需要的）。
   **已实测的前提**：Electron 必须**精确锁定 `44.0.0`**。dsh 的 `node-addon-require-builtin` 内嵌 V8 指纹白名单（`43.0.0`→`15.0.245.13`、`44.0.0`→`15.2.124.13`、`45.0.0-alpha.6`→`15.4.80`），`44.4.5` 的 V8 是 `15.2.124.28`，不匹配即失败。这是一条长期维护约束：**Electron 版本与 dsh 版本被绑成一对**。
2. **依赖树怎么进包**。照官方 `prepare:dsh` 的做法：构建时安装一次生产依赖图 → 物化到 `app.asar/dsh` → 移除包管理器元数据 → 生成 **`desktop-runtime.json`**（壳版本、Electron 的 Node 版本、平台/架构、共享包版本、最终文件哈希清单），启动时先校验元数据与文件完整性再启动 Host。`asarUnpack` 必须覆盖 `**/*.{node,dll,exe,so}`、`**/*.so.*`、`spawn-helper`、`rg`。这一步同时也是「不再需要版本闸门」的前提：**版本一致性由打包期保证，而不是运行期探测**。
3. **profile 归属（最容易踩的坑）**。官方的结论是：*Electron 在访问任何 profile 前获取进程生命周期单实例锁，并独占 `$DSH_HOME/profiles/desktop` 及其包管理器状态；CLI 与 Desktop 共享 `$DSH_HOME` 下受支持的产品数据，但绝不共享可执行包、插件激活、锁文件或 `node_modules`*。我们现在是直接复用用户 `~/.dsh` 的默认环境——随包后必须引入 `profiles/desktop` + 单实例锁，否则壳内 dsh 与用户命令行 dsh 会互相改版本、争 profile。
4. **三道闸门的演化**。`dsh --version` / `--patch` 的探测对象从「用户环境」变成「包内运行时描述符」（启动时校验失败 → 修复安装，而不是「让你去升级 dsh」）。**固定端口 41729 必须保留**：面板桥的 cookie 回探/同源校验依赖 loopback 同源契约。「更新 DSH」的语义从「升级用户全局 dsh」变成「下载新的 Desktop 版本」。
5. **更新单元变了**。壳 + 匹配的运行时（+ pnpm）是一个签名更新单元：即使壳代码没动，升级 dsh 也必须发新的 Desktop 版本。这也是 blockmap 差分最划算的场景（只变了运行时的一小部分）。
6. **pnpm**。官方把 pnpm 随包（不走 PATH），用于 Desktop profile 的插件安装。建议照做（量级约 10 MB），否则「插件安装」会重新依赖用户 PATH。
7. **不要带 Python / LibreOffice**。那约 378 MB 是 Office 技能（`office-docx`/`pptx`/`xlsx` + `check_office.py` + LibreOfficeKit 144 DPI 渲染自检）的代价。除非我们也要做「交付物面板 + 办公三件套」，否则不跟。
8. **反向代理变体（可选加固，需 P0 技术验证）**。`protocol.handle('dsh-app', …)` 把 `dsh-app://app/*` 映射到环回 Host 的响应（**包括 boot 后的 HTML**），收益是页面 origin 变成壳自己的 `dsh-app://app`、cookie 由主进程持有、token 不进页面；风险是 HTML/JS 里的绝对地址、`<base>`、CSP，以及 **WebSocket**（官方靠 `streamBaseUrl` 让页面直连 Host，代理模式下要额外用 `webRequest` 重写 `ws://`）。
   验证清单：① 首屏与登录跳转；② 流式响应是否仍逐块到达（scheme 需 `stream: true`）；③ 会话 WebSocket 是否连通；④ 插件 bundle 是否加载；⑤ 刷新/前进后退是否稳定。任何一条不过，就退回直接 `loadURL` 环回。



---

## 五、同类 Electron 参考实现

**`ChisaAlter/Deepseek-Harness-Desktop`（Whale Isle）** —— 与本项目路线最接近的已落地 Electron 壳，值得直接对照抄作业：([仓库](https://github.com/ChisaAlter/Deepseek-Harness-Desktop))

- 纯 JS（无 TS 构建），`electron-builder` + **GitHub provider** 发布 + **blockmap 差分更新**（`electron-builder.launcher.yml`）；
- `src/main/update-updater.js`：`autoUpdater.autoDownload = false`、`autoInstallOnAppQuit = false`、`checkForUpdates()` 配 `cancellationToken`、`download-progress` 事件、`quitAndInstall(true, true)` —— 与我们「用户确认后才下载安装」的交互一致；
- `src/main/local-url.js`：`isLoopbackHttpUrl` / `isSameOriginLoopbackUrl` / `rewriteLoopbackLoadUrl`，专门防 `http://127.0.0.1.evil` 前缀欺骗与 `http://127.0.0.1@evil` userinfo 欺骗 —— 我们做 Electron 版时应直接采用同款校验；
- `src/main/ipc-authorization.js`：按 `event.sender` / `senderFrame === sender.mainFrame` / frame URL 给 IPC 分角色（boot / harness / launcher）—— 与官方的 `assertDesktopSender` 是同一思路的轻量版；
- 还有 `legacy-dshbot-preset`、`data-import` 等旧版迁移代码，可作为「版本迁移」参考。

---

## 六、下一步

D1（Cookie 模式）、D2（自建更新通道）、D3（随包运行时）均已落地；S1/S2/S3 与 P0/P2/P3 均出结论并有验证记录。

### 4.6 的落地结果（2026-09-28）

| 4.6 的约束 | 落地情况 |
|---|---|
| 「随包 Node」= Electron 自身 | ✅ 一直在用（`ELECTRON_RUN_AS_NODE`） |
| 依赖树进包 + `desktop-runtime.json` + 启动校验 | ✅ 345.8 MiB / 11724 文件；启动前校验入口与 23 个关键文件 |
| `asarUnpack` 原生模块 | ➖ 未走 asar：运行时放在 `resources/runtime/dsh` 外部，原生模块直接可加载（少一层复杂度） |
| 独占 `$DSH_HOME/profiles/desktop` + 单实例锁 | ✅ 名字实测被 dsh 保留（`desktop` 会报 managed exclusively），改用 **`dsh-desktop`**；首次运行从出厂 `web` profile 播种 bundle 与依赖，随包 pnpm 后台安装 |
| 三道闸门演化 | ✅ 版本一致性由打包期护栏接手（构建期校验 V8 指纹；运行期校验运行时完整性） |
| 更新单元 = 壳 + 运行时 | ✅ 安装包 97.6 → 185.2 MiB，运行时净增约 88 MiB |

决定性验证：`PATH` 只剩 `System32`（无 dsh / node / git）时打包产物仍完整启动
（[记录](electron-runtime-bundling.md) 第 4 节）。

P0 已交付（见 `electron/`）：单实例、三道闸门、Electron Node 模式启 dsh、overlay/面板插件复用、Cookie 加载模式、启动页、托盘、子进程回收、8 个单测、端到端冒烟脚本。

接下来按 4.3 推进：

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 脚手架：单实例、三道闸门、Electron Node 模式启 dsh、Cookie 加载、启动页、托盘、子进程回收 | ✅ 完成（[P0 验证](electron-p0-verification.md)） |
| P1 | 对齐现有 16 个 Tauri command：关于窗、三个更新浮层窗口、窗口状态记忆、任务收尾确认 | ✅ 完成——单实例 / 更新窗口（含进度）/ 任务收尾确认 / 窗口位置尺寸记忆 / **自绘标题栏（菜单并入标题行）** / 关于（**按用户要求保持原生对话框**，但内容与图标已重做）；与 Tauri 版的有意差异：关于不是独立窗口、更新进度在更新窗口内而非右下角浮层 |
| P2 | 面板桥与设置页打通 + A1（结构化就绪 + 任务查询） | ✅ 完成（[P2 验证](electron-p2-verification.md)） |
| P3 | 更新通道：minisign + `latest.json` + 桥接安装器 + 发布脚本 | ✅ 完成（[P3 验证](electron-p3-verification.md)），正式发布待确认 |
| **D3 随包运行时** | 构建期物化 dsh 依赖树 + 完整性清单 + 零环境安装 | ✅ 完成（[记录](electron-runtime-bundling.md)）；profile 隔离待做 |
| P4 | 加固与体验：崩溃报告、开发数据隔离、窗口材质、打包期 imports 护栏、blockmap 差分 | ⏳ 大部分完成——✅ 崩溃/加载失败兜底、✅ 持久日志 + 诊断支持包、✅ 开发态数据隔离；❌ blockmap 差分**经实测否掉**（只省 3.2%，见 `docs/electron-p3-verification.md`）；❌ 窗口材质**评估后不做**（DSH 页面与启动页自身都是不透明背景，启用 acrylic/mica 看不出效果，只会引入渲染风险） |

调研产物（本地参考克隆，不入库，可直接翻源码）：
- `D:\workspace\research\.refs\official-dsh\apps\desktop`（官方，443 文件；重点看 `src/main.ts`、`src/web-document.ts`、`src/host-process.ts`、`src/ipc.ts`、`scripts/electron-builder-config.mjs`、`tsdown.config.ts`）
- `D:\workspace\research\.refs\whale-isle`（同类 Electron 实现；重点看 `src/main/local-url.js`、`src/main/ipc-authorization.js`、`src/main/update-updater.js`）
