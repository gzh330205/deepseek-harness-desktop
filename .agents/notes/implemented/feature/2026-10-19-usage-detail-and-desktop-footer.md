# Agent Note: 用量明细、Key 修复与桌面页脚「设置」直出（0.4.9）

Status: implemented

## Problem

0.4.8 之后用户又提了四条，分布在用量窗口、DSH 页面和手机端：

1. **用量窗口的 API Key 显示不出来了**（顶部 `Key —`）。网关把 `/my-usage` 里的 key chip 改成了
   `<code class="… break-all" data-key-value="true" data-key-masked="ah-c0c1...5d1bd2" data-key-full="…">…</code>`；
   `parseUsage` 的 `/<code class="…">([^<]+)<\/code>/` 要求开标签后**紧接 `>`**，新增的 `data-*`
   属性直接让匹配失败，`apiKey` 变成 `null`。
2. **请求日志看不了详情**：列表只有八列且被 ellipsis 截断，行不可点。网关其实提供了
   `GET /my-requests/<id>/download`（`application/json`，真实一条约 1.27 MB），字段齐全
   （时间/模型/渠道/Key/状态/流式/来源/格式/Client IP/总延迟/首字延迟/推理时长/Token/请求体/响应体）。
3. **DSH 页面左下角是「更多」而不是「设置」**：在桌面模式（`'dshDesktop' in globalThis`）下，
   `ui-settings-account` 注册到 `settings.launcher`，把 `SettingsRoot` 原本的「设置」触发按钮换成了
   账号行——未登录时显示「更多」，点开是 设置 / 意见反馈 / 登录 菜单。用户要的是**直接看到设置按钮**，
   并且**隐藏意见反馈和登录**。
4. **Android Pocket App 的设置面板和 DSH 页面叠在一起**：`setupPanel`（ScrollView）没有背景，
   `MainActivity.showSetup()` 只把面板设为 VISIBLE，连接成功后 WebView 仍 VISIBLE，于是透明的设置页
   盖在 DSH 页面上，两层文字重叠无法阅读。

## Decision

### 1. API Key：按属性解析，优先 `data-key-masked`

`parseUsage` 改为在 `<code …>` 开标签的整个属性表里找 `data-key-masked`，没有才回落到渲染文本；
不依赖 class 的精确拼写，也不读 `data-key-full`。**只显示 masked key**：窗口是只读展示，完整密钥留在
网关页面（那里有复制/显示按钮），不必把完整凭据带进壳窗口和剪贴板。旧的无属性形态仍兼容。

### 2. 请求明细：走 JSON 下载接口，模态展示

- 新增 `UsageService.requestDetail(id)`：id 必须是纯数字；GET `/my-requests/<id>/download`，复用
  `requests()` 的 cookie/UA/20s 超时；校验 `application/json` 与 16 MB 双重大小上限（声明 + 实际）；
  解析并规范化 15 个字段，`created_at` 用 `Date` 解析后**按本地时区**格式化（与列表同一时刻显示一致）。
- 缓存：5 分钟 TTL + 同 id 并发合并 + 失败不缓存 + 最多 20 条（每条几 MB，翻日志不能无限攒）+
  logout 用 epoch 清空，避免 in-flight 回填旧会话数据。
- UI：日志行 `data-id` + `tabindex=0`（click / Enter / Space），打开窗口内 `role="dialog"`：
  14 项基础信息网格、请求体/响应体两个标签页；`JSON.stringify(…,2)` 只渲染前 120,000 字符并提示
  「已截断，共 N 字符」，「复制完整 JSON」始终携带全文（clipboard 失败降级 textarea/execCommand）；
  加载/错误态、Esc/遮罩/关闭按钮。页面仍无网络、无 innerHTML，全部 `textContent`。

### 3. 桌面页脚：用 `--patch` overlay 关掉账号 launcher，让设置触发按钮回到原位

DSH 的页脚是 `sidebar.settings` 槽，`SettingsRoot` 先渲染 `settings.launcher` 槽（`fallback` 才是
设置按钮）。`ui-settings-account` 注册了这个单占位槽，所以只要它在，设置按钮就不会出现。
壳的 overlay（每次启动生成、只作用于本桌面进程）里增加：

```yaml
- id: ui-settings-account
  disabled: true
```

和已有的 `- id: ui-sidebar-browser disabled: true` 完全同一机制。效果：账号 launcher 不再注册（单槽
空），`SettingsRoot` 的 fallback 设置按钮出现 → 页脚直接是「⚙ 设置」；更多 / 意见反馈 / 登录一起消失。
不动 DSH 源码、不写用户 profile、不影响手机端/浏览器端访问同一 DSH 服务。

### 4. Android：设置面板不透明 + 隐藏 WebView

`activity_main.xml` 给 `setupPanel` 加 `android:background="?android:attr/colorBackground"`（跟随
系统深浅色）；`MainActivity.showSetup()` 先 `webView.setVisibility(View.GONE)` 再显示面板。两个改动
缺一不可：背景解决透明层，GONE 让 WebView 停止绘制/不再透出（也省电）。`open()` 的
「面板 GONE → WebView VISIBLE」不变。APK 升到 1.0.3(4)。

## Alternatives considered

- **API Key 直接显示 `data-key-full`**：最强理由是一次复制就能用；但壳窗口是只读展示面，完整密钥进入
  DOM/剪贴板只会扩大暴露面，而网关页面已有「显示/复制」按钮。改显示 masked key，与网关默认状态一致。
- **明细继续用 `/my-requests/<id>` HTML 页面**：能拿到同样的信息（基础信息 + 两个 `<pre>`），但页面
  1.39 MB 且解析靠 class 名，JSON 接口字段稳定、可直接校验类型；选 JSON。
- **预取/悬停预取明细**：会让翻日志变成几十次 1 MB 请求；只在点击时取，并用 5 分钟缓存兜住重复点击。
- **把完整 1.27 MB pretty JSON 全渲染进 DOM**：主线程字符串/DOM 都会卡；截断显示 + 复制全文。
- **用壳自己的 client 插件改 DSH DOM 把「更多」换成设置**：可行但依赖 CSS Modules 哈希 class 和
  DOM 结构，DSH 一升级就碎；而 DSH 的 `--patch` 本来就支持按 id 禁用插件（内置侧边栏浏览器就是这样被
  壳替换的），用官方机制。
- **只 CSS 隐藏账号 launcher**：会得到一个空页脚——`SettingsRoot` 的 fallback 只在 `settings.launcher`
  槽无人注册时渲染，CSS 隐藏不会让 fallback 出现。
- **Android 只隐藏 WebView / 只加背景**：只隐藏的话转场瞬间仍可能透出；只加背景的话 WebView 还在下面
  绘制（耗电/滚动干扰）。两者都做。
- **Android 用 `INVISIBLE`**：仍参与布局与绘制；`GONE` 才真正停止绘制。

## Evidence

- 单测：`node scripts/run-tests.mjs` → **582 pass / 0 fail / 8 skipped**；`tsc --noEmit` 干净；
  `node build.mjs` 成功。
- 真实网关（用真实 `oneway.json` 会话，不打印 cookie）：`snapshot()` → apiKey=`ah-c0c1...5d1bd2`、
  user=郭增辉；`requests()` → 10 行、total=1583；`requestDetail('2912434')` → model=deepseek-flash、
  status=completed、totalTokens=214163、latency 4293ms、first token 1320ms、bodyBytes=1340381、
  请求/响应体非空、二次读取 0ms（缓存命中）。
- 隐藏 Electron 页面检查（真实 1.27MB fixture + stub bridge）：11/11 通过——行点击开模态、14 项信息、
  请求体渲染 120,026 字符且提示「已截断，共 1,249,010 字符」、响应体 4,215 字符、Esc 关闭、Enter 重开、
  无 console error；截图 `.tmp-perf/usage-detail-ui/{usage-page,detail-modal}.png`。
- DSH 页脚（dev 壳 + CDP 实测）：`settingsArea` 文本只有「设置」，页面上不存在「更多」「意见反馈」
  「登录」按钮；点击设置按钮后设置面板打开；截图 `.tmp-perf/sidebar-probe/sidebar.png`。
- dev 壳菜单/窗口冒烟：usageWindow loaded+bridge、usagePopover 9 个元素全 true、pocket/mcp 窗口正常，
  无插件 import/activate 失败。
- Android：`gradlew :app:testDebugUnitTest` 与 `:app:assembleDebug` BUILD SUCCESSFUL；产物
  versionName=1.0.3 / versionCode=4。未上真机（设置面板视觉改动以编译+单测为准）。
- 发版：v0.4.9 已发布（安装包 235,025,760 B + sig、`DSH.Pocket.apk` 1.0.3(4) 3.56 MB、
  `latest.json` version=0.4.9 匿名可读），打包组合校验通过；安装包匿名 HEAD 200。

## Consequences

- 桌面 DSH 页面不再有 DeepSeek 账号入口：没有「更多 / 意见反馈 / 登录」，也没有账号设置分区、额度通知、
  模型登录引导、桌面 onboarding（它们都来自 `ui-settings-account`）。这个部署用 ONE-WAY 用量窗口看额度，
  不用 DeepSeek 账号；如果以后要恢复，删掉 overlay 里那一行即可，但页脚会回到「更多」菜单。
- 页脚是「设置」直出后，用户少一次点击；这是 DSH 页面上唯一的壳定制，保持"只禁用插件、不改 DOM"。
- 明细依赖网关 `/my-requests/<id>/download` 的 JSON 形状；网关改字段会变成可读错误或「—」，不会静默
  错值。打开明细会把请求/响应全文从网关取到本机内存（有 16MB/20 条上限），「复制完整 JSON」会把
  prompt/response 放到剪贴板——都是用户主动点击才发生。
- Android 返回键在设置面板前台时直接退出（而不是 WebView 后退），这是本次把 WebView 设为 GONE 的
  直接结果，符合"设置页在前台"的直觉。
