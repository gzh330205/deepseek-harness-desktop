# P2 验证记录：面板桥、设置页与任务感知

> 执行时间：2026-09-28
> 代码位置：`electron/`（壳）+ `src-tauri/resources/dsh-desktop-shell/`（插件，两个壳共用）
> 关联：[迁移评估](tauri-to-electron-migration.md) · [P0 验证](electron-p0-verification.md) · [P3 验证](electron-p3-verification.md)

## 0. 结论

DSH 设置页的「桌面端」在 Electron 壳下**完全可用**，且插件**一行未改**（只做只增不改的路由扩展）。同时落地了 A1：壳现在能向 DSH 询问「现在停掉会打断什么」，并把它接进**安装更新**与**退出**两处确认。

```
开发态与打包产物两轮冒烟的同一组证据：
panelReady      = true                                  插件就绪路由可达（带会话认证）
panelSettings   = { read: true, write: true, revision: 0 }  设置读 + 一次性 token 写全通
panelEventCount = 1                                     页面发 3 条消息，仅 1 条白名单动作被接受
hasTauriBridge  = true                                  产品页拿到 event.emit / event.listen
tasks           = { answer: "idle", families: [], sessions: 1 }
```

## 1. 面板桥为什么需要一层兼容层

设置页的客户端半边（`client.js`）**不通过 HTTP 通知壳**，而是用 Tauri 事件：

| 方向 | 机制 | Electron 里的处置 |
|---|---|---|
| 页面 → 壳 | `__TAURI__.event.emit('dsh-desktop-shell', { action })` | preload 暴露**窄兼容层** |
| 壳 → 页面 | `event.listen('dsh-desktop-state', …)` | 同上，壳用 `panelState` 频道推送 |
| 读设置 | `GET {ROUTE}/state` | 本来就走 HTTP，无需改动 |
| 写设置 | `GET {ROUTE}/bootstrap` + `PUT {ROUTE}/settings` | 同上 |
| 系统通知 | `__TAURI__.event.emit('dsh-win-notify', {title,body})` | 兼容层转发到 Electron `Notification` |

兼容层只暴露**两个方法**，且两侧都设白名单：

- preload 侧：只允许 emit `dsh-desktop-shell` / `dsh-win-notify`，只允许 listen `dsh-desktop-state`；
- 主进程侧：发送方必须是主窗口的**主 frame**、且 URL 是 loopback 来源；`action` 必须在
  `settings-changed` / `restart-dsh` / `check-desktop-update` / `show-about` / `focus-main` 之内。

没有 `core.invoke`、没有路径/文件 API。页面即使拿到这个对象，也只能请求上面那几个动作——
这比 Tauri 版的 `withGlobalTauri: true`（整包 API 注入）面更窄。

**冒烟用「三发一中」证明白名单真的生效**：页面依次 emit 一个合法动作、一个非法动作、一个非法事件名，
主进程只接受第 1 条（`panelEventCount = 1`）。

## 2. A1：任务查询

不猜内部状态，用 DSH 自己的公开机制：`workspace/session-activity` 是一个 cordis
waterfall 事件，由 `dsh-agent`（运行中的回合，含子代理与等待审批）、`dsh-jobs`
（运行中/停止中的后台任务）、`dsh-schedule`（已挂定时器）、`dsh-subagent`、
`dsh-workspace` 各自累加 family。插件对每个**已加载**会话派发一次：

```js
answer = await ctx.waterfall('workspace/session-activity', { sessionId }, () => []);
```

> 第一版漏了结尾的 `() => []`（waterfall 的终结回调，其返回值是累加基数），
> 现场报 `TypeError: next is not a function`。已按 cordis 真实用法修正。

规则（与官方口径一致）：

- 有任何 family 有 item → `active`；
- 没有 → `idle`；
- **任何一步拿不到答案 → `unknown`**（sessions 服务缺失、派发抛错、路由不可达、超时），
  绝不把「查不到」当成「没任务」。

壳侧消费：

| 场景 | 行为 |
|---|---|
| 点「安装并重启」 | `idle` 直接装；`active`/`unknown` 弹确认，取消则回到更新窗口 |
| 关闭窗口 / 托盘退出 | `idle` 直接退；`active`/`unknown` 弹确认，取消则留在应用内 |
| DSH 从未就绪 | 直接放行——没有宿主就不可能有任务（官方同款规则） |

> 对话框文案由 `describeTasks()` 生成，把 family 映射成「后台任务 / 运行中的回合 /
> 已挂定时器 / 子代理 / 工作区活动」，同一条重复 family 折叠成一行。

## 3. 设置项现在真的生效

| 设置 | 壳侧行为 |
|---|---|
| `closeBehavior: minimizeToTray \| exit` | 关窗时隐藏到托盘或退出；兼容旧的 `tray` 拼写 |
| `service.port` | 启动时决定端口（优先级 `DSH_DESKTOP_PORT` > 设置 > 41729） |
| `proxy.*` | 注入子进程环境变量；关闭时显式清除 |
| `updates.checkDesktopOnStart` | 关掉则跳过启动时的静默检查（菜单/托盘仍可手动检查） |
| `updates.checkDshOnStart` | 已读取；Electron 壳暂无独立的 DSH 更新检查，字段保留 |

「保存并重启 DSH」的服务端语义是换环境变量（代理）与端口，这两者都是**子进程的启动输入**。
Electron 壳用 `app.relaunch()` 重启整个桌面端，而不是只换 DSH 子进程：

- **理由**：只重启子进程需要把 `boot()` 拆成可重入的状态机，并处理「重启期间窗口仍指向旧端口」的时序；
  整壳重启几十行就够，且用户看到的结果一致（设置生效）。
- **代价**：窗口会闪一下。若将来要做「只重启 DSH」，这里是唯一的改动点。

## 4. 新增/改动文件

| 文件 | 说明 |
|---|---|
| `electron/src/panel-bridge.ts` | 兼容层的壳侧客户端：`ready()` / `tasks()` / 设置读写自检 |
| `electron/src/panel-bridge.test.ts` | 8 项测试：就绪、`idle`/`active`/`unknown` 映射、文案、设置往返、写入被拒 |
| `electron/src/preload.ts` | 产品页的窄 `__TAURI__` 事件兼容层（双白名单） |
| `electron/src/main.ts` | 事件接收与来源校验、5 个白名单动作、状态回推、任务确认、关闭行为、更新开关 |
| `electron/src/settings.ts` | 对齐插件 schema（`closeBehavior` 取值、`updates` 开关） |
| `electron/src/gates.ts` | **修复**：版本探测改为正则提取（见第 5 节） |
| `src-tauri/resources/dsh-desktop-shell/index.js` | **只增**：`GET /ready`、`GET /tasks` 两个路由 + 一个聚合函数 |

## 5. 打包冒烟时暴露并修复的一个真 bug

打包产物第一次跑 P2 冒烟时闸门直接失败：

```
"message": "当前 DSH received. 低于最低支持版本 0.1.2-alpha.2"
```

原因：版本探测取的是「`stdout`+`stderr` 的最后一个空白分隔 token」。打包环境下探测输出尾部多了一行
无关文本，最后一个词成了 `received.`，于是一个完全正常的 dsh 被判定为版本过低。

修复：改为按 SemVer 形状正则提取，`stdout` 优先、`stderr` 兜底；解析失败时把原始输出带进失败详情。
测试里钉住了「`0.1.7-rc.2\nnotice: response received.` → `0.1.7-rc.2`」这条回归。

## 6. 测试

```
npx tsc --noEmit   → 通过
npm test           → 32/32 通过
  · 脱敏与认证地址解析（4）
  · 三道闸门、版本比较与版本提取（5）
  · minisign 校验（5）
  · 更新通道（7）
  · 旧版检测匹配规则（5）
  · 面板桥（6）：就绪、idle/active/unknown、文案折叠、设置往返、写入被拒
```

## 7. 端到端验证

| 轮次 | 命令 | 结果 |
|---|---|---|
| 开发态 | `DSH_DESKTOP_PORT=41736 node scripts/smoke.mjs cookie --isolate-home` | PASS，5 项面板证据全绿 |
| 打包态 | `node scripts/smoke.mjs cookie --isolate-home --packaged`（端口 41738） | PASS，同样全绿；DSH 界面 467 节点 |

## 8. 未验证 / 已知边界

| 项 | 说明 |
|---|---|
| `tasks = active` 的活体路径 | 需要真的跑一个 agent 回合（或后台任务）才能产生，会消耗用户额度，未触发；壳侧的 `active` 分支由单测覆盖（构造 family 的服务端桩） |
| `restart-dsh` 的实际点击 | 会重启桌面端，未在自动冒烟里触发（smoke 下不点按钮）；逻辑与 `app.relaunch()` 直连 |
| 设置页 UI 的目视确认 | 冒烟只验证了它的 HTTP/事件契约，没有截图比对渲染结果 |
| `dsh-win-notify` | 转发了事件，但没有在真机上目视确认弹窗 |
