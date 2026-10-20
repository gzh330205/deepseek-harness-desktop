# Agent Note: 导入弹窗默认打开且关不掉：`display:flex` 盖掉 `[hidden]`（0.4.13 修复）

Status: implemented

## Problem

0.4.12 发布后用户打开「MCP 与 Skills」窗口，发现「导入 MCP 配置」弹窗一进来就开着，点 ×、取消、按 Esc、点遮罩都关不掉，整窗被半透明遮罩挡住无法操作。

根因只有一处 CSS 优先级问题：

- 弹窗根节点是 `<div class="modal-mask" id="importModal" hidden>`，脚本靠 `importModal.hidden = true/false` 开关；
- `.modal-mask` 为了居中写了 `display: flex`。作者样式优先于浏览器默认样式表，UA 的 `[hidden] { display: none }` 被盖掉，所以 `hidden` 属性为真时元素仍然 `display:flex` 铺满全屏；
- 关闭逻辑（× / 取消 / 遮罩 mousedown / Esc）其实都执行了，`hidden` 也确实变成 `true`——只是视觉上看不出来，于是表现为「关不掉」。

这是 0.4.12 新加的弹窗独有的问题：同一页里 `#serverForm`、`#nodeHint` 都显式写了 `[hidden]` 覆盖规则，`.modal-mask` 漏了。

## Decision

1. 在 `electron/src/mcp-ui/index.html` 的 `.modal-mask` 后补一条显式规则：
   `.modal-mask[hidden] { display: none; }`，并留注释说明 flex 容器必须自带 `[hidden]` 覆盖，否则又被下一次改样式踩回去。
2. 静态测试加断言 `\.modal-mask\[hidden\] \{ display: none; \}`，让「只写 `hidden` 不写覆盖」的改动在单测阶段失败。
3. 隐藏窗口验收脚本补两条真实计算样式断言：首帧 `hidden === true && getComputedStyle(...).display === 'none'`，打开后 `display === 'flex'`。属性为真但画出来，正是这类 bug 的盲区，只看 `.hidden` 布尔值抓不到。

## Alternatives considered

- **改用 `class="open"` 控制显隐**：能绕开 `[hidden]` 优先级，但要改全部开/关/状态查询代码，且以后每个弹窗都得自带两套类名规则；显式 `[hidden]` 覆盖更小、更符合本页既有写法。
- **把 `.modal-mask` 默认 `display:none`、打开时加类**：同样要改 JS，还会让「忘记加类」从「弹窗一直开」变成「弹窗永远不开」，失败方向更隐蔽。
- **只改 JS 在关闭时设 `style.display='none'`**：治标，首帧仍然会闪一下遮罩，且下一个弹窗会重犯。

## Evidence

- 修复：`electron/src/mcp-ui/index.html` 新增 `.modal-mask[hidden] { display: none; }`；`electron/src/mcp-ui.test.ts` 增加静态断言。
- 隐藏 Electron 验收（`.tmp-perf/mcp-import/main.cjs`，真实构建页 + stub 桥）：27/27，其中新增 `modal starts closed on first paint`、`an open modal is actually painted`；完整流程（打开 → Codex 解析 → 导入 → 文件选择 → Claude 冲突覆盖 → Esc）仍全绿。
- 单测：631 tests / 623 pass / 0 fail / 8 skipped；`npx tsc --noEmit` 通过；`node build.mjs` 通过。
- 发版：v0.4.13 已发布（安装包 235,147,490 B + sig、`latest.json` version=0.4.13；APK 仍为 1.0.3(4)），打包组合校验通过。

## Consequences

- 弹窗首帧不再可见，所有关闭路径（× / 取消 / 遮罩 / Esc / 导入完成）恢复可用。
- 之后给任何 `display:flex/grid/block` 的容器加 `hidden` 开关，必须同时写 `[hidden]` 覆盖规则；静态测试 + 计算样式断言是这条规则的护栏。

