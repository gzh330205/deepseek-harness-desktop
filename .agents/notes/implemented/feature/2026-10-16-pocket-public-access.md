# Agent Note: 手机访问的公网门（随包 cloudflared + 第二监听器）

Status: implemented

局域网那半见 [手机访问网关](../architecture/2026-10-16-phone-gateway.md)；手机端的 App 见
[Android 客户端](../feature/2026-10-16-pocket-apk.md)。本笔记只讲**公网**这半。

## Problem

人不在同一 WiFi 时局域网地址没用，需要一条公网通道。而这条通道要暴露的偏偏是最危险的东西：**能在这台电脑上
读写文件、执行命令的 DSH**。所以"能连上"是容易的部分，"连不上时是什么样"才是产品：

- 公网门的口令必须是**永远强制**的（局域网门可以被用户关掉密码，公网门不行）；
- 走过公网的人与坐在沙发上的人必须是**两种身份**，一边被攻破不能顺带打开另一边；
- 开启动作必须**每次都要人自己确认**，而不是记住一次就永久授权；
- 壳退出、崩溃、重启后，**公网入口不能留在那儿没人管**。

## Decision

### 1. cloudflared 随包内置，构建期双重校验

用户确认的选择（备选是运行期下载）。`cloudflared-pin.json` 钉住版本与哈希，
`scripts/prepare-cloudflared.mjs` 负责取回并校验两件独立的事：

1. **SHA-256 与 pin 一致**——证明字节就是上一次构建用的那些；
2. **Authenticode 签名者是 Cloudflare**——证明这些字节确实来自 Cloudflare。

第 2 条不是装饰：Cloudflare 对这些 release **不提供校验和文件**，所以哈希本质上是我自己记的（TOFU），
真正让它可信的是签名。两个都过不了就不会有二进制落到包里。

落点：`extraResources` → 安装后的 `resources/cloudflared/cloudflared.exe`，**刻意放在 ASAR 之外**——它要被
spawn，而 ASAR 内的路径会先 `existsSync` 通过、再以 ENOENT 失败。`verify-package.mjs` 复验包内那份的存在
与哈希，`release-electron.mjs` 在打包前再验一次源文件。

### 2. 第二个监听器，而不是第二个 Host

`127.0.0.1:<tunnelPort>` 上再起一个网关（`scope: 'public'`），只有隧道能到达它。于是"从公网来"是**结构
事实**，不靠任何头部推断。它与局域网口有三处不同：

| | 局域网口 | 公网口 |
|---|---|---|
| 绑定 | 本机局域网地址 | `127.0.0.1`（只有隧道能连） |
| 密码 | 局域网密码（可关闭） | 公网密码（**永远强制**） |
| 会话/限流 | 独立实例 | 独立实例（互不通用，一边被爆破不锁另一边） |

公网密码的轮换规则跟着地址走：**快速隧道每次开都换密码**（地址本来就是随机的，泄漏的地址过一天就没用），
**命名隧道不换**（地址固定，密码再轮换就是把用户锁在门外），用户也可以自己固定一个。

### 3. 免责闸门：每次开启都要确认，且落盘只记"你同意过"

`startTunnel({ acceptedDisclaimer })` 在**服务层**强制：不传或 false 一律拒绝启动。设置页每次点「开启公网
访问」都弹一次确认框（警告内容：互联网上任何拿到地址和密码的人都能操作你的电脑，而 DSH 能执行命令）。

`accepted` 只在**用户亲手同意的那次启动**写入 `pocket.json`；关闭时删掉。于是壳重启后的自动恢复只会恢复
"用户开过并且同意过"的隧道，绝不会恢复一条没人同意过的入口。

### 4. 子进程必须死透

`stop()` 用 `taskkill /pid … /t /f` 杀**进程树**（cloudflared 有子进程，只杀父进程会留下数据面），壳退出时
`dispose()` 先停公网门再退。一个没人看着的 cloudflared 就是一台没人看管的开放主机。

## Alternatives considered

- **运行期下载 cloudflared**（最强理由：包体不为永不开公网的用户变大，且 cloudflared 能独立升级）→ 弃。
  在用户机器上运行期下载并执行第三方二进制，等于把供应链风险放在最不可控的时刻发生；改到构建期，让人能看
  一眼产物。
- **让用户自己装 cloudflared**（最强理由：零供应链责任）→ 弃。开箱即用性最差，而这是"手机访问"的核心卖点。
- **公网/局域网共用一个监听器、靠 Host 判定区分**（最强理由：少一个端口、少一份状态）→ 弃。判定出错就是把
  公网密码绕过去，而两个监听器让这件事在结构上不可能。
- **公网口也套 Host 白名单**（我自己最初的设计，理由是纵深防御）→ **被实测推翻**。cloudflared 转发的是
  **公网 Hostname**：快速隧道是随机 `*.trycloudflare.com`，命名隧道是用户在 Cloudflare 控制台配的域名
  （我们无从干预）。结果是隧道通了、门每一条请求都 403。结论：Host 白名单只在**局域网口**有意义（只有它
  可能免密，也只有它会遭遇 DNS rebinding），公网口靠"loopback 绑定 + 永远要密码"。这条是 E2E 抓出来的，
  任何单测都不会有。
- **命名隧道的 token 走 `--token` 命令行**（最强理由：cloudflared 文档里最常见的形式）→ 弃。命令行对本机
  其他进程可见，而这个 token 能开一条进这台机器的隧道。改用 `TUNNEL_TOKEN` 环境变量，并有一条单测钉住它。

## Consequences

- 安装包增大：cloudflared 未压缩 **52.8 MiB**（`resources/cloudflared/`），压缩后实际增量以打包数字为准；
  升级随壳发版，不独立升级——这是"随包内置"的代价，用户已知情并选择。
- 公网密码与 Tunnel Token 明文存在 `pocket.json`（用户目录，`0600`）。这是必要的：网关要拿它比对、隧道要用
  它连接；文件权限是唯一的保护。
- 代理/VPN 会拦隧道（本机 Clash 是 HTTP 代理模式，隧道能建立；TUN 模式常见 `error 1033`），设置页常驻这条
  排查提示。
- 公网口不设 Host 白名单，因此**只能靠密码和端口可达性防守**；端口绑在 loopback 上，这一点成立。

## Evidence

- **单测**：`pocket-tunnel.test.ts` 9 条（假 cloudflared 跑真进程：读到地址、命名隧道等注册、二进制退出算
  失败、超时不算成功、重启替换旧隧道、token 不进命令行）；`pocket-gateway.test.ts` 增加 1 条作用域测试
  （两边密码与会话互不通用）；`pocket-service.test.ts` 增加 5 条（不确认免责就不开、公网门要公网密码、关闭
  即遗忘、局域网会话进不了公网门、快速隧道每次换密码而固定的不换）；设置页静态守卫 2 条（表单**不能**直接
  打开公网访问；token 输入框是 password 类型）。
- **真实隧道 E2E**：`DSH_DESKTOP_POCKET_E2E=1 node --test src/pocket-tunnel-e2e.test.ts`，用**随包的**
  cloudflared 开一条真 `*.trycloudflare.com` 隧道，从公网地址回访，全部通过（约 17 秒）：
  1. 边缘就绪后 `/` 返回 **401**（要密码，fail-closed）；
  2. 登录页写明"公网访问"；
  3. **局域网密码打不开**公网门；
  4. 公网密码换到 303 + 会话 cookie，带 cookie 请求 **200** 且响应体来自上游 DSH 替身；
  5. **局域网门的会话在公网门上是 401**；
  6. 停掉隧道后公网地址不再返回内容。
- 打包校验：`verify-package.mjs` 断言包内 `resources/cloudflared/cloudflared.exe` 存在且哈希与 pin 一致；
  `release-electron.mjs` 打包前再验一次。

## 本机环境陷阱（值得留档）

**Git Bash 的 GNU tar 会把 `D:\...` 当成远程主机名**（`tar: Cannot connect to D: resolve failed`），
于是 `prepare-runtime.mjs` 解压 `node.exe` 失败——而且它在失败前**已经清空了 `runtime/dsh/`**，需要重新
准备整个运行时。用 PowerShell 跑，或让 PATH 里 `C:\Windows\System32`（自带 bsdtar）排在 Git 的 `/usr/bin`
前面。第一次踩到时误以为是代码问题。
