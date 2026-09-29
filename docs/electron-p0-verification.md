# Electron P0 技术验证记录（S1 / S2 / S3）

> 执行时间：2026-09-28
> 代码位置：`electron/`（与 `src-tauri/` 并行，Tauri 版未改动）
> 关联文档：[Tauri → Electron 迁移评估](tauri-to-electron-migration.md)

## 0. 一句话结论

**可以迁。** Electron 壳已能拉起真实的 DSH Web 服务、把面板插件零改动注入 DSH 进程、并以「主进程持有 Cookie、页面拿不到 token」的方式加载出完整可用界面。但有一条硬约束：**Electron 版本必须精确等于 dsh 原生插件白名单里的版本**，否则连 dsh 都起不来。

| 验证 | 结论 |
|---|---|
| S1 随包运行时（Electron RunAsNode 跑 dsh） | ✅ 通过，**前提是 Electron 精确锁 44.0.0** |
| S2 反向代理加载模型（`dsh-app://`） | ❌ 否决：HTTP 全通，但**会话 WebSocket 必断** |
| S3 `DSH_HOME` profile 隔离 | ✅ 通过 |
| 附：Cookie 加载模式（token 不进页面） | ✅ 通过，端到端渲染出完整 DSH 界面 |

## 1. 环境

| 项 | 值 |
|---|---|
| 平台 | Windows x64 |
| Node / pnpm | v26.7.0 / 10.34.2 |
| Electron | **44.0.0（精确锁定，不可用 `^`）** |
| esbuild / TypeScript | 0.28.2 / 5.7.3 |
| DSH | `@deepseek-ai/dsh@0.1.7-rc.2`（全局安装，`G:\nodejs\node_global`） |
| 端口 | 测试用 41730（41729 被当前 DSH GUI 占用，正好验证了端口闸门） |

## 2. S1：Electron RunAsNode 跑随包 dsh 运行时

### 2.1 第一次尝试失败（重要）

`electron@44.4.5` + `ELECTRON_RUN_AS_NODE=1 electron.exe <dsh>/lib/bin.js web …`：

```
dsh: fatal uncaught exception: Error: dsh: host preparation failed:
node-addon-require-builtin unsupported: Unsupported/no-context
(unsupported Electron runtime fingerprint: Node 24.21.0, V8 15.2.124.28-electron.0
 (supported Electron versions: 43.0.0, 44.0.0, 45.0.0-alpha.6))
    at installRuntimeInterception (…/@deepseek-ai/dsh-app-boot/lib/index.js:1641:80)
    code: 'Unsupported/no-context',
    diagnostics: { mode: 'napi', binary_abi: 'napi-v9', has_v8_context: false,
                   getter_symbol: 'not-found', status: 'Unsupported/no-context' }
```

### 2.2 根因：白名单匹配的是**精确 V8 指纹**，不是主版本

`node-addon-require-builtin-win32-x64-msvc/prebuilt/win32-x64-msvc-napi-v9.node` 内嵌三组指纹：

```
43.0.0          15.0.245.13-electron.0     electron-43 tagged default=0
44.0.0          15.2.124.13-electron.0     electron-44 tagged default=0
45.0.0-alpha.6  15.4.80-electron.0         electron-45-alpha tagged default=0
… unsupported Electron runtime fingerprint: Node %s, V8 %s (supported Electron versions: …)
```

`electron@44.4.5` 的 V8 是 `15.2.124.28-electron.0` —— 与白名单里的 `15.2.124.13` 只差补丁位，仍然被拒。

### 2.3 修正后通过

把 `devDependencies.electron` 固定为 `"44.0.0"`（无 caret），重跑：

```
SMOKE cookie → PASS
  version: 0.1.7-rc.2
  entry:   G:\nodejs\node_global\node_modules\@deepseek-ai\dsh\lib\bin.js
  logs:    闸门通过：dsh 0.1.7-rc.2，端口 41730
           启动 dsh web --patch <overlay> --host 127.0.0.1 --port 41730 --no-open
           [dsh-desktop-shell] host apply pid=66396 bridgeDir=…
           [dsh-desktop-shell] 已注册路由 /dsh-desktop-shell/v1/*（除 ping 外均需 DSH 会话认证）
  probe:   { href: "http://127.0.0.1:41730/", title: "DeepSeek Harness", root: true }
```

三个结论：

1. **不需要第二个 Node 二进制**：`process.execPath` + `ELECTRON_RUN_AS_NODE=1` 就是官方 README 里「随包 Node」的等价物。
2. **`src-tauri/resources/dsh-desktop-shell/` 零改动复用**：`--patch` overlay 注入、`DSH_DESKTOP_BRIDGE_DIR` 桥目录、路由注册全部照常工作（日志里 `host apply` 与路由注册均出现）。
3. **不需要 `--expose-internals`**（那是官方私有 Host 用 Node 内部模块才需要的），也不需要 `cmd.exe` shim，参数无引号风险、无控制台闪窗。

### 2.4 由此产生的迁移约束

- `electron` 依赖必须**精确锁定**，不能用 `^`；升级 Electron 前要先确认 dsh 侧插件的白名单是否覆盖目标版本。
- 这条约束同时意味着：**「随包运行时」把 Electron 版本与 dsh 版本绑成了一对**。dsh 升级可能要求改 Electron 版本，反之亦然 —— 这正是官方把壳、运行时、pnpm 当作**同一个更新单元**的原因。
- 该白名单存在于 dsh 的 `node-addon-require-builtin`，属于我们必须长期跟踪的上游行为。

## 3. S2：反向代理加载模型（否决）

官方用 `dsh-app://app/` 提供页面、把 API 转发给 Host，靠的是**未发布**的 `@deepseek-ai/dsh-desktop-host` 注入 `injections` / `streamBaseUrl`。第三方只能用「反向代理 `dsh-app://app/*` → 环回 Host」逼近。实测：

### 3.1 S2a：`dsh-app://app/`

```
probe: { href: "dsh-app://app/", origin: "dsh-app://app", title: "DeepSeek Harness",
         readyState: "complete", root: true, nodes: 361,
         text: "…插件 工作区 设置 重新连接中... 选择工作区 标准模式 · Git Bash(原生)…" }

proxied: 17 个请求，状态全部 200
  /                                                    200
  /plugins/  ×3                                        200
  /assets/index-*.css /assets/index-*.js
  /assets/vendor-*.js /assets/vendor-*.css             200
  /api/dynamicCordisRunner/syncInspectManifest         200
  /api/credentials/describe                            200
  /api/dynamicCordisRunner/inventory                   200
  /api/session/modelCatalog                            200
  /api/agentPresets/list                               200
  /plugins/events                                      200
  /dsh-win-notify/config                               200
  /dsh-oneway-usage/v1/usage                           200
  /open-in-app/apps                                    200

wsAttempts: [ "ws://app/api/remote.mux" ×3 ]
wsErrors:   [ "ws://app/api/remote.mux → net::ERR_FAILED" ×2 ]
```

**HTTP 面完全可用**（静态资源、API、插件 bundle 全 200），首屏也渲染出来了；但 DSH 客户端用 `location` 推导会话流地址，得到 `ws://app/api/remote.mux` —— 直接失败。界面因此停在「重新连接中...」。**会话流不通，应用就是不可用的。**

### 3.2 S2b：让 origin 带上真实 host:port

假设：把文档 origin 换成 `dsh-app://127.0.0.1:41730/`，客户端就会推导出正确的 `ws://127.0.0.1:41730/api/remote.mux`。实测被 Electron 的自定义 scheme 处理否决 —— **端口被剥离**：

```
proxyDocumentHost: 127.0.0.1:41730
probe: { href: "dsh-app://127.0.0.1/", origin: "dsh-app://127.0.0.1", root: false, nodes: 3, text: "" }
proxied: 1 个请求，状态 404
wsAttempts: []
```

### 3.3 结论

- 反向代理**不能**替代官方的加载模型；根因是缺少 `streamBaseUrl` 注入点，而该注入点是私有 Host 的能力。
- 因此 **P0 采用 Cookie 加载模式**：仍加载环回地址，但 token 由主进程换成 Cookie，页面从头到尾看不到凭证（下节验证）。
- 代理相关的代码（`src/proxy.ts`、`dsh-app://shell/` 文档路由）保留为「壳自有文档」能力，不再用于承载产品页面。

## 4. 附：Cookie 加载模式（token 不进页面）端到端验证

流程：主进程 `fetch(authUrl, { redirect: 'manual' })` → 读 `set-cookie` → 写进 Electron session → 加载**不带 token**的裸地址。

```
已用一次性 token 换取 dsh-auth-iLLb7xWrCSYvCTexsUw1m8RPhnN1KGm_XxIa4dIr4ec cookie（token 未进入页面）
加载模式 cookie，导航目标 http://127.0.0.1:41730/
probe: { href: "http://127.0.0.1:41730/", origin: "http://127.0.0.1:41730",
         title: "DeepSeek Harness", root: true, nodes: 467,
         text: "新会话 … 插件 工作区 … 描述你想要构建的内容, / 调用指令, @ 文件或对话
                工作区内修改 DeepSeek-V41-Flash High …" }
```

对照 Tauri 版：现在会把 `loadURL(...?token=…)` 交给 WebView，token 进入页面 URL 历史；Electron 版从第一步起就不进页面。这正是迁移附带解决的安全问题之一。

## 5. S3：`DSH_HOME` profile 隔离

```
node scripts/smoke.mjs cookie --isolate-home
ok: true
dshHome: C:\Users\gzh33\AppData\Local\Temp\dsh-desktop-smoke-Jdj7yw\dsh-home
probe: { href: "http://127.0.0.1:41730/", title: "DeepSeek Harness", root: true, nodes: 467,
         text: "…默认工作区 新会话 设置 … 标准模式 …" }
```

隔离 home 下 dsh 自行初始化了完整的 Harness home（profile、会话、设置），面板插件照常注入并注册路由，界面完整可用 —— 与用户的 `~/.dsh` 完全无交叉。这为官方那条硬决策（**壳独占自己的 profile，绝不与 CLI 共享可执行包 / 插件激活 / 锁文件 / node_modules**）提供了落地手段。

> 注：`--isolate-home` 之外的冒烟运行会使用用户真实的 `~/.dsh`（与 Tauri 版行为一致），这是有意为之的功能性验证；CI 应统一加 `--isolate-home`。

## 6. 复现步骤

```bash
cd electron
pnpm install                 # postinstall 会执行 install-electron 下载二进制
npx tsc --noEmit             # 类型检查
npm test                     # 8 个纯函数单测（脱敏/解析次序、版本比较、端口优先级）
node build.mjs               # esbuild 打包 dist/

# 三种加载模式（端口用 41730，避开当前 GUI 占用的 41729）
node scripts/smoke.mjs cookie               # 默认：Cookie 模式
node scripts/smoke.mjs token                # Tauri 版行为，用于对照
node scripts/smoke.mjs proxy                # S2a：dsh-app://app/
DSH_DESKTOP_PROXY_ORIGIN=loopback node scripts/smoke.mjs proxy   # S2b

# S3：隔离 Harness home
node scripts/smoke.mjs cookie --isolate-home
```

冒烟脚本会拉起真实 Electron 窗口（smoke 模式下不显示）、真实 dsh 子进程，退出前打印一行 `SMOKE_RESULT`，并用独立临时目录承载 userData，不与日常数据混用。

## 7. 尚未验证（P1 起）

| 项 | 说明 |
|---|---|
| 流式响应 | S2 已否决代理模式；Cookie 模式下页面与 Host 同源，流式依赖与 Tauri 版一致，未单独压测 |
| WebSocket 会话流（Cookie 模式） | 未观察到失败，但也未构造「发起一次真实会话」的用例；`onBeforeSendHeaders` 的 Cookie 注入已就位 |
| 托盘 / 关于 / 更新浮层窗口 | `tray.ts` 已实现但未做交互验证（无头环境不适合断言托盘） |
| 打包与自动更新 | P3 范围，`electron-builder` 尚未接入 |
| 安装身份迁移 | 4.4 节的 minisign 桥接方案未实测（需真实发布一次） |
| 主窗口关闭/隐藏语义、任务收尾确认 | P1 范围 |

## 8. 交付物

| 路径 | 说明 |
|---|---|
| `electron/src/main.ts` | 单实例、三道闸门、加载模式分流、窗口与生命周期 |
| `electron/src/gates.ts` | 三道闸门（版本 / `--patch` / 端口）与端口占用者解析 |
| `electron/src/host-process.ts` | dsh 子进程：overlay、结构化就绪、日志脱敏、优雅停止 |
| `electron/src/dsh-output.ts` | 脱敏与认证地址解析（含防止「先脱敏后解析」的次序约束） |
| `electron/src/proxy.ts` | S2 的反向代理实现（保留：`dsh-app://shell/` 壳自有文档） |
| `electron/src/settings.ts` | 复用 Tauri 的 `shell-settings.json`（端口、代理、关闭行为） |
| `electron/src/tray.ts` | 托盘（复用仓库鲸鱼图标） |
| `electron/src/preload.ts` | 窄接口 preload，且只对壳自有文档暴露 |
| `electron/scripts/smoke.mjs` | 端到端冒烟运行器 |
