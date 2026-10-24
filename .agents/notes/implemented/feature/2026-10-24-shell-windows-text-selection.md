# Agent Note: 壳窗口支持选中与复制文本（0.4.17）

Status: implemented

## Problem

壳自己弹的窗口——插件市场、手机访问、用量、设置——都沿用了「像原生应用」的交互：`body { user-select: none }`。这挡住了误选中，也顺带把用户想复制的内容一起挡住了：

- 用量窗口里的模型名、渠道名、请求 ID、错误文案复制不了；
- 手机访问窗口里的局域网地址、公网地址、Tunnel Token 说明只能手抄；
- 插件市场里的包名、版本、失败原因复制不了；
- 即使页面某块单独写了 `user-select: text`，用户还得先知道哪里能选；而 Electron 默认不弹右键菜单，选中后也只能靠 Ctrl+C。

用户的原话是「有些时候想提取里面的文字没办法」。

## Decision

1. 四个页面的根样式从 `user-select: none` 改为 `user-select: text`，再用一条窄规则把交互控件（`button` / `summary` / 页签 / 卡片操作区）设回 `none`，保住「点按钮不会拖出蓝色选区」的手感。`mcp-ui` 本来就可选，不动。
2. 新增 `electron/src/context-menu.ts`（纯决策，不 import electron）与 `context-menu-install.ts`（接线）：
   - `isCopyableShellUrl` **只认 `file://` 且路径以壳页面结尾**。DSH 产品窗口是 loopback HTTP，必须保留它自己的右键行为；
   - 可编辑控件给「撤销/重做/剪切/复制/粘贴/全选」；有选区给「复制/全选」；空白处也给「全选」，让不用键盘的用户能起选；
   - 用 Electron 内置 role 而不是手写 `clipboard` 调用，焦点/可用态由 Chromium 自己算。
3. `main.ts` 在 `whenReady` 里、`boot()` 之前调用 `installCopyContextMenus()`，保证监听先于任何窗口创建；静态测试钉住这个顺序。

## Alternatives considered

- **只把 `user-select` 改成 `text`**：能选中，但没有右键菜单，用户仍要会 Ctrl+C；而且「为什么这里能选、那里不能选」还是靠猜。加菜单才把「提取文字」变成可发现的操作。
- **全局 `app.on('web-contents-created')` 不判 URL，所有窗口都加右键菜单**：最省事，但会给 DSH 产品页也塞一个壳风格的菜单，和产品自己的交互、未来的编辑器右键菜单冲突。URL 白名单多一行，边界清楚。
- **在每个页面里手写 `contextmenu` 监听 + `navigator.clipboard`**：要五份重复代码，还绕不开「页面拿不到系统剪贴板权限/焦点」的边界；主进程 role 更稳。
- **给 `usage-popover`、标题栏也加**：这两处是纯展示的悬停卡片/窗口拖拽条，没有可提取的长文本，加了只会多一个空菜单。不加。

## Evidence

- `electron/src/context-menu.test.ts`：6/6——URL 白名单（含拒绝 loopback/弹窗/标题栏）、可编辑/有选区/空白三种模板、四个页面 CSS、`main.ts` 安装顺序。
- 全量：`node scripts/run-tests.mjs` 640 tests / 632 pass / 8 skipped；`npx tsc --noEmit` 通过；`node build.mjs` 通过。
- 发版：v0.4.17（安装包与 `latest.json` 校验通过）。

## Consequences

- 壳窗口里任何可见文字都能拖选，右键有复制/全选；输入框右键有完整剪贴板菜单。
- 交互控件仍不可选，避免点按钮时出现选区；以后新加壳页面若也要可复制，需要同时进 `COPYABLE_SHELL_DOCUMENTS` 并去掉根部的 `user-select: none`。
- DSH 产品窗口的右键行为没有被改动。
