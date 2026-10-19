# Agent Note: MCP 窗口单页滚动与 Node 运行时自动获取（0.4.10）

Status: implemented

## Problem

用户对「MCP 与 Skills」窗口提了两点：

1. **打开表单后内容溢出整个窗口**：截图里表单的 checkbox 文字被挤成竖排，取消/保存按钮和底部的
   「重启 DSH 服务 / 关闭」挤在窗口最底部、部分被裁掉。根因在 `electron/src/mcp-ui/index.html`：
   `main { height: calc(100vh - 128px) }` 硬编码高度、`body` 不是 flex 列、`main` 自身不滚动，
   所以表单比这个固定高度高时只能溢出到 footer 外面；同时 `.row > label { flex-direction: column }`
   也作用在 checkbox 的 label 上，勾选框被堆到文字上方，两个 checkbox 还各占半行。
2. **stdio MCP 的「启动命令」要手填 Node 路径**：用户一直手写 `D:\node\node.exe`。壳自己就随包带了
   Node（打包后在 `resources/app.asar.unpacked/dsh/bin/node.exe`，开发时在
   `electron/runtime/dsh/bin/node.exe`），没有理由让用户去猜路径。

## Decision

### 1. 单页滚动 + 固定 footer

`html, body { height: 100% }`，`body` 变成 flex column；header 与 footer `flex: none`；`main`
`flex: 1 1 auto; min-height: 0; overflow-y: auto`，删掉 `calc(100vh - 128px)`。`.panel` 改为自然高度
（`flex: 0 0 auto`），`.scroll` 不再自带 `overflow`：表单、列表、卡片都随 `main` 一起滚，只有一根滚动条。
toolbar/footer 允许换行、footer 按钮 `flex-shrink: 0`、状态文字可换行，窄窗口不裁切。

checkbox 行给 label 加 `class="check"`：`.row > label.check { flex: 0 0 auto; flex-direction: row;
align-items: center; }`，勾选框与文字同一行、按内容宽度排列。

### 2. Node 路径自动检测（页面 + 主进程双保险）

- 纯函数 `resolveNodeExecutable({ bundledBinDir, environment, exists })`：先找随包运行时
  `bin/node.exe`，再找 `DSH_DESKTOP_NODE_EXECUTABLE`；都没有返回 `missing`。`main.ts` 的
  `installMcpWindow` 用 `runtimeBinDir()`（打包后指向 `app.asar.unpacked/dsh/bin`）调用它，只把存在
  的路径交给窗口。
- 新 IPC `mcpNode` + preload `__DSH_MCP__.node()`：页面拿到 `{ path, source, exists }`；`source`
  只用于提示文案（随包 / 环境变量）。
- 页面：新增 MCP 时（以及编辑 stdio 且 command 为空/裸 `node`）自动填入检测到的路径；启动命令下方
  `#nodeHint` 说明来源，旁边 `#detectNode`「自动检测」可重新填入；检测不到时明确提示仍可手填或留空
  交给 PATH。
- 保存归一：纯函数 `resolveStdioCommand(input, nodePath)` 只对 stdio 生效——空 command、`node`、
  `NODE.EXE` 这类裸命令替换成检测路径；绝对路径/其他启动器**永不改写**。前端保存前调用一次，
  `mcpSaveServer` 后端再调用一次，绕过页面的调用方也得到同样结果。

## Alternatives considered

- **只写 `command: "node"` 交给 PATH**（最强理由：配置不绑定安装路径，换机器/换安装位置都能用）→ 弃：
  MCP 服务器由 DSH 子进程 spawn，PATH 里是否恰好有随包 `bin` 取决于启动方式和环境；写绝对路径能把
  「用了哪个 Node」变成可见事实，且安装目录在自动更新中不变。用户想改回 PATH 解析仍可自己填 `node`。
- **用 `where node` 探测系统 Node**：系统可能没装 Node、版本也可能过旧；壳随包的 Node 是校验过、与
  DSH 同版本的，优先用它。环境变量作为无随包运行时（开发/特殊安装）的退路。
- **自动改写用户已有的 `D:\node\node.exe`**：用户可能故意用带全局模块的系统 Node；只有空/裸命令才补，
  已有绝对命令不动，另给「自动检测」按钮由用户主动替换。
- **给表单/列表各自内部滚动**：会重新引入「双滚动条」，和用量窗口 0.4.7 修过的问题同源；整页一根滚动
  条、footer 永远在窗口底部。
- **只把 `main` 高度改成 `max-height` / 给 body 加 `overflow:auto`**：footer 仍会被内容推走或盖住；
  用 flex 布局让 footer 自然贴底，main 独自滚动。

## Evidence

- 单测：全量 `node scripts/run-tests.mjs` → **589 pass / 0 fail / 8 skipped**（`mcp-ui.test.ts` 与
  新建 `mcp-window.test.ts` 覆盖布局静态断言、Node 检测顺序、空/裸/绝对命令归一、streamable-http 不动）；
  `tsc --noEmit` 干净；`node build.mjs` 成功。
- 隐藏 Electron 页面 harness（真实 `dist/mcp/index.html` + stub 桥）：**23/23 通过，0 console error**：
  900×720 与最小 720×520 下 `documentElement.scrollHeight === innerHeight`（无页面级溢出），唯一纵向
  滚动容器是 `main`，footer 完整可见；720×520 滚到底后取消/保存可达；新增表单 command 自动填入检测路径、
  `#nodeHint` 文案正确；两个 checkbox 计算样式 `flex-direction: row`、不再各占半行。
- dev 壳菜单冒烟：`mcpWindow.loaded=true`、`mcpBridge.reachable=true`，其余窗口/菜单无回归。
- 截图：`.tmp-perf/mcp-ui/shots/mcp-900x720.png`、`.tmp-perf/mcp-ui/shots/mcp-720x520.png`（不入库）。
- 发版：v0.4.10 已发布（安装包 235,029,017 B + sig、DSH.Pocket.apk 1.0.3(4) 3.56 MB、latest.json version=0.4.10），打包组合校验通过；elease/win-unpacked/resources/app.asar.unpacked/dsh/bin/node.exe 实测存在（92.5 MB）。

## Consequences

- MCP 配置里现在会写入**安装目录下的随包 Node 绝对路径**（如
  `C:\Program Files\DSH Desktop\resources\app.asar.unpacked\dsh\bin\node.exe`）。自动更新保持同一路径；
  如果用户把应用目录整体搬走，或在不带随包运行时的环境里复用同一 profile，需要把 command 改回 `node`
  或自己的 Node——页面会显示检测不到并允许手填。
- 「自动检测」只会覆盖空/裸 `node`，绝不覆盖用户填的绝对命令；检测不到时保持现状并提示。
- MCP 窗口从此只有 `main` 一根纵向滚动条，footer 的「重启 DSH 服务/关闭」始终在视口内，表单再长也
  不会把按钮挤出窗口。

