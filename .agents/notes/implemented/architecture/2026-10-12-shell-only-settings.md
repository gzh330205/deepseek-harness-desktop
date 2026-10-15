# Agent Note: 桌面端设置只留壳一处，移除插件注入的设置页

Status: implemented

## Problem

桌面端的设置曾经有**两套界面、同一份文档**：

- **插件注入的 DSH 设置页「桌面端」** —— 由面板插件 `dsh-desktop-shell` 的 client 半注册 `settings.section`，表单通过插件 host 半的 `GET/PUT /settings` 读写 `shell-settings.json`；
- **壳自己的原生设置窗口** —— `electron/src/settings-window.ts` 走 `IPC.settingsGet / IPC.settingsSave` 直接读写同一份文件。

两套界面都要维护同一组字段、同一套校验、同一套文案（当时甚至有 `settings-parity.test.ts` 专门守住「三套 schema 必须同步」）。字段每加一个，就要在三个地方各写一遍；两者对 `revision` 的理解也各有一套，谁先写谁赢。实际使用中用户只用壳的设置窗口，插件那页成了纯粹的负担与漂移源。

## Decision

**设置的唯一入口是壳自己的设置窗口**，插件不再提供任何设置界面与写入通道：

- 删除 `client.js` 里的 `settings.section` 注册 —— DSH 设置页不再出现「桌面端」；
- 删除 host 半的 `PUT /settings`（含 `writeSettings`、`validatePatch`）—— 插件**再也不能写** `shell-settings.json`；设置写入只走壳的 `IPC.settingsSave`。

**保留 `GET /settings` 与 `readSettings`**，因为它们不是给设置页用的：插件的自身功能要读设置里的 `browser.enabled` / `browser.agentTools` / `browser.autoReleaseSeconds` 来决定侧栏浏览器是否注册与怎么工作，面板状态里的 `pendingRestart` 也来自它。「读」是插件的行为输入，「写」才是被移除的设置功能 —— 一刀切删读会连带弄坏侧栏浏览器。

插件的其余职责全部保留：侧栏浏览器 UI 与标签页、快捷键、会话输入触发、会话运行状态订阅、agent 浏览器原生工具、`sidebar-browser` 技能。

## Alternatives considered

- **两套界面都留（现状）**：留它的最强理由是「用户不必离开 DSH 就能改设置」，而且插件那页已经写好、能用。放弃的原因是它把同一份文档的写权限分给了两个进程两套 UI，字段/校验/文案必须三处同步（已有专门的 parity 测试在替这个设计还债），而用户实际只用壳的窗口 —— 收益为零、成本持续。
- **只删界面、保留 `PUT /settings` 接口**：留给"以后某个脚本/插件用它写设置"的可能性。放弃的原因是这会留下一条**没有界面的写通道**，它绕过壳的校验与 `revision` 语义，正是最难查的一类不一致来源。
- **把壳的设置窗口换成 Web 界面、复用插件那页**：能让设置与 DSH 的 UI 风格统一。放弃的原因是壳的设置窗口要在「DSH 还没起来 / 起不来」时也能用（端口占用、DSH 版本过低正是最需要改设置的时刻），把它绑到 DSH 页面上会把设置能力交给一个可能加载失败的页面。
- **连 `readSettings` 一起删**：表面更彻底。放弃的原因是事实边界：插件读设置是为了决定自己的行为，不是显示设置项；删掉会让侧栏浏览器的开关与 `pendingRestart` 一起坏掉。

## Consequences

- 设置的改动**只有一处**（`electron/src/settings-window.ts` + `settings-shape.ts` + `settings.ts`），不会再出现两套界面不一致；`settings-parity.test.ts` 的前提（壳 schema / 插件校验 / 插件设置页三方同步）随之消失，该文件已退役：插件不再写设置，就没有"三方同步"这回事了。
- 用户在 DSH 里改不了桌面端设置，必须用壳的窗口/菜单 —— 这是刻意的取舍：设置能力不依赖 DSH 页面是否可用。
- 插件 host 半的 `/settings` 只剩只读；`writeSettings` / `validatePatch` 成为可清理的死代码（不影响行为，见下）。
- 已知遗留（不影响行为）：`client.js` 里已无入口的设置页组件/文案/CSS 仍是死代码，`panel-bridge.test.ts` 中有打在这段死代码 + mock 服务器上的用例。清理它们需要可靠的括号配对工具（本项目两次脚本化删除都曾误伤文件，改用行区间/哈希表后正常）。
