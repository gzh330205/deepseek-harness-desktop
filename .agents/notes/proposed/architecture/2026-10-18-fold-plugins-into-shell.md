# Agent Note: 把 deepseek-harness-plugins 并入桌面壳（随壳分发 / 壳窗口）

Status: proposed

## Problem

用户目前通过壳内插件市场把 `dsh-plugin-kit`（含 git 面板、运行环境、工作区分类、侧栏宽度、MCP/Skills 管理器、
ONE-WAY 用量、会话通知）装进 `dsh-desktop` profile。这些插件只服务于这一台桌面端，却要独立维护、独立安装、
版本要跟着 DSH 运行时升；用户要求把它们并入桌面壳，「不想独立去维护那些插件了」。

目标形态：

1. **ONE-WAY 用量**不再做成 DSH 页面里的悬浮卡片，而是壳自己的窗口；标题栏在「手机访问」旁新增菜单
   （菜单名取「用量」），功能齐全（三档指标 + 详情四个标签页 + 扫码登录 + 设置）。
2. **git 变更 / 运行配置 / 工作区分类 / 侧栏宽度**改为**随壳注入的插件**：仍然以 DSH 插件形态提供 UI
   （右侧栏、侧边栏、设置页），但由壳随安装包分发、启动时注入，不再从市场装进 profile。
3. **MCP 与 Skills** 只是维护 DSH 配置，做进壳（壳窗口直接编辑 DSH 配置），不再作为注入插件。
4. 迁移：壳负责把旧的 `dsh-plugin-kit`（及其子插件）从 profile 里移除，避免 UI 重复注册。

## Decision

**分层：壳进程负责「数据与窗口」，DSH 进程继续负责「对话界面里的插件 UI」。**

- 壳窗口（主进程 + `src/*-ui` 页面）：ONE-WAY 用量、MCP 与 Skills 管理。数据抓取/配置读写都在主进程，
  页面只经窄 IPC 拿快照；不碰 DSH 页面。
- 随壳注入插件：git 面板、运行配置、工作区分类、侧栏宽度、会话通知。安装包在
  `resources/plugins/<name>/` 携带插件目录（含其 `node_modules`，保持宿主半区的模块解析不变），
  `writeOverlay()` 在 `--patch` overlay 里逐条 `insert`，`name` 指向安装目录里的 `index.js`。
  这样插件代码原样运行、设置 schema/写入路径不变，只是「谁安装」从市场变成壳。
- 迁移：启动时检测 profile 里是否还有 `dsh-plugin-kit`；有则把它的配置行备份后从 `dsh.profile.bundles`
  与 `cordis.patch.yml` 中移除（只移除插件合集这一层，不动用户自己的 genui 等），日志记录迁移结果。

## ONE-WAY 窗口契约（阶段 1）

标题栏菜单 `用量` → 独立窗口（900×760，页面 `dist/usage/index.html`）。窗口 API 由 preload 暴露：

```ts
window.__DSH_USAGE__ = {
  get(): Promise<UsageSnapshot>
  refresh(): Promise<UsageSnapshot>
  settings(): Promise<{ baseUrl: string; refreshSeconds: number }>
  saveSettings(input: { baseUrl?: string; refreshSeconds?: number }): Promise<{ ok: boolean; reason?: string }>
  loginStart(): Promise<{ key: string; qrDataUrl: string; expiresAt: number }>
  loginPoll(key: string): Promise<{ state: 'waiting'|'scanned'|'expired'|'confirmed'|'error'; message?: string }>
  logout(): Promise<UsageSnapshot>
  requests(query: { startDate?: string; endDate?: string; page?: number; pageSize?: number }): Promise<UsageLogPage>
  close(): Promise<boolean>
}
```

`UsageSnapshot`（全部字段都来自网关页面解析，缺省值为空对象/空数组）：

```
{ loggedIn, error?, fetchedAt?, user?, apiKey?,
  tokens:   { h5, today, week, month, year },   // number（Token 数）
  requests: { h5, today, week, month, year },   // number（请求数）
  duration: { h5, today, week, month, year },   // number（时长，单位以网关页面为准）
  channels: [{ channel, h5, h5Limit, today, week, weekLimit, month, year }],
  models:   [{ channel, count, models: string[] }],
  hourly:   [...],                              // 网关 /my-usage 内嵌的 myHourlyChart 数组
  daily:    [...],                              // myTrendChart 数组
  reference: { weekTokens, monthTokens } }      // 算占比用；week 为 0 时回退 month
```

`UsageLogPage`：`{ rows: [{ id, time, model, key, channel, status, stream, latency, tokens }], total, page, pageSize, pages }`。

状态存放：会话 Cookie（含企业微信 SSO 的 cookie jar）写 `bridgeDir()/oneway.json`（本机秘密，不进设置文档）；
网关地址与刷新间隔写 `shell-settings.json` 新增的 `usage` 段（默认 `https://oneway.eportyun.com`、120 秒）。

## 阶段与验收

1. **ONE-WAY 窗口**：菜单 / 窗口 / 服务 / 页面 / 测试；菜单冒烟能打开窗口并读到 bridge；解析函数有单测。
2. **MCP 与 Skills 壳窗口**：编辑 DSH profile 的 MCP client 行与 skills 目录；保存后提示重启 DSH 生效。
3. **随壳注入四个插件**：`resources/plugins` 携带 + overlay 注入 + 迁移移除 plugin-kit；真实启动验证
   设置页/侧边栏/右侧栏入口都在、无重复注册。
4. 发版、更新笔记、匿名复核。

## Progress

**阶段 1 已落地（尚未发版）**：

- `titlebar/index.html` 新增「用量」按钮（`ShellMenuName` 加 `usage`）；`usageMenuTemplate()` 提供
  打开面板 / 立即刷新 / 退出登录；`usage-window.ts` 独立窗口（960×780）+ 9 个 IPC 通道 + 发送者校验
  与 `setImmediate` 关闭；`usage-state.ts` 把会话 Cookie/网关地址/刷新间隔存 `oneway.json`（0600、原子写）；
  `oneway-service.ts` 从插件宿主移植（解析、CookieJar、企业微信扫码登录、日志分页）；
  `usage-ui/index.html` 三指标卡 + 四个标签页 + 扫码弹窗 + 设置区；preload 暴露 `__DSH_USAGE__`；构建复制
  `src/usage-ui → dist/usage`。
- 测试：`oneway-service.test.ts` 29 组、`usage-state.test.ts` 5 组、`usage-ui.test.ts` 14 组；全量
  513 条 / 505 过 / 8 跳过 / 0 失败；`tsc --noEmit` 干净；dev 菜单冒烟确认用量窗口 `loaded: true`、
  `bridge: true`、`close` 真关窗。
- 顺带修了一个与本改动无关但会挡住发版的测试脆弱点：`pocket-service.test.ts` 用固定 41731 端口，产品自己
  开着公网访问时必挂；改为两条监听都用 0（系统分配），测试从端口占用里解耦。

**阶段 2 已落地（尚未发版）**：

- `dsh-config.ts`：直接读写 DSH profile 补丁（用 `yaml` 的 Document API，保留注释与无关行；写前备份、最多留 5 份）；
  MCP 服务本身就是 `@deepseek-ai/dsh-mcp-client` 原生 loader 行（schema 与运行时核对过），因此不需要任何插件；
  Skills 走 `$DSH_HOME/skills`（目录 bundle / 单文件 / junction 链接，只删链接不动原目录）。
- 旧插件迁移：`migrateLegacy()` 把 `mcp-skill-manager` 行里的 `mcpServers` 转成原生行并删除旧行（幂等、先备份）。
  真实 profile 上演练：4 个服务（jenkins_dev/jenkins_prod/dbx/gwd-mcp）完整迁移，注释保留；同时把旧的 ONE-WAY
  会话 Cookie 导入 `oneway.json`，用量窗口无需重新扫码。
- `mcp-ui/index.html` + `mcp-window.ts`：标题栏「插件」菜单新增「MCP 与 Skills…」，窗口两个标签页
  （服务增删改/启停；技能链接添加/移除），保存后提示「重启 DSH 生效」并给按钮；IPC 发送者校验、关闭用 setImmediate。
- `yaml` 依赖：CommonJS 且内部 `require('process')`，esbuild 打进 ESM main 会在启动时抛
  `Dynamic require of "process" is not supported`；改为 `external` + 作为 production 依赖放进 ASAR
  （`files` 显式加 `node_modules/yaml`）。
- 菜单冒烟加固：每个窗口步骤 15 s 上限 + 90 s 总看门狗，超时也写出 `menu-smoke.json`（这次就是靠它定位到
  手机访问服务队列阻塞导致的冒烟挂起）；冒烟现在还会打开「插件」菜单验证新入口。
- 证据：全量 521 条 / 0 失败；tsc 干净；dev 冒烟 `usageWindow`/`mcpWindow` 的 loaded/bridge/selectors/close 全绿。

**待办**：阶段 3（四个插件随壳注入 + 移除 plugin-kit）、阶段 4（发版）。

## Alternatives considered

- **把六个插件源码全部合并进 `dsh-desktop-shell` 单插件**（最强理由：真正做到「一个插件」、安装包不需要
  携带各插件 node_modules）→ 弃：插件宿主半区依赖 `@deepseek-ai/dsh-tools`/`dsh-mcp-client` 等包，
  合并后要么把依赖也打进单文件（版本与 DSH 运行时脱钩），要么重写导入；工作量和回归面远大于收益。
- **保留市场安装，只在壳里加「一键装齐」**（最强理由：完全不动现有插件机制、风险最低）→ 弃：用户明确
  不想再维护/单独安装这些插件，且市场安装要联网、要跟着 profile 版本走。
- **ONE-WAY 继续用 DSH 插件、只在壳里加一个跳转菜单**（最强理由：零重复实现）→ 弃：用户明确要求
  「不想做到 DSH 页面里，直接做到壳中」。
- **把 MCP/Skills 管理继续留在注入插件里**（最强理由：插件能直接调用 DSH host API 实时启停 MCP）→
  弃：用户只需要维护配置，壳窗口写配置 + 重启生效已够；少一个注入插件。

## Risks

- 随包携带插件 node_modules 会让安装包增大约 100 MB 量级（压缩后小一些）。
- 迁移要改用户 profile：必须备份、只删插件合集层、失败时不动文件。
- 网关页面是服务端渲染，站点改版会让解析失败；壳窗口要像插件那样显示「页面结构变化」错误而不是白屏。
