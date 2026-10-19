# Agent Note: 用量小浮窗、一次扫码登录与手机访问"记住"（0.4.7）

Status: implemented

## Problem

0.4.6 上线后用户对两个壳窗口提了六点，前三点在用量窗口，后三点在手机访问：

1. **扫码登录要扫两次**：用量窗口显示的二维码扫出来是一张"新二维码"，识别那张才能登录。根因在
   `oneway-service.startLogin`：企微的 `https://login.work.weixin.qq.com/wwlogin/sso/qrcode?key=<web_key>`
   **本身就是登录二维码的 PNG**（实测 200 image/png，1.7 KB），旧代码却把这个图片 URL 再生成成二维码，
   于是手机扫到的是"打开二维码图片的网址"。
2. **用量首页有两条纵向滚动条**：`main` 与内层 `.table-wrap`（以及趋势/渠道列表）各自 `overflow`
   +`max-height`；设置入口在最底部，想改刷新间隔得滚到底。
3. **没有快速摘要**：看三个 token 数字必须打开整个窗口（原 DSH 插件有 hover 小卡片）。
4. **公网访问重启后不记得开着**：`pocket-service` 的 `dispose()` 调 `stopPublic(true)`，把
   `{accepted, mode, domain, token}` 整条记录从 `pocket.json` 删掉；下次启动 `restoreTunnel()` 因
   `accepted !== true` 直接返回，用户必须手动再开一次。
5. **Tunnel Token 每次重填**：用户点「关闭公网访问」或一次启动失败都会 `persistTunnel(undefined)`，
   token 跟着丢；下次开启只能回 Cloudflare 再复制一遍。
6. **局域网二维码只带地址**：手机扫码后仍要在手机上读电脑屏幕的 8 位密码再手输，失去"扫码即连"的意义。

## Decision

### 1. 登录二维码直接显示企微返回的 PNG

`startLogin` 拿到 `web_key` 后，用同一个 `fetchImpl`（带桌面 UA 与超时）GET 该 PNG，校验
`200` / `content-type: image/*` / 非空 / < 1 MB，转成 `data:<type>;base64,…` 存进 `LoginFlow.qrDataUrl`
（一次 flow 只取一次，窗口重开复用同一张码）。失败抛可显示的中文错误。扫码之后的 poll / SSO
callback / cookie 逻辑完全没动。验证：单测把 HTML 与 PNG 分流 mock 并断言 data URL 解码后等于
mock 字节；真实网关冒烟拿到 1734 字节、PNG 魔数 `89504e47`。

### 2. 用量页改成"整页唯一纵向滚动"

`main` 是唯一纵向滚动容器；`.table-wrap` 只保留 `overflow-x:auto`（窄窗口横向滚动），去掉
`max-height` 与纵向 `overflow`；趋势/渠道列表同理。设置 `<details>` 从 main 底部移到 cards 之前，
topbar「立即刷新」旁新增「设置」按钮切换它并滚到可见（aria-expanded 同步）。

### 3. 用量按钮的 hover 卡片 = 独立的小窗口，不是拉长标题栏

新增 `UsagePopoverWindow`（300×150、frameless、`focusable:false`、`skipTaskbar`、
`setAlwaysOnTop('pop-up-menu')`、`setIgnoreMouseEvents(true, {forward:true})`、`showInactive`）：

- 标题栏 hover 时把按钮的视口矩形通过 `titlebar → main` 的 IPC 发出去；mouseleave 延迟 180 ms 收起；
  点击按钮先收起卡片、再走原来的 `popupShellMenu('usage')`。
- 位置在主进程算（`usagePopoverPosition` 纯函数，单测覆盖负坐标/贴右/贴底/第二显示器）：
  窗口内容区原点 + 按钮矩形，再 clamp 到**按钮所在显示器**的 workArea。
- 数据仍然只在主进程：页面通过 `__DSH_USAGE_POPOVER__` 只能 `get()` 和订阅 `onState`，CSP
  `default-src 'none'`，无网络、无 innerHTML；每次 show 由主进程推一份 `toUsagePopoverState(snapshot)`。
- 主窗口 blur/hide/minimize/move/resize、任何菜单弹出都会收起卡片。
- 冒烟 `driveSmokeMenu` 直接 show/probe/hide 卡片，结果进 `menu-smoke.json`。

### 4. 手机访问的"记住"分成三件事

- **退出 ≠ 关闭**：`dispose()` 改为 `stopPublic(false)`——只停隧道，保留记录；下次启动
  `restoreTunnel()` 能恢复"用户还开着"的公网访问。用户主动关闭仍是 `stopPublic(true)`，只撤销
  `accepted`，重启不会偷偷重开。
- **Token 属于"连接方式"，不属于"开启状态"**：新增 `revokeTunnelAcceptance()`，关闭/启动失败只写
  `accepted:false`，保留 `mode/domain/token`；`setTunnelToken('')` 按页面「留空则不修改」的承诺保留旧
  token。启动时恢复失败也保留 `accepted`（`startPublic(…, keepAcceptanceOnFailure=true)`），一次网络/
  代理抖动不会把"记着开着"变成"永久关闭"；用户亲手点的启动失败仍撤销，避免后台反复重试。
- **扫码即连**：二维码 payload 改成 `dshpocket://connect?url=<编码地址>&password=<编码密码>`
  （`pocketConnectLink`，单测做过 QR 编码→解码往返）。局域网与公网二维码都用它，cellSize 4 以适配窄
  面板。Android 端 `PocketAddress.connectLink()` 解析地址+密码，`MainActivity` 在深链与 App 内扫码两条
  路径上都自动填两个输入框；纯地址二维码仍走原来的 `normalise` 回退，不会弄坏旧码。APK 版本升到
  1.0.2(3)。

### 5. 打包校验补上 hover 卡片

`verify-package.mjs` 的壳页面清单加 `dist/usage-popover/index.html` + `__DSH_USAGE_POPOVER__` 桥断言：
页面没进 asar 时 hover 会弹一个空白小条，这种"装了但空白"正是这个脚本存在的理由。

## Alternatives considered

- **在用量页里画二维码（页面自己 fetch 图片）**：页面 CSP 是 `default-src 'none'`、无网络，这是刻意的
  安全边界；为了一张图打开网络不划算。留在主进程取图。
- **保留"扫码两次"并在页面写提示**：能最快修，但用户每次登录都要多扫一次，且这不是可解释的产品行为。
- **把 hover 卡片做成标题栏 WebContentsView 的延伸**：标题栏只有 36 px，拉长会盖住 DSH 页面并抢走
  鼠标/焦点；独立窗口才能既浮在上面又不影响输入。原生 tooltip 又放不下三个数字和主题。
- **用 `settings.pocketTunnelEnabled` 单独决定是否自动恢复**：这个设置只说明"上次开着"，用户主动关闭后
  它被写成 false，但崩溃/异常退出时可能与 `accepted` 不一致；恢复的授权依据只能是 `accepted` 记录。
- **关闭时保留整条记录且保留 accepted**：重启会自动重开用户刚关掉的公网入口，违背"每次开启都要人确认"。
- **Token 存进 `shell-settings.json`**：那是用户可编辑、会被整份重写的配置；凭据继续留在 `pocket.json`
  （0600、原子写）。
- **把密码放进普通 http URL（userinfo 或 query）**：浏览器/网关都不认 userinfo；App 的 `normalise` 会把
  地址归一成 origin 并丢掉 query。只有自定义 scheme 能同时携带地址和密码。

## Evidence

- 单测：`node scripts/run-tests.mjs` → 568 pass / 0 fail / 8 skipped；`tsc --noEmit` 干净；
  `node build.mjs` 成功。
- 用量登录：真实网关 `startLogin()` 546 ms，返回 `data:image/png;base64,…`，解码 1723 字节、
  PNG 魔数 `89504e470d0a1a0a`，key 16 字符（一次扫码即可登录）。
- 布局/浮窗：页面布局 harness 14/14 PASS —— `main` 是唯一纵向滚动容器（854>567），`.table-wrap`
  computed overflowY 为 `hidden`（显式 `overflow-y: clip`，不再独立纵向滚动、maxHeight none），
  `#settingsToggle` 在 topbar、`#settingsBox` 在 cards 之前；popover 三指标 + `default-src 'none'`
  + `__DSH_USAGE_POPOVER__`；pocket 文案含「扫码打开 Pocket App 会自动填入地址和密码」。
- dev 壳冒烟：11/11 PASS —— `usagePopover{loaded:true,bridge:true,selectors×3:true,hidden:true}`；
  app/plugins/pocket/usage 四菜单 opened；usageWindow/mcpWindow loaded+bridge；pocketWindow loaded；
  真实开启局域网网关（`http://10.1.6.35:47904/`）且设置持久化；无插件 import 失败。
- 手机访问持久化：`pocket-service/pocket-state/pocket-qr` 31/31 PASS，含 dispose 保留记录、同状态重建后
  restore 复用 token、用户关闭过不自动开、stop/failed start 保 token、空 token 不覆盖、failed restore
  保留 accepted。
- Android：`gradlew :app:testDebugUnitTest` BUILD SUCCESSFUL；PocketAddressTest 13/13（含密码解析）、
  PocketClientTest 11/11；APK 1.0.2(3) 随 0.4.7 发布。
- 截图与完整报告：`.tmp-perf/verify-002/REPORT.md`、`.tmp-perf/verify-002/shots/`（不入库）。
- 发版：v0.4.7 已发布（安装包 235,016,967 B + sig、`DSH.Pocket.apk` 1.0.2(3) 3.56 MB、`latest.json`）；
  发版门禁的打包组合校验通过（`组合校验：4 个随壳插件与 MCP 行在打包 dsh 里真实挂载…`），
  `latest.json` 匿名可读且 version=0.4.7，安装包与 APK 匿名 HEAD 均 200。

## Consequences

- Tunnel Token 会在用户主动关闭公网访问后继续留在 `pocket.json`（0600）——这是"不要每次重填"的代价；
  目前没有显式清除 token 的 UI，`setTunnelToken('')` 表示"不修改"。
- hover 卡片多了一个 BrowserWindow，但它不可聚焦、不接收鼠标、不进任务栏；主窗口拖动/最小化即收起。
- 扫码自动填密码依赖 Pocket App 1.0.2+；未装 App / 旧版 App 仍可按页面上的地址与密码手动连接（旧纯地址
  码继续兼容）。
- 登录二维码 PNG 在 flow 内缓存 10 分钟；企微侧提前失效时仍走原有"已过期，请刷新二维码"分支，行为不变。
- 用量页表头 sticky 的滚动容器随 `.table-wrap` 改变，页面整体滚时表头不再吸顶（此前只在小盒子里吸顶，
  视觉无新增问题）；若以后要页面级吸顶需换表格结构。
