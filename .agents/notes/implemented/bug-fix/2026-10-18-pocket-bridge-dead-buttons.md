# Agent Note: 手机访问窗口的「开启公网访问」与「关闭」两个死按钮（0.4.4 修复）

Status: implemented

## Problem

用户在 0.4.2 里配好公网隧道（域名、Token、转发端口都保存成功），点「开启公网访问」没有任何反应；
右下角「关闭」也关不掉弹窗。两条症状都发生在**手机访问窗口**里，其它按钮（局域网开关、密码、二维码）
看起来正常。

代码里两处独立的缺陷，恰好都在 `settings-window.ts` 的 IPC 桥里：

1. **动作被桥丢弃**。`ipcMain.handle(IPC.pocketAction, …)` 还在用手写的三项目名单
   （`rotate` / `setPassword` / `select`），其余一律落到 `default: pocket({ kind: 'refresh' })`。
   页面后来长出来的 `startTunnel`、`stopTunnel`、`rotatePublicPassword`、`setPublicPassword`、
   `setTunnelToken`、`firewallCheck`、`firewallAllow` **全部**被降级成「只刷新状态」。
   所以「开启公网访问」前面的 `save()` 会成功（设置真的存了）→ 确认框 → `startTunnel` 变成 refresh →
   页面把旧状态画回来，看起来就是按钮没反应。
2. **关闭关错了窗口**。`IPC.settingsClose` 的处理器安装在**设置窗口**那个 `SettingsWindow` 实例上
   （handler 全局只注册一次，两个壳页面共用），处理器里写的是 `this.close()` —— 于是手机访问页点「关闭」
   永远关的是设置窗口，自己纹丝不动。

## Decision

**桥不再维护动作白名单，只做一次解析与转发；关闭一律关闭发起请求的那个窗口。**

- `pocket-action.ts`（新）：`PocketAction` 类型、`POCKET_ACTION_KINDS`、`parsePocketAction()`。
  解析器按 kind 逐字段归一化（`setPassword`/`setPublicPassword`/`setTunnelToken` 只收字符串、
  `select` 只收 address、`startTunnel` 只认字面量 `true`），无法识别的一律降级成 `refresh`。
- `settings-window.ts`：`pocketAction` 处理器只调 `parsePocketAction` 后**原样转发**给
  `handlePocketAction`（main.ts 本来就有完整 switch）；`settingsClose` 改用
  `BrowserWindow.fromWebContents(event.sender)` 找到发请求的窗口，并在 `setImmediate` 里关闭。
- `driveSmokeMenu()`（`DSH_DESKTOP_SMOKE_MENU=1`）现在真的驱动一次桥：用非法公网密码触发
  `setPublicPassword`（服务必须回错误，`refresh` 不会），再调用 `close()` 并要求窗口真的关闭。
- 新增 `pocket-action.test.ts`：每个 kind 原样往返；页面脚本里出现的每个 `kind: '…'` 都必须在
  `POCKET_ACTION_KINDS` 里；桥处理器必须用 `parsePocketAction`、关闭必须用发送者窗口。

## 为什么 0.4.2 的冒烟没抓到

`SettingsWindow.probe()` 只证明「页面画出来了 + `__DSH_SETTINGS__` 存在」——它自己的注释就写着
「preload 没跑也会画出标记，所有控件都是死的但窗口看起来正常」。静态测试（`pocket-ui.test.ts`）
只核对元素 id 与关键文案，核对不到「点击后 IPC 有没有到主进程」。这两个缺陷恰好都发生在这条缝里：
页面完好、桥对象存在、点击也有反应（页面还显示"操作失败"以外的旧状态），只有动作在半路被吞掉。

## 验证

- 菜单冒烟（dev，修复后）：`pocketBridge.actionForwarded: true`、`pocketClose:
  { acknowledged: true, windowClosed: true }`、页面 `loaded: true` / `bridge: true`。
  修复前同一路径会卡死：`close()` 在 IPC 应答返回前销毁 renderer，页面 `await api.close()` 永远不 settle
  —— 这也是为什么关闭要 `setImmediate` 延后一个事件循环。
- 全量测试：465 条 / 457 通过 / 8 跳过 / 0 失败（新增 5 条为本次回归守卫）；`tsc --noEmit` 干净。
- 修复后用户侧：点「开启公网访问」会真的启动 tunnel（成功进「运行中」，失败把错误显示在状态行）；
  「关闭」关的是手机访问窗口本身。
- 已发布 **v0.4.4**（安装包 223.3 MiB，含随包 DSH 0.2.1-rc.2）：打包态 smoke PASS、手机网关 smoke PASS、
  签名自校验通过、匿名复核 `latest.json`=0.4.4 / 安装包 200 / 四个资产齐全。0.4.2 用户更新到 0.4.4 即修复。

## Alternatives considered

- **继续在桥里写显式 switch，补齐所有 kind**（最强理由：一眼能看出桥允许哪些动作）→ 弃：这次 bug 的
  根因就是「页面加了动作、桥忘了同步」，两处枚举必然再次漂移；改为单一词表 + 静态守卫把同步做成测试。
- **把任意对象原样转发**（最强理由：主进程 `handlePocketAction` 已经按 kind 分支，桥不需要懂）→ 弃：
  渲染进程送来的字段会直接进主进程，`value`/`address` 的类型与 `acceptedDisclaimer` 的语义都失去校验。
- **给手机访问窗口单独注册一套 IPC**（最强理由：`this` 语义天然正确）→ 弃：`ipcMain.handle` 同一通道
  只能注册一次，第二次注册直接抛错；按 sender 解析窗口是更小且对任意壳页面都正确的修法。
- **关闭时同步 `requesting.close()`** → 弃：会在 IPC 应答前销毁 renderer，页面拿不到返回值；冒烟实测挂死。

## Consequences

- 以后页面新增动作：只需加到 `POCKET_ACTION_KINDS` 并写进解析器；忘了会有一条失败的静态测试，而不是
  一个上线后静默失效的按钮。
- 关闭按钮的行为变成「关自己」，对设置窗口与手机访问窗口都正确；以后再加壳内页面也自动正确。
- `SettingsWindow` 多了两个 smoke 专用方法（`evaluate` / `isOpen`），只服务于发布前的演练，不进页面 API。
