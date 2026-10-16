# Agent Note: 手机访问网关（局域网，DSH 仍只绑 loopback）

Status: implemented

## Problem

人不在电脑前也要用电脑上的 DSH，第一步是让同一 WiFi 下的手机能打开它。参考项目
[`shaobeichen/dsh-pocket`](https://github.com/shaobeichen/dsh-pocket)（GPL-2.0）已经做过同类功能，
但它是 DSH 插件形态、功能归属在插件里；我们的要求是做进壳、且**不复制它的代码**（本仓库 MIT）。

两个硬约束决定了方案形状：

1. 壳的 DSH 服务只绑 `127.0.0.1:41729`（`host-process.ts` 固定 `--host 127.0.0.1`），这是仓库的
   既有约束，也是访问面的主要防线。
2. DSH 自己的浏览器认证是「一次性 token + `dsh-auth` cookie」，为**本机浏览器**设计——手机没法用。

## Decision

在壳的主进程里放一个**带密码的反向代理**（`electron/src/pocket/` 五个模块），DSH 继续只绑 loopback：

| 模块 | 职责 |
|---|---|
| `pocket-auth.ts` | 无歧义字符表的随机密码、常量时间比较、每 IP 5 次失败锁 60s + 全局失败锁、与进程同生命周期的会话（换密码/关功能即失效） |
| `pocket-net.ts` | 局域网地址枚举与排序（物理网卡优先）、私网判定、**Host 白名单** |
| `pocket-gateway.ts` | 改头反向代理：`Host`/`Origin` 改写到 loopback 权威、注入壳换来的 DSH cookie、HTTP + WebSocket 双向透传、登录页与限流 |
| `pocket-state.ts` | 密码落 `bridgeDir()/pocket.json`（原子写），文件缺失/损坏就换一个新的，而不是拒绝启动 |
| `pocket-service.ts` | 生命周期：开关、选地址、起停、换密码；设置页与 `main.ts` 的唯一入口 |

四条关键决定，都是**刻意不照参考项目做**或踩过之后才定下来的：

1. **公网与局域网分成两个监听器，而不是靠判定 Host/IP 猜。** 参考项目用「Host 是不是私网 + 有没有
   `cf-connecting-ip`」推断公网；我们让局域网口绑局域网地址、隧道口（P3）只绑 `127.0.0.1`——到达隧道口的
   流量**按定义**就是公网。这样「换个自定义域名绕过公网密码」在结构上不存在，而不是依赖判定逻辑不出错。
2. **局域网口强制 Host 白名单。** 只答本机自己的地址，其余一律 403。这条防的是 **DNS rebinding**：
   用户被诱导打开的页面，其域名解析到本机地址，请求会带着 `Host: evil.example` 打过来。局域网密码允许被
   关掉，所以这条是关掉密码后唯一还站着的防线。
3. **认证注入走「cookie 提供者」而不是缓存值。** 壳本来就在主进程里用一次性 token 换 `dsh-auth`
   cookie（`authenticate()`；token 不进页面、不进日志）。网关持有 `() => cookieHeader`，于是 **DSH 重启换了
   token 后网关自动跟上**，不需要人工干预，也不需要把 token 交给网关。
4. **开关与密码的生命周期是产品行为，不是实现细节。**
   - `apply()` 幂等：设置窗口每次保存都会调用它，只有端口真的变了才重启监听——否则用户改个关闭行为就会把
     正在看流式输出的手机踢下线；没跑起来时反而会重试（笔记本后连上 WiFi 靠这条自愈）。
   - 关掉功能＝把手机登出（`sessions.rotate()`）：再打开必须重新输密码，不会悄悄恢复用户以为已关掉的会话。
   - 换密码不重启监听（网关通过回调读密码），但旧会话与旧密码立即失效。
   - 失败锁随进程存在，起停监听不会给攻击者新的尝试次数。
5. **两个方向都不串凭据**：DSH 的 `set-cookie` 绝不转发给手机，手机的会话 cookie 也绝不发给 DSH。

界面在**壳自己的设置窗口**里新增「手机访问」一节（二维码 + 地址 + 密码 + 本机地址选择），符合
「设置只有一个入口」的既有约定；二维码是主进程渲染的 PNG data URL（页面 CSP 已有 `img-src data:`），
页面永远不碰 `innerHTML`。

## Alternatives considered

- **让 DSH 直接绑 `0.0.0.0`**：最强理由是改动最小（一行 `--host`），局域网立刻可用。放弃原因：破坏仓库
  硬约束；公网暴露后只剩 DSH 自己的 token/cookie，没有独立密码、没有失败锁、也没有「局域网/公网两套凭据」
  的隔离面。
- **直接装 `dsh-pocket` 插件**：最强理由是它就是成品（109 个测试、LAN/公网/移动布局全有）。放弃原因：
  用户要求做进壳；它是 GPL-2.0（本仓库 MIT，不复用其代码）；它的端口、凭据文件与隧道进程自成一套，与壳的
  状态/日志体系并行，排障要跨两套系统。
- **自己实现 QR 编码**：最强理由是不引入依赖。放弃原因：QR 的纠错与掩码实现细节多，而「扫不出来」是用户
  无法绕过的失败；改用 MIT 的 `qrcode-generator`（零依赖），并用另一个独立解码器做**编解码往返测试**。
- **把手机登录状态持久化**（写盘、跨重启有效）：最强理由是方便。放弃原因：与「DSH 重启需重输」这一
  安全承诺相矛盾，而那个承诺正是让用户敢开这个功能的理由。

## Consequences

- 手机与电脑同一 WiFi，扫描设置页二维码 → 输一次密码 → 打开的就是电脑上的 DSH，流式输出双向实时；
  `netstat` 可断言 DSH 仍只监听 `127.0.0.1:41729`（对外只有网关端口）。
- 关掉开关会立刻断开手机（`closeAllConnections`），不留半开连接。
- 代价：密码以明文存在 `bridgeDir()/pocket.json`（权限 0600，Windows 下即用户目录）。必须如此——
  设置页要显示它、二维码要承载它；这也是参考项目的做法。
- 已知边界：局域网口目前只枚举 **IPv4**。纯 IPv6 的局域网用不了，需要时再加。

### 实现过程中抓到并修掉的两个真缺陷

1. **升级后的 socket 默认半开**：手机走出 WiFi 只发 FIN，`socket.on('close')` 永远不来——隧道连同背后的
   DSH 会话会一直挂在电脑上。现在 `end`/`close`/`error` 任一到达即幂等收尾；实测断开后 500ms 内计数归零。
   单元测试抓不到它（测试里的客户端会乖乖关连接），是独立复现脚本 + 内存计时才定位到的。
2. **关闭网关时 keep-alive 连接会拖住 `close()`**：用户关掉开关，连接却不断。现在主动
   `closeIdleConnections()` + `closeAllConnections()`。

### 一个只在真实机器上才暴露的坑（写在这里省下一个人半天）

打包态 smoke 一开始报「换域名应返回 403，实际 502，响应体为空」。原因不在网关：这台机器设了
`NODE_USE_ENV_PROXY=1` 加本地 Clash 代理，而 `NO_PROXY` 只含 `localhost`——smoke **自己的 HTTP 客户端**
把 `Host: evil.example` 的请求发给了代理，那个空 502 是代理答的。现在 smoke 用**原始 socket 手写请求**，
既摆脱环境代理，也更贴近「手机/攻击者到底往线路上放了什么」。

## Evidence

- 单元测试 50 条：认证与限流 13、地址与 Host 判定 8、代理（真实 HTTP + WebSocket）14、状态持久化 4、
  生命周期 11。含反向断言：错误密码 5 次锁定、换密码后旧会话与旧密码都失效、关掉再打开必须重新登录、
  同参数保存不得重启监听、空 Host 与畸形 Host 一律拒。
- QR **编解码往返**：`pocket-qr.test.ts` 用自己的模块矩阵光栅化后交给独立解码器（`jsqr`），断言解回来
  与输入逐字相同（含 `10.0.0.9`、域名隧道、带 query 的地址）。
- 设置页静态守卫 6 条（`settings-ui.test.ts`）：单一 `<style>`、`.pocket[hidden]` 兜底、脚本查的每个 id
  必须存在、CSP 仍 `default-src 'none'` 且 `img-src data:`、页面不出现 `fetch`/`innerHTML`。
- **端到端**（`scripts/smoke-pocket.mjs`，新增 `pnpm smoke:pocket`）：真起一个隔离目录的应用实例
  （DSH 41734 / 网关 41735），实测六条标记全中——
  `pocket password persisted` → `anonymous request gets the login page` → `foreign Host refused (403)` →
  `wrong password refused, right password signs in` → `signed-in request is served by DSH, without leaking
  its cookie` → `DSH still listens on 127.0.0.1:41734 only`。
- 套件 423 条 / 417 通过 / 0 失败 / 6 跳过（跳过项都需外部条件：真实网络 E2E、真实 profile）；
  `tsc` 干净。

## 与后续阶段的关系

公网隧道（P3）、Android APK（P2）、移动布局（P4）与发版集成（P5）的计划见
[proposed: 手机访问 + APK](../../proposed/feature/2026-10-16-phone-access-and-apk.md)。
本笔记只锁定已经落地的局域网网关的契约；隧道口将复用同一套认证与生命周期，但**必须是另一个监听器**。
