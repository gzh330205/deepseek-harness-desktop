# Agent Note: 导入 Codex / Claude Code 格式的 MCP 配置（0.4.12）

Status: implemented

## Problem

MCP 维护窗口只能一条条「新增 MCP」手填服务名、命令、参数、env、URL、headers。用户平时在 Codex 和
Claude Code 里已经有一批 MCP 配置：

```toml
# Codex ~/.codex/config.toml
[mcp_servers.xterminal]
url = "http://127.0.0.1:12335/mcp"
http_headers = { Authorization = "Bearer xtmcp_..." }
default_tools_approval_mode = "prompt"
tool_timeout_sec = 120
```

```json
// Claude Code .mcp.json / Claude Desktop claude_desktop_config.json
{"mcpServers": {
  "local": {"command": "npx", "args": ["-y", "pkg"], "env": {"K": "V"}},
  "remote": {"type": "http", "url": "https://…", "headers": {"Authorization": "Bearer …"}}
}}
```

搬到 DSH 要手动抄字段，既慢又容易漏 headers。目标：粘贴/选择文件 → 预览 → 批量导入。

## Decision

### 1. 新增纯解析器 `mcp-import.ts`

`parseMcpImport(text, existing)` 返回 `{ format, entries, errors, warnings }`，每条 entry 是
`{ name, input: McpServerInput, warnings, conflict? }`：

- **格式识别**：trim 后以 `{` 开头先用 JSON（Claude），否则先用 TOML（Codex，`smol-toml`）；首选失败
  还会再试另一种解析器（`.mcp.json` 以 `[` 开头、TOML 片段用 JSON 语法等边角情况），失败时给出两个解析器
  的可读错误并报告实际格式。`mcpServers` 与 `mcp_servers` 两种拼写都接受。
- **Codex → DSH**：`command`/`args`/`env`/`cwd` → stdio；`url` + `http_headers`（或 `headers`）→
  streamable-http；`enabled` 映射。同时有 `command` 与 `url` 无法判断传输方式 → 该条报错不导入；
  两者都没有 → 报错。DSH 没有对应概念的字段（`default_tools_approval_mode`、`tool_timeout_sec`、
  `startup_timeout_sec` 等所有未识别字段）→「已忽略字段：…」warning，不静默丢。
- **Claude → DSH**：`command` → stdio；`type: http/streamable-http` 或只有 `url` → streamable-http；
  `type: sse` 按 streamable-http 导入但 warning「DSH 只支持 streamable-http，SSE 配置可能连不上」；
  `disabled: true`/`enabled: false` 映射停用；`alwaysAllow`/`timeout`/`oauth` 等 → warning。
  `url` 与 `command` 同时存在、二者都缺 → 报错。
- **校验**：name trim/非空/≤80；同文件重名后者覆盖并 warning；一次最多 100 条（超出截断并 warning）；
  与现有服务的 `serverName` 精确匹配标 conflict（带 id 供覆盖）。
- **不泄密**：warning 只列字段名，不列值（headers 常是 bearer token）；解析错误只保留首行、JSON 去掉
  逗号后的原文片段——位置信息换"绝不把配置值回显到 UI"。

### 2. 导入仍走同一条写入路径

IPC：`mcpImportParse`（≤2 MB，实时用 store 列表算冲突）、`mcpImportPick`（原生文件对话框，`.toml/.json/.txt`，
≤2 MB，取消/异常转可显示 reason）、`mcpImportApply`（≤100 条；每条重新 `parseMcpInput` 校验 +
`resolveStdioCommand` 把空/裸 node 归一；冲突无 overwrite → 跳过计数，有 overwrite → 用 existing id 更新；
返回 `{imported, skipped, failed[]}`；成功后清对应探活缓存）。**renderer 不被信任**——预览里的对象回到
主进程也要重新校验；写盘仍走 `DshConfigStore.saveMcpServer`（备份/原子写/insert 补丁语义全部继承）。

### 3. UI：先预览再写，冲突显式覆盖

- toolbar「导入配置」打开模态：说明支持的两种格式、textarea、从文件选择、解析、状态行、预览、取消/导入。
- 预览每条：复选框（默认勾选）、名称、传输方式与目标（stdio 命令+参数 / HTTP URL）、warnings；冲突条
  显示「同名已存在」+ 单独的「覆盖」checkbox（默认不勾）。解析 errors 显示在预览顶部。
- 「导入选中」按勾选启用；导入中禁用全部按钮；成功后汇总「已导入 N 个，跳过 M 个，失败 K 个」+ 失败
  原因，刷新列表后关闭（自动体检会静默更新 badge，不覆盖汇总）。
- Esc / 遮罩 / × / 取消关闭；CSP 不变、无 innerHTML、无网络。

## Alternatives considered

- **自己写正则解析 TOML**（最强理由：不引新依赖）→ 弃：Codex 配置里的引号键、数组、inline table、
  转义、数字/布尔都很容易踩；`smol-toml` 是 TOML 1.0 的小型 ESM 实现（devDependency，esbuild 内联进
  `dist/main.js`，不增加安装后的文件数）。JSON 用平台自带 `JSON.parse`。
- **只支持 Codex 或只支持 Claude** → 弃：用户明确说两种格式都要，而且二者字段高度重合，一个解析器里
  分两个 mapping 成本很低。
- **解析后直接写盘、不预览** → 弃：导入内容可能含错误/同名覆盖/不支持的 SSE；预览让用户在写入前看到
  传输方式、目标与忽略字段，冲突覆盖必须显式勾选。
- **信任预览对象直接写** → 弃：renderer 可以被改；apply 端逐条 `parseMcpInput` 校验并重新归一 Node 路径，
  与普通保存路径同一套规则。
- **把 SSE 映射成 DSH 的 streamable-http 并静默** → 弃：可能连不上；导入但明确 warning，用户可自己改。
- **冲突自动覆盖** → 弃：同名覆盖会改掉用户已有配置；默认跳过、覆盖需单独勾选。
- **支持 `.jsonc`** → 本轮不做：解析器是标准 JSON，文件筛选不提供 `.jsonc`（带注释会得到可读错误），
  避免"看起来支持却解析失败"。

## Evidence

- 单测：`node --test src/mcp-import.test.ts src/mcp-window.test.ts src/mcp-ui.test.ts` → **41/41 pass**；
  全量 `node scripts/run-tests.mjs` → **623 pass / 0 fail / 8 skipped**；`tsc --noEmit` 干净；
  `node build.mjs` 成功（`dist/main.js` 1,521,012 → 1,564,904 B，`smol-toml` 已内联）。
- 真实示例解析（Node 直跑 `parseMcpImport`）：用户给的 Codex TOML → 1 条 streamable-http、URL 正确、
  Authorization 存在（不打印值）、warning 同时列出 `default_tools_approval_mode` 与 `tool_timeout_sec`；
  Claude 示例（stdio/http/sse）各 1 条，SSE 有 warning，同名 `remote` 命中 conflict；坏 TOML / 坏 JSON
  给可读 errors（不回显原文）。
- 打包后解析：用与 build.mjs 相同参数的 esbuild bundle 解析 Codex 示例成功；端到端
  `node scripts/smoke.mjs cookie --isolate-home` → SMOKE PASS（含 smol-toml 的 `dist/main.js` 正常启动）。
- 隐藏 Electron 页面 harness（stub `__DSH_MCP__` + 真实 `dist/mcp/index.html`）→ **25/25 pass，0 console error**：
  打开模态 → 贴 Codex → 解析 1 条预览（名称/streamable-http/URL/忽略字段 warning）→ 导入（桥 payload、
  footer 汇总、列表刷新）→ 文件选择回填 → Claude 2 条（冲突「同名已存在」+ SSE warning）→ 勾覆盖 →
  导入 payload `overwrite=true` → 列表 4 条 → Esc 关闭。
- 截图：`.tmp-perf/mcp-import/shots/mcp-import-codex-preview.png`、
  `mcp-import-claude-conflict.png`（不入库）。
- dev 壳菜单冒烟：`mcpWindow.loaded/bridge=true`，其余窗口/菜单无回归。
- 发版：v0.4.12 已发布（安装包 235,147,445 B + sig、`latest.json` version=0.4.12；APK 仍为 1.0.3(4)），打包组合校验通过。

## Consequences

- 导入不是事务：逐条写 store，中途失败会如实返回 imported/skipped/failed，已写入的保留；配置仍要
  「重启 DSH 服务」后才生效。
- 导入会把 headers（常含 token）写进 DSH profile 的 `cordis.patch.yml`——这与手动新增 MCP 的存储方式
  相同，属于用户主动导入；预览/日志不回显 header 值，但 patch 文件本身仍是明文（既有事实）。
- SSE 只是"尽量导入"，真正 SSE-only 的服务会连不上；可用性检查会显示不可用及原因。
- 解析器会忽略它不认识的字段（并提示字段名），所以未来 Codex/Claude 新增的字段不会阻止导入，但也不会
  被带到 DSH。
- `.jsonc`、`.mcp.json` 带注释、Codex 的 `mcp_servers = { … }` inline 顶层等边角语法不在承诺范围；
  遇到时有可读错误，不会静默导入一半。

