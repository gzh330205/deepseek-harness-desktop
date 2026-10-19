# Agent Note: MCP 服务可用性检查（0.4.11）

Status: implemented

## Problem

MCP 与 Skills 窗口此前只显示配置（服务名、命令/URL、启用状态），没有任何"这个服务到底能不能用"的信息。
用户只能保存后重启 DSH，再去会话里看工具有没有出现；配置里一条已经失效的命令/URL 会一直看起来"正常"。
用户要求：列表显示可用状态，并且**每一个 MCP 都能检查是否可用**。

## Decision

### 1. 真握手，而不是只看配置

新增 `electron/src/mcp-probe.ts`，用壳依赖里已有的 `@modelcontextprotocol/sdk@1.31.0` 在**主进程**做真实
MCP 连接：`Client` + stdio 或 streamable-http transport，`connect()` 后 `listTools()`，成功返回工具数与
前 50 个工具名，失败返回可读原因。检查不依赖 DSH 会话是否启动，也不经过页面网络。

- stdio：`StdioClientTransport({ command, args, env, cwd?, stderr:'pipe' })`。**env 按 DSH 的规则清洗**
  父进程（去掉名字匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 与 `DSH_*` 的项，保留 PATH/HOME 等），再合并用户
  配置的 `env`；stderr 收集尾部 2000 字符拼进错误（启动失败的真正原因通常在那里）。
- streamable-http：`StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } })`，URL
  非法/连接被拒/网络错误都变成可读 error。
- 20 秒超时（可注入，测试用短超时）；超时、失败、成功都关闭 client/transport（不留子进程/会话），
  所有路径返回 {@link McpProbeResult}，绝不 throw —— 调用方是 IPC handler，rejection 只会变成窗口里
  一句"未知错误"。
- SDK 动态 `import()`：打开壳/窗口不支付 SDK 加载成本，第一次点检查才加载。

**esbuild 的坑（已绕过，值得记住）**：主进程被打成 ESM `dist/main.js`，SDK 的 stdio transport 依赖 CJS
`cross-spawn`，esbuild 会把它变成 `__require('node:child_process')`，在 ESM 里抛
`Dynamic require of "child_process" is not supported`。`build.mjs` 不在本任务作用域，所以
`mcp-probe.ts` 在首次探活前惰性补一个 `globalThis.require = createRequire(import.meta.url)`
（只补缺失、只发生一次，注释与 build.mjs 里 `yaml` 外置同源）。更干净的长期方案是把 SDK 加进
`external` 并作为生产依赖随包（需要改 build.mjs/package.json，本轮未做）。

### 2. 缓存与失效：状态属于"这次进程"，不属于磁盘

`McpWindow` 持有 `Map<id, McpProbeResult>` 与 in-flight 去重（同一 id 并发只跑一次），`mcpList` 把
`probe` 附在每项上返回；保存/删除后清掉该 id，启用/停用不清（连通性没变）；用 epoch 防止
"保存后旧请求回来把新配置的状态覆盖"。**不落盘**：上次运行的连通性不代表现在，重启后显示未检查。

### 3. UI：状态先出现，按钮按需复查

- 每张卡片显示 badge：未检查 / 检查中… / 可用 · N 个工具 / 不可用；失败原因一行（截 240 字，`title`
  放全文），以及「HH:mm 检查」上次检查时间；停用/legacy 卡保留且仍可检查。
- 首次渲染后**自动检查已启用的服务**（串行、跳过已有缓存、不检查已停用的），所以打开窗口就能看到
  状态，而不是一列"未检查"。检查完成在状态栏汇总「已自动检查 N 个 MCP 服务，M 个不可用」。
- 每卡「检查」按钮（检查中禁用）；toolbar「检查全部」按列表顺序串行检查全部（含停用），显示
  「检查中 n/总…」并禁用，结束汇总结果。
- 状态只存在于当前窗口会话（结果缓存来自主进程），关窗重开不重复 spawn。

## Alternatives considered

- **读取 DSH 运行时的 MCP 连接状态**（最强理由：看到的就是 DSH 真正连上的状态，不用另起进程）→ 弃：
  DSH 没有对壳暴露"当前 MCP 连接/工具"的 API；要加就得改 DSH 或走内部协议，跨版本脆弱。独立握手能直接
  回答"这个配置能不能用"，且失败原因（stderr、HTTP 错误）能显示给用户。
- **只做预检查**（命令文件存在、URL 能 curl、args 路径存在）→ 弃：文件都在但 MCP 握手失败的情况很常见
  （依赖缺失、协议版本不匹配、认证失败），那正是用户需要知道的。
- **让 DSH 重启后再看工具是否出现** → 弃：慢、会打断会话，且不适用停用/旧迁移条目。
- **通过页面网络直接连 MCP** → 弃：违反壳自有页面 `default-src 'none'` 的边界；cookies/凭据、子进程
  都应该留在主进程。
- **把检查结果写盘，重启后显示上次状态** → 弃：旧状态会被误当现状（"显示可用但其实早挂了"比没状态更糟）。
- **自动检查所有服务（含停用）** → 弃：用户主动停用的服务不该因为是打开窗口就被反复 spawn；只自动查
  已启用的，停用的留给「检查」按钮。
- **并发检查全部** → 弃：5 个 stdio 服务同时 spawn 会抢 CPU/端口，也可能触发服务器限流；串行虽然慢一点，
  但状态变化可预测。

## Evidence

- 单测：`node --test src/mcp-probe.test.ts src/mcp-window.test.ts src/mcp-ui.test.ts` → **31/31 pass**；
  全量 `node scripts/run-tests.mjs` → **606 pass / 0 fail / 8 skipped**；`tsc --noEmit` 干净；
  `node build.mjs` 成功（`dist/main.js` 1,332,469 → 1,521,012 B，SDK 已打包）。
- 真实探活：
  - 源码直跑 fixture（最小 MCP stdio server）→ `ok:true, toolCount:2, toolNames:['echo','ping']`，
    失败命令用例 `ok:false`，HTTP 关闭端口用例可读 error，短超时用例确认子进程被杀。
  - 用与 build.mjs 相同参数把 `mcp-probe.ts` 打成 ESM bundle 再跑 fixture → `ok:true, toolCount:2`；
    加 `require` 垫片前该步失败（正是上面 esbuild 的坑）。
  - 端到端 `node scripts/smoke.mjs cookie --isolate-home` → SMOKE PASS（含 SDK 的 `dist/main.js` 正常启动）。
- 隐藏 Electron 页面 harness（stub `__DSH_MCP__` + 真实 `dist/mcp/index.html`）→ **18/18 pass，0 console error**：
  三态 badge、错误单行截断+title 全文、HH:mm 时间、停用/legacy 可检查；单卡检查一次桥调用；「检查全部」
  串行（maxActive=1）、进度/禁用/汇总、按列表顺序更新。
- 截图：`.tmp-perf/mcp-status/shots/mcp-status-initial.png`、`mcp-status-checked.png`（不入库）。
- 发版：v0.4.11 已发布（安装包 235,116,332 B + sig、`latest.json` version=0.4.11；APK 仍为 1.0.3(4)），打包组合校验通过。

## Consequences

- 探活会**真的启动配置的 stdio 进程/发 HTTP 请求**：打开窗口自动查已启用的、点按钮查单个，均可能触发服务
  端日志/限流；这是"可用性"的代价。检查完立即关闭，不留进程。
- 检查失败只代表"从壳进程用这份配置连不上"：环境差异（DSH 内的 PATH/proxy/凭据）理论上可能不同；但
  清洗规则与 DSH 一致、Node 用同一个随包路径，差异已被压到最小。
- 状态不落盘：重启后全部回到未检查，再由自动检查填充；如果服务器启动很慢，打开窗口后 badge 会从
  「检查中…」逐步变成结果。
- `globalThis.require` 垫片是 esbuild ESM 打包 CJS 依赖的兼容补丁；未来若把 SDK 外置为生产依赖，应删掉
  垫片并更新 build.mjs/README 的硬约束，而不是继续叠兼容层。
- 单次超时名义 20 秒，SDK 的 transport.close() 会先等约 2 秒再 SIGTERM，所以最坏返回约 22 秒；返回时
  子进程已被杀。

