# 自研侧边栏浏览器（注入 DSH 右侧栏）+ agent 网页读取 —— 方案与实现记录

> 状态：**M1（面板+原生视图）✅ M2（agent 工具面 14 个）✅ M3（多标签+保活）✅
> M4（元素拾取+写回、设备模拟、整页截图）✅ M5（设置开关 + 运行诊断）✅**，
> 待做 M6：遮挡处理、下载/证书提示、页面内查找与缩放。
>
> 决策：**不使用 DSH 自带的侧边栏浏览器**（`@deepseek-ai/dsh-client-ui-sidebar-browser`）。
> 浏览器本体（视图、会话、导航策略、agent 工具）由桌面壳自己实现；只有「面板 UI」作为 DSH 客户端插件
> 注入右侧栏，只有「工具面」经 MCP 暴露给 agent。参考实现：内网 `one-code`（MIT），其主进程浏览器
> 与页面注入脚本被直接复用。

## 1. 为什么这样切

| | DSH 自带浏览器 | 本方案 |
| --- | --- | --- |
| 视图/会话/策略 | DSH 决定，随 DSH 版本变 | **壳自己拥有**（每标签一个视图） |
| agent 读取网页 | **没有**（该包 README 明确「模型体验：无」） | ✅ 14 个工具：快照/查找/点击/输入/滚动… |
| 与 DSH 的耦合面 | profile 名 + 内部载体协议（`globalThis.dshDesktop`）+ `webviewTag` | 两层，且都能降级：①客户端 slot 注册 ②`dsh-mcp-client` 配置行 |
| `webviewTag` | 必须开（`<webview>` 载体） | **保持 `false`** |

必须诚实记下的耦合：注入侧栏用的是 DSH 客户端 API（`ctx.sidebarRightTabs` / `sidebar.right.pane.tab`），
工具面用的是 DSH 基础运行时自带的 `@deepseek-ai/dsh-mcp-client`。两者都不是「永不变化」的公开契约，
但都属于**配置/注册层面**，任何一处失效都只让面板或工具消失，不会带走浏览器本体；真要改，退化成
「壳自己开原生停靠列 + 直接用 `executeJavaScript`」即可，页面注入脚本与视图代码不用重写。

## 2. M1 交付（面板 + 原生视图 + 地址栏/前进后退）✅

### 2.1 主进程（壳）

| 文件 | 内容 |
| --- | --- |
| [browser-geometry.ts](../electron/src/browser-geometry.ts) | 矩形解析/夹紧/标题栏偏移、地址规范化（裸主机补 HTTPS、只放行 HTTP(S)、拒内嵌凭据与 DSH 自身 origin）、导航策略、失败文案 |
| [browser-view.ts](../electron/src/browser-view.ts) | `BrowserViewManager`：单个 `WebContentsView`、独立持久分区 `persist:dsh-desktop-browser`、离屏隐藏、导航/开窗/权限策略、事件→状态推送、面板命令白名单、**M2 的 agent 操作** |
| [constants.ts](../electron/src/constants.ts) | `dsh-desktop:browser-command` / `browser-state` |
| [preload.ts](../electron/src/preload.ts) | 只对 loopback DSH 页面暴露 `__DSH_DESKTOP_BROWSER__`（一个 `command` + 一个 `subscribe`）；访客页面无 preload |
| [main.ts](../electron/src/main.ts) | `installBrowserPanel()`：IPC 三重校验（产品页 webContents + 主 frame + loopback）；窗口关闭 `shutdown()`；产品页跳走即隐藏 |

### 2.2 面板（DSH 客户端插件，[dsh-desktop-shell/client.js](../src-tauri/resources/dsh-desktop-shell/client.js)）

- 能力探测：只有 `__DSH_DESKTOP_BROWSER__` 存在才注册 → **Tauri 旧壳行为不变**；
- `ctx.sidebarRightTabs.register({ id: 'dsh-desktop-shell/browser', kind: 'desktop-browser', priority: 'extension', title, guide })`
  + `ctx.slots.register({ name: 'sidebar.right.pane.tab', key }, Panel)`；
- 正文＝工具栏（←/→/⟳/地址栏）+ `stage` 占位框；`ResizeObserver` + `window resize` 上报矩形；
  折叠/卸载只隐藏（页面保活）；`registerCloseHandler` 才销毁视图。

## 3. M2 交付（agent 网页读取与操作）✅

### 3.1 工具清单（模型看到的是 `mcp__desktop_browser__<name>`）

| 工具 | 作用 | 只读 |
| --- | --- | --- |
| `state` | 当前 URL/标题/是否加载中/面板是否可见 | ✅ |
| `navigate` | 打开 http(s) 网址并等待加载；`show:false` 后台打开 | |
| `snapshot` | **页面结构快照**：URL/标题/正文 + 带 `[n]` 索引的可交互元素（角色、可访问名、表单状态、是否在视口、稳定选择器） | ✅ |
| `find` | 按 CSS 选择器找元素（带属性）或按文本/正则搜正文并给上下文 | ✅ |
| `click` | 按 `index`/选择器/视口坐标点击（走真实输入管线，自动滚动到位，报告遮挡） | |
| `type` | 向输入框填文本（受控组件同样生效），`clear:false` 追加 | |
| `keys` | 发送按键/组合键（`Control+a`、`Enter`、`PageDown`…） | |
| `scroll` | 滚动页面或指定元素 | ✅ |
| `wait` | 等元素/文本出现，或固定等待秒数 | ✅ |
| `history` | 后退/前进/刷新 | ✅ |
| `select` | 原生 `<select>` 按 value/文本选择，未命中时回传全部选项 | |
| `screenshot` | 视口截图存 PNG，返回路径供 `present` 展示 | ✅ |

### 3.1b 多标签（M3）

- 类型声明 `multiple: true` + `keepMounted: true`：每次从 guide 打开都是一个独立 occurrence
  （= 主进程里一个独立 `WebContentsView`、独立渲染进程、独立历史），切 tab/收起侧栏时正文不卸载，
  页面与滚动位置留着，只是把原生表面 park 掉。
- 面板正文从 `useTabInfo()` 取本 occurrence 的 `tab.id`，**每条命令都带 `tabId`**；主进程按它路由，
  `keepMounted` 下的可见性用 `tab.visible` 决定 show/hide。
- [browser-tabs.ts](../electron/src/browser-tabs.ts)：每 tab 一个 `BrowserViewManager`，负责
  ①面板命令路由（tabId 校验为有界字符串）②工具调用的目标选择 ③关 tab 只销毁那一个视图。
- 目标选择规则（纯函数 `pickActiveTab`，有单测）：**显式目标** > 最近显示的可见标签 > 最近触碰的标签；
  面板的 show/navigate/focus 会把显式目标设为用户正在看的那个标签，因此「我让他读这个页面」生效。
- 没有面板标签时 `navigate` 会建一个隐藏的 `agent` 标签做后台浏览；`tabs` 会如实标出它是后台的。
- tab chip 标题注册 `sidebar.right.pane.tab.title`，显示页面标题（拿不到就退回「浏览器」）。

页面注入脚本（快照/点击/输入/滚动/等待/选择/查找）**逐字复用** one-code 的
`snapshotScript.ts` → [browser-snapshot.ts](../electron/src/browser-snapshot.ts)（仅加了来源头），
CDP 输入分发复用 `browserInput.ts` → [browser-input.ts](../electron/src/browser-input.ts)（仅 1 行本地改动：
字符串下标 → `charAt`，因为本仓库开了 `noUncheckedIndexedAccess`）。工具语义与文案改编自
`agentBrowserTools.ts`，实现落在 [browser-tools.ts](../electron/src/browser-tools.ts)（模型可见的文案、
参数强制、错误呈现）与 [browser-view.ts](../electron/src/browser-view.ts)（真实操作）。

### 3.2 工具面：原生工具为主，MCP 为回退

**先纠正一个曾经的错误结论。** 本文早期版本写的是「DSH host 插件要用 `defineTool`，而
`@deepseek-ai/dsh-tools` 只能从装进 profile 的包解析到，所以插件做不了工具」——**这条不成立**：

- 注册入口是 `ctx.tools.register(definition)`，`defineTool` 只是「参数 DSL → JSON Schema + 校验」
  的构造糖；传一个普通对象同样有效，**不需要 import 那个包**；
- `@deepseek-ai/dsh-tools` 是 `dsh` 自己的依赖（`dsh/package.json` 里就有），`dsh web` 的合成树里
  `id: tools` 与 `id: skill` 都在（`dsh --profile <p> --dump-config` 可查），所以我们的 host 半
  `ctx.inject(['tools'], …)` / `ctx.inject(['skills'], …)` 拿得到服务。

真正的取舍不在「能不能」，而在**跨进程这一跳省不掉**：浏览器（`WebContentsView`）在 Electron 壳里，
所以无论哪条路，DSH 侧都要经 loopback 调壳。于是问题变成「绑哪个契约」，而现在的答案是**两个都要**：

| | 原生工具（默认） | MCP（回退） |
| --- | --- | --- |
| 注册方 | 面板插件 host 半（`ctx.tools.register`） | overlay 里的 `dsh-mcp-client` 配置行 |
| 执行方 | 仍是壳（`POST /call/<capability>`） | 仍是壳（`POST /mcp/<capability>`） |
| 好处 | 进 DSH 工具清单/设置页、走 DSH 呈现管线、可用 `guard`/`pre-execute`/`restrict` 等策略 | 只依赖**公开协议**，DSH 内部 API 变了也不受影响 |
| 代价 | 绑定 `ctx.tools` 的内部形状 | 拿不到 DSH 侧的工具策略钩子 |

**一份目录，两个门面**：工具定义只有 [browser-tools.ts](../electron/src/browser-tools.ts) 一处
（`BROWSER_TOOLS`）。壳启动时把它写成 `browser-tools.json`，插件读它注册原生工具；MCP server 拿到的是
同一个数组。谁也不会漂移。

**自动回退**（这正是「DSH 升级把我们打挂」的兜底）：

1. overlay 里**只注入一个门面**（原生工具时不再注入 MCP 行，否则模型会看到每件工具两份）；
2. 插件注册完成后回报结果到 `POST /registered/<capability>`，壳把 `{ok,count,at}` 写进
   `browser-tool-registration.json`；
3. 下次启动由 [browser-tool-surface.ts](../electron/src/browser-tool-surface.ts) 判定：
   `auto`（默认）下，上次注册失败或数量不匹配 → **改用 MCP**，并在日志与设置页写明原因；
   选择 `native` 表示「重试原生」；`mcp` 则固定用 MCP。

设置项 `browser.agentTools`（`auto` / `native` / `mcp`）在设置页「桌面端 → 浏览器」里，
「运行状态」会显示本次实际生效的门面与原因（例如「MCP 工具 · 自动回退 MCP：上次注册失败…」）。

**schema 必须落在 DSH 原生注册表接受的子集内**——这是这条路上最容易踩的坑：原生注册表只接受
`type/oneOf/properties/required/additionalProperties/items/enum/const` 加
`description/title/default/examples`，多一个 `minimum` 就会在**用户机器上加载时抛错、工具全没了**。
所以边界值写在描述里、由代码夹紧，并有
[browser-tool-schema.test.ts](../electron/src/browser-tool-schema.test.ts) 在发版前把每个 schema
逐个核对（`browser-tools.test.ts` 之外单独一条，就是为了让「跑完测试再发版」这句话有依据）。

```yaml
# 桌面壳每次启动生成的 dsh-overlay.yml（原生工具模式：没有 MCP 行）
- insert:
    - id: dsh-desktop-shell
      name: '<插件绝对路径>/index.js'
      config:
        nativeTools:
          url: 'http://127.0.0.1:<port>/call/<256bit 能力路径>'
          reportUrl: 'http://127.0.0.1:<port>/registered/<256bit 能力路径>'
          token: 'Bearer 用的 256bit token'
```

MCP 模式下的行（回退时使用）与之前一致：

```yaml
    - id: desktop-browser-mcp
      name: '@deepseek-ai/dsh-mcp-client'        # DSH 基础运行时自带
      config:
        serverName: desktop_browser
        transport: streamable-http
        url: 'http://127.0.0.1:<port>/mcp/<256bit 能力路径>'
        headers:
          Authorization: 'Bearer <256bit token>'
        failOnStartupError: false
```

- 三条路由都由 [agent-bridge.ts](../electron/src/agent-bridge.ts) 提供，共用同一套防护：仅 loopback、
  随机端口、能力路径 + bearer（常量时间比较）、**带 `Origin` 的请求一律拒绝**（页面发起的 fetch 必带，
  MCP 客户端与插件都不带）、POST-only；MCP 侧 stateless（每个请求一个 transport）。
- 生成器在 [desktop-files.ts](../electron/src/desktop-files.ts)
  （`writeOverlay(appVersion, agentMcp, { injectMcp, nativeTools })`），由
  [host-process.ts](../electron/src/host-process.ts) 传给子进程；[main.ts](../electron/src/main.ts)
  在 spawn 之前启动桥（`startBrowserTools()`），失败只记日志、不影响面板。
- 依赖：`@modelcontextprotocol/sdk@1.31.0`（devDependency，esbuild 打进 `dist/main.js`，无运行时 node_modules 需求）。

### 3.3 内置技能：让模型「会用」而不只是「有工具」

工具描述只说明每个动作做什么；模型仍然容易猜坐标、假设操作成功、或在用户正看着的页面上乱导航。
所以插件 host 半用 `ctx.skills.register(BROWSER_SKILL)` 注册一段**内置技能**
（内存技能，随安装包分发，用户零额外安装）：

- 标准流程：`state` → `tabs` → `navigate` → `snapshot` 取 `[n]` → 用索引操作 → **再验证**；
- 何时用哪个工具（只要文本用 `snapshot`，只要某元素用 `find`，表单用 `type/select/keys`）；
- 注意事项：有副作用的操作先确认、页面跳转后索引失效要重新 snapshot、慢页面用 `wait`、
  面板没开时如实告知用户而不是编造。

调用策略用注册表默认的 `{modelInvocable: true, userInvocable: true}`——模型可查，用户也能在技能目录里看到。

**踩过的坑（务必留意字段要求）**：`register()` 只校验 name / description / invocation，
但**按名加载**（`registry.get(name)`）会再走一次 `validateDefinition()`，那里额外要求
`source`、`provider`、`content` 都是字符串（`provider` 由注册表补默认值，`source` **必须自己给**）。
漏了 `source` 的表现是：注册那一步日志一切正常，用户点开技能时报
`Error: loaded skill "sidebar-browser" source must be a string`。这正是它第一次上线时的样子。

因此技能定义单独放在 [browser-skill.js](../src-tauri/resources/dsh-desktop-shell/browser-skill.js)
（不在 `index.js` 里内联），并有两层护栏：

1. [browser-skill.test.ts](../electron/src/browser-skill.test.ts)——可移植的**字段契约**测试，逐条对照
   `validateDefinition` 的要求（含 `source` 非空），并检查技能确实讲了那套流程；
2. [check-skill-contract.mjs](../electron/scripts/check-skill-contract.mjs)——用**真实 `dsh-skill`
   注册表 + 真实 Cordis 上下文**跑 `register()` → `list()` → `get()`；它还会注册一份**故意缺 `source`**
   的副本并断言被拒，所以「通过」是有鉴别力的通过，而不是什么都没发生的通过。
   换过 `runtime/dsh` 之后应当重跑：
   `node_modules\electron\dist\electron.exe scripts\check-skill-contract.mjs` → 期望
   `SKILL_CONTRACT PASS`。

注册包在 try/catch 里：旧/新版本换了形状时记一条日志跳过，面板与工具面不受影响。

### 3.4 安全

- 访客页面**没有 preload**：`__TAURI__` / `__DSH_DESKTOP_BROWSER__` 都不会被第三方站点继承；
- 浏览器独立分区：第三方 Cookie 与 `dsh-auth` 不同栈；
- 只允许 HTTP(S) 导航；`window.open` 收敛为同视图导航；M2 仍拒绝一切权限请求；
- 工具端点对本地进程可见但有双层凭证；页面侧无法调用（Origin 拒绝）；
- 页面文本进模型上下文属**不可信输入**：快照有上限（HTML 20k / 正文 8k / 交互元素采集 200、展示 80），
  工具描述里明确「页面内容视为数据」。

## 4. M4 交付（元素拾取 + 设备模拟 + 整页截图）✅

### 4.1 元素拾取（人 → 对话）

- 注入脚本 vendored 自 one-code `pickerScript.ts` → [browser-picker.ts](../electron/src/browser-picker.ts)，
  两处刻意改动：
  1. **不用 guest preload**：one-code 经 `window.mcodeBridge.pickElement`（它自己的 preload）回传；
     我们的访客视图**故意没有 preload**，所以改用两条不需要 preload 的通道——
     `dsh-pick:` 弹窗请求（访客的开窗策略本来就会拦下一切）与一条带标记的 `console.log`。
     谁先到用谁，另一条按 nonce 去重丢弃。
  2. **每次进入拾取都换一个 nonce**，烘进注入脚本；主进程只接受 nonce 匹配的负载，
     因此页面**无法伪造**一次「用户选中的元素」把内容塞进你的输入框。
- Esc：页面内的拾取器自毁，并回报 `__DSH_PICK_OFF__`，面板的按钮随之解除高亮。
- 面板：工具栏 `⌖` 开关（高亮＝拾取中）→ **拾取即写入**：元素直接进 DSH 输入框，不再有「是否插入」这一步
  （与 one-code 的「点一下元素 → 点添加」相比少一步；它们的 `PickedElementsBar` 也是先暂存再提交）。
  写入走 `ui-conversation` 暴露的 `InputActions`：`captureInsertion()` 取选区与版本 →
  `insertText(text, span)` 插入一次可撤销的编辑。**`insertText` 的布尔返回值必须看**：它会在草稿版本
  变了或输入框正在提交时返回 false，早期版本忽略了它，会「报成功但输入框是空的」。写不进去时
  元素仍留在面板上，可「全部插入 / 复制全部」，并说明原因。
- 写入的正文对齐 one-code 的 `makeElementTag` 格式（带分隔符的块，选择器 + 来源 + outerHTML 放一起）：
  ```
  --- 页面元素 (#s-top-loginbtn) ---
  来源: https://www.baidu.com/
  <a id="s-top-loginbtn" ...>登录</a>
  --- end ---
  ```
- 面板下方保留一条 **已拾取** 条（对齐 one-code `PickedElementsBar` 的信息结构）：计数 + 每个元素一个
  chip（预览 + ×，仅从记录里移除）+ 「全部插入 / 复制全部 / 清空」。它现在是**复核与兜底**，
  不是必经步骤——正常情况下元素已经在输入框里了。

#### 与 one-code 页面标签（content tag）的差距，以及为什么

one-code 的 composer 是它自己的，所以能把拾取结果做成**输入框上方的内容标签 chip**（截图中那个
`#s-top-loginbtn`），发送时才展开成上面的块。DSH 的 `InputActions` 公开面只有
`captureInsertion / insertText / setDraft / addAttachments / removeAttachment / pruneAttachments / submit`
——**没有 tag/chip 接口**，也没有「附件来自任意内容」的入口（`addAttachments` 收的是 DSH 自己上传
管线的附件 id）。所以 chip 形态在 DSH 里做不出来；我们能对齐的是**步数**（已对齐：拾取即写入）
与**正文格式**（已对齐）。

### 4.2 设备模拟

- 工具栏的设备下拉（桌面 / iPhone / 安卓）→ CDP
  `Emulation.setDeviceMetricsOverride` + `setTouchEmulationEnabled` + `setUserAgentOverride`；
  回到桌面时 `clearDeviceMetricsOverride` 并还原 UA。改的是每个标签自己的视图。
- iPhone 用 Safari 的 UA 串：站点嗅探 UA，iOS 页面把自己当桌面 Chromium 才是真问题；
  引擎仍是 Blink（桌面壳里的设备模拟能给的边界就是这些）。
- 模拟挂在 debugger 会话上，随视图销毁一起消失。

### 4.3 整页截图

- `browser_screenshot { fullPage: true }` 走 CDP `Page.captureScreenshot{captureBeyondViewport:true}`；
  调试器不可用时回退到 `capturePage()` 的视口截图，并在结果里说明是「整页」还是「当前视口」。

### 4.4 与 one-code 面板的功能对照

工具条与面板结构逐项对照（读 one-code `components/browser/*` 得到；下表是**补齐后**的状态）：

| 能力 | one-code | 我们 | 说明 |
| --- | --- | --- | --- |
| 后退/前进/刷新 | ✅ | ✅ | |
| 主页（可设置） | ✅ | ✅ | `browser-prefs.json` 存 homepage；空值打开空白页 |
| 地址栏历史下拉 | ✅ 按天分组 | ✅ 按输入过滤（最近 10 条），可删单条 / 清空 | 历史由主进程按标签记账（`did-navigate`，连续同页去重） |
| 收藏（星标 + 收藏栏 + 改名） | ✅ | ✅ | `browser-prefs.json`；收藏栏双击改名、悬停删除 |
| 标签条（多标签、新建、关闭） | ✅ 自有标签条 | 部分 | 用 DSH 侧栏自身的 tab（`multiple: true`），在侧栏里更省地方 |
| 拾取元素 | ✅ | ✅ | 已对齐为「拾取即写入」，且是**引用 chip**（见 4.1） |
| 设备模拟 | ✅ 独立一行 | ✅ 独立一行（📱）：预设 + 自定义宽高 + 旋转 + 跟随窗口 | 走 CDP `Emulation.setDeviceMetricsOverride` + `screenOrientation` |
| 下载（进度条 + 打开/定位） | ✅ | ✅ | 会话级 `will-download` → 默认落到「下载」目录（不弹保存框）→ 面板底部条显示进度与打开/定位 |
| 隐私（清缓存/清 cookie） | ✅ | ✅ | `⋯` 菜单里，清 cookie 带确认 |
| 遮挡处理（DOM 弹层压到原生视图上时冻结视图） | ✅ | ✅ | 打开菜单前 `capturePage()` 截图并 park 视图，面板用冻结图当页面底（见 4.5） |
| 站点证书提示 | ✅ | ❌ | 目前是安全默认（加载失败），不是坏行为，只是没有交互 |
| 授权弹窗（HTTP basic auth） | ✅ | ❌ | `login` 事件；不做等于拒绝（安全默认） |
| 页面内查找 / 缩放 | ❌ | ❌ | one-code 也没有；需要时再补 |

剩下的两项（证书提示、HTTP 授权）都是「默认行为已经安全、只是缺交互」，优先级低于其他所有东西。

### 4.5 「助手正在操作」遮罩与用户接管（M8）

需求：agent 在动浏览器时，页面上要有一层看得见的信号；用户一动手就抢回控制权。

**为什么是原生层**：浏览器内容是原生 `WebContentsView`，永远画在 DSH 页面 DOM 之上，所以面板里的任何
DOM 遮罩都盖不住它。做法是**再加一层背景透明的 `WebContentsView`**（`setBackgroundColor('#00000000')`），
铺在浏览器视图正上方，里面是一张 `data:` URL 的小页面：`rgba(15,17,20,0.22)` 的**轻**暗色底 + 顶部一条
小胶囊「助手正在操作 · 正在读取页面结构（snapshot）」+ 下面一行 10px 的「点击页面任意位置即可接管」。

**文字必须在顶部、底色必须淡**：第一版把一块高对比度胶囊放在**页面正中间**——那正好是用户在看的位置，
反馈是「挡视野」。现在中间完全干净，只有顶边一条细提示；暗色底从 0.42 降到 0.22，页面仍然看得清
（它覆盖整块区域，是因为它同时是接管的点击目标）。这两条有单测钉着（`browser-overlay.test.ts`：
必须有 `justify-content:flex-start`、不允许出现 `justify-content:center`、底色必须是 0.22）。

好处是**页面完全不受影响**：遮罩不进 `snapshot`、不进截图、拾取也看不到它（它不在页面 DOM 里）。

**什么时候出现**：

- 每一次进入 `callBrowserTool` 的工具调用都会包一层（MCP 与插件的 `/call` 两条入口都经过 `main.ts`
  里同一个 `call` 包装），调用期间遮罩显示，结束后撤下；
- `state` / `tabs` / `switch_tab` 是元数据查询，**不显示遮罩**（几十毫秒的闪烁只会让人以为卡了）；
- 有**最短显示时长**（700ms）：即时完成的调用也不会闪一下就消失；
- 视图本身不可见时（面板没开、标签被 park）不显示——没有可见页面就没什么好遮的；
- 打开菜单需要冻结视图时，遮罩跟着撤下（否则它会压在菜单的冻结图上）；菜单关上且仍有调用在跑，自动恢复。

**用户接管**：遮罩页在 `pointerdown`（捕获阶段）打一条 console 标记，主进程监听遮罩自己的
`console-message` 判定「用户接管」→ 撤下遮罩并让后续工具调用**拒绝执行**：

```
用户已经在浏览器上接管操作（他们点了页面），本次调用没有执行。
请不要继续操作页面；可以先用 state 看看当前状态，并请用户在右侧「浏览器」面板点「交还控制权」后再继续。
```

`state` / `tabs` / `switch_tab` 仍然可用（只读元数据），其余 11 个工具一律拒绝且**不会触达浏览器**。
面板在接管期间显示 **「你已接管浏览器 · 交还控制权」**（按钮对应 `releaseBrowser` 命令），
点「交还」后工具恢复。首次点击**不会**被转发给页面——「点一下」的语义就是接管，避免误触页面上的按钮。

**验证（本轮实测）**：脚本级端到端探针（真实 Electron + 真实 `BrowserViewManager`）：

| 步骤 | 结果 |
| --- | --- |
| `beginAgentActivity('snapshot')` | `agentActive=true`，遮罩视图创建，**矩形与浏览器视图完全一致**（12,12,860×560），且是窗口的**最上层子视图** |
| 在遮罩页里派发一次真实 `pointerdown` | `userDriving=true`、`agentActive=false`，日志「用户点击浏览器：已接管…」 |
| 接管期间再 `beginAgentActivity('click')` | 计数在跑但遮罩**不显示**（`userDriving` 期间一律不显示） |
| `releaseToAgent()` 后再起活动 | `userDriving=false`，遮罩恢复显示 |
| 透明叠层的视觉效果 | 单独探针截图确认：页面透过暗色遮罩可见（`overlay-probe.png`） |
| **接管后推 `bounds`+`show`**（回归） | 遮罩保持 park（`x=-9999`，`veilParked: true`）——修前会被摆回页面 |

工具侧的拒绝逻辑有单测（`browser-tools.test.ts`：8 个工具逐个拒绝、`state`/`tabs` 仍可用、
交还后同一调用恢复），遮罩文档/标签/点击标记的规则也有单测（`browser-overlay.test.ts`，7 条）。

**踩过的坑（用户实测报的 bug）**：用户点击想接管，遮罩却**又回来了**、而且怎么点都关不掉。
根因是两处配合出来的：

1. `applyBounds()` 里**无条件**把遮罩摆到浏览器视图的同一矩形上。接管那一刻 `hideVeil()` 确实把它 park 了，
   但紧接着那次 `navigate` 收尾时会 `show()`（以及面板的任何 resize 上报），于是 `applyBounds(rect)` 又把
   遮罩摆回页面上——用户看到的就是「明明接管了，遮罩还在」；
2. `takeoverByUser()` 在已经接管时**直接 early-return**，所以第二次点击连 `hideVeil()` 都不会调用，
   状态彻底卡死。

修法：`applyBounds()` 只在 `veilVisible && !userDriving` 时才跟着摆（否则一律 park 到
`BROWSER_HIDDEN_RECT`）；`takeoverByUser()` **永远先撤遮罩**（幂等），再处理接管状态。
回归断言已加进端到端探针：接管之后再推 `bounds` + `show`，遮罩必须停在 `x = -9999`（park），
实测通过（`veilParked: true`）——修前它会回到 `x = 12` 压住页面。

### 4.6 控制权移交：等待、空闲自动交还、主动通知（M9）

需求（用户原话）：**「我接管后 agent 那边就开始等待；如果我一直在操作，那它就一直等待；如果我有一段时间
没有操作了，则自动交还给他；接管和交还要能主动通知它，而不是它调用来探查」**。

三部分合起来才是这个行为：

**① 工具调用会「等」而不是「失败」**（[browser-control.ts](../electron/src/browser-control.ts) +
[browser-tools.ts](../electron/src/browser-tools.ts)）

接管切进 agent 回合的方式有两种，**两种都必须把这一步「按住」**，否则模型看到的是一个完整的步骤，
它会判断任务已完成、直接结束回合（这正是用户实测反馈的「我接管期间 agent 没有等待，直接结束了」）：

1. **接管时调用还没来**：页面类工具的调用**挂起等待**（`host.waitForControl(signal)`），控制权一回来才
   执行，并把真实结果返回，前缀「用户把浏览器控制权交还给了助手（等待了约 N 秒），本次调用继续执行：」；
2. **接管发生在调用正在飞的时候**（用户实测的那次：`navigate` 在飞时点击了页面）：页面动作照常做完，
   但**结果先扣住不交付**，等控制权回来再给，前缀同样是「等待了约 N 秒」——
   这一步因此在接管期间无法结束。

`state` / `tabs` / `switch_tab` 是元数据，永远即时返回。等待上限 `CONTROL_WAIT_SECONDS = 100`
（低于 MCP 的 120s 与原生工具的 180s）：到上限时，没跑过的调用回「用户仍在操作浏览器（已等待约 N 秒）
…没执行」的错误；已经跑完的调用则把结果交出去，并附一句
「本次结果是在用户接管浏览器之前得到的…页面可能已经变了：继续之前先用 state 或 snapshot 核对一次」——
**不是**错误，因为活儿确实干完了。

**已知边界（诚实说明）**：如果交接发生在 agent 这一步**已经结束**、手上没有任何在飞调用时，就没有东西
可以扣——它会正常结束回合。要让它在这种情况下也「等你」，只能由壳在**交还时以用户身份发一条 prompt**
主动唤起新回合（DSH 有这条入口：`dsh-api-session-controller` 的 `session.prompt`），代价是对话里会出现
一条不是你亲手发的消息，因此作为可选项留着，未擅自启用。

**② 一直在操作 → 一直等；停一会儿 → 自动交还**

- **活动检测**：键盘走 Electron 的 `before-input-event`（无需注入）；鼠标/滚轮无法从主进程观察，所以
  注入一段**被动**监听（`ACTIVITY_PROBE_SCRIPT`：捕获阶段 + `passive: true` + 400ms 节流 + 幂等
  `__dshActivityProbe` 标记），它**不加任何 DOM、不 `preventDefault`**，只往 console 打一条标记，
  主进程在既有的 `console-message` 通道里识别（就在拾取通道旁边）。
- **空闲窗口**：接管时设一个截止时间，每次活动把它推后（默认 30 秒；设置项
  `browser.autoReleaseSeconds`，范围 5–600）。到期自动 `releaseToAgent('auto-idle')`，被等待的调用随即继续。
- 面板「你已接管浏览器」一行显示倒计时（`{n} 秒无操作后自动交还`）与「立即交还」按钮；倒计时用主进程
  给的**绝对时间戳**计算，面板自己每秒走一格。
- 面板里的用户动作（地址栏、历史、收藏、设备、清缓存、下载操作…）也算活动；自动流量
  （`bounds` / `show` / `state` / `prefs`）不算——否则一个忙碌的渲染循环会让 agent 永远等下去。

**③ 主动通知：把提示写进会话，而不是等它来探查**

接管的瞬间，壳通过面板插件往**当前 DSH 会话**追加一条消息：

```js
session.append('user/message',
  { role: 'user', content: [{ type: 'text', text: '【浏览器】用户点击了浏览器页面，已接管控制权…' }],
    source: { kind: 'desktop-shell-browser-control' } },
  { surfaceOp: 'append' })
```

关键在于 **`source.kind` 不是 `'user'`**：DSH 只把 `source.kind === 'user'` 的事件当作真实用户提问，
其它来源照常投影进模型历史但**不会凭空起一个新回合**——这正是 DSH 自己的 `dsh-agent-instructions`
注入工作区指令用的办法。**投递目标是「正在驱动浏览器的那个会话」**：插件的原生工具执行上下文里有
`exec.agent.session`（`dsh-mcp-client` 等包就是这么拿会话的），插件把它记下来作为首选目标，面板上报的
`sessionId` 只作回退——实测踩过：多会话时「面板所在会话」与「被驱动的会话」不是同一个，提示因此落空
（`unknown-session`），而 `sessions.get()` 只解析**活动**会话，写不进去也没有补救入口。链路：面板每条命令
带 `sessionId`（回退）→ 原生工具执行时记下驱动会话 → 壳 `onControlChange` → `PanelBridge.sessionNote()`
（`GET /bootstrap` 取一次性 token → `POST /dsh-desktop-shell/v1/session-note`）→ 插件
`ctx.inject(['sessions'])` 后 `session.append(...)`；投递失败会把**原因 + 活动会话名单**写进 `shell.log`。
插件路由沿用既有防护（同源 + DSH 会话认证 + 一次性 token + 只收 JSON）。

**「写通知」的教训：多说反而误事**。最初每次接管/交还都写一条，措辞是「用户已接管…
在此之前不要重复尝试操作页面」。实测后果：模型读到它，回了「收到，你在操作浏览器 —— 我暂停所有页面操作，
等控制权交还后再继续读结构」，**然后 `turn/end`**——它礼貌地停了，而没有任何东西会叫醒它。
所以现在：**有调用在飞时不写通知**（那条被扣住的结果自己就说了「交还后继续执行」），只在没活可扣时写，
且文案以「通知，无需动作」开头、并明确禁止「结束回合/承诺稍后继续」。这一条有单测钉着
（`browser-control.test.ts`：`无需动作`、`不要因此结束回合`、`不要承诺稍后继续`、`shouldWriteControlNote`）。
**改完的真机复验**（同一会话、同一类任务）：`navigate` 在飞 → 用户点击接管 → 结果被扣住，工具结果
「用户把浏览器控制权交还给了助手（等待了约 30 秒），本次调用继续执行：已打开 https://cn.bing.com/…」；
交还后模型**立刻并行发起 `web_search`** 继续任务，没有再说「我暂停，稍后继续」，最后跑完
snapshot → screenshot → present → 回答。**

**顺带量到的时序**（同一轮真机）：`navigate` 15.2s / 15.4s（等页面加载）；`snapshot` 0.57s 与 0.03s
（必应页 113 个元素）——而百度结果页那次是 36s / 26KB，说明**快照慢是页面相关的**，不是普遍卡死。

### 4.7 面板可见性由面板说了算（M10）+ agent 替你打开侧边栏（M11）

**用户报的两个 bug，一个根因**：「没打开侧边栏时，agent 自动打开的侧边栏显示不完整、不是浏览器的 tab，
然后侧边栏就没法操作了」+「agent 在操作浏览器的时候，我也没法把侧边栏隐藏」。

公开 API 里只有 `bounds` / `show` / `hide` 三条命令，而**面板是唯一知道自己在不在屏幕上的一方**：
它每次布局后量自己的 `getBoundingClientRect()`，不可见或小于 24×24 就发 `hide`（收起侧栏、切到别的
tab、停靠形态变化都会触发）。

问题出在壳这边：`show()` 只看自己记住的 `lastRect`，**从不问面板在不在**。于是

- 用户收起了侧边栏（面板已发 `hide`），agent 的下一次 `navigate { show: true }` 又把视图按旧矩形画了回去
  → 一个盖在界面上、位置像侧边栏但内容只是半张网页的原生视图（原生视图永远画在 DOM 之上，
  所以侧边栏自己也点不到了）；
- 用户想收起侧边栏时，agent 每次调用都把它弹回来 → 「没法隐藏」。

修法（[browser-geometry.ts](../electron/src/browser-geometry.ts) 的 `mayPlaceSurface` +
[browser-view.ts](../electron/src/browser-view.ts)）：

- 视图可见性**只由面板决定**：`bounds` 里是可用的矩形 → 面板在屏幕上；`hide` → 不在；
- `show()` 区分请求方：**面板自己**（它刚量完，理应在屏幕上）随时可摆；**agent**（`navigate { show: true }`）
  只在面板当前可见时才摆，否则保持 park 并记一行日志
  「助手请求显示页面，但侧边栏浏览器面板当前不可见：页面继续在后台运行」；
- 页面照常加载（后台标签），`state().visible` / `navigate` 的返回文案都说实话
  （「后台标签 … 侧边栏没开——打开侧边栏的「浏览器」就能看到并接手这个页面」），
  工具描述与内置技能也都改成了「`show: true` 不会替你打开侧边栏」；
- 想看到页面时，用户自己打开面板即可（面板一打开就发 `bounds` + `show`，页面立刻出现，且内容一直在）。

**回归验证**（真 Electron 探针，`visibility-probe.mjs`）：

| 场景 | 期望 | 实测 |
| --- | --- | --- |
| 面板从未打开 + agent `navigate { show: true }` | 不画视图 | parked（`x = -9999`） |
| 用户打开面板（`bounds` + `show`） | 出现在面板矩形 | `40,60 / 700×520` |
| 用户收起（`hide`） | parked | parked |
| **收起后 agent 又 `navigate { show: true }`** | **保持 parked** | **parked**（修的就是这条） |
| 用户重新打开面板 | 又出现 | `40,60 / 700×520` |
| 收起时 `show: false` 导航 | 留在后台 | parked |

规则另有单测钉住（`browser-geometry.test.ts` 的 `mayPlaceSurface`，`plugin-panel.test.ts` 的面板
「不可见就发 hide」），总数 239 项 / 232 通过。

**agent 要求显示时，替用户把侧边栏浏览器打开（M11）**

用户接着提的期望是：**「agent 自动弹应该通过侧边栏浏览器打开页面」**——不是浮一层，而是像他自己点一下
右侧栏的「浏览器」那样，把面板打开、页面嵌在里面。

打开 pane 是**纯客户端**操作，主进程没有这个能力，但 DSH 客户端把入口给了插件：`ctx.sidebarRight`
（我们的面板本来就在用它注册 tab 类型）上有

- `openTabIn(sessionId, kind, options)` —— 面向某个会话打开/显示该类型的 tab（会话的面板没挂载也能开）；
- `openTab(kind, options)` —— 面向当前挂载的侧栏；
- `toggleExpanded()` —— 展开/收起侧栏（DSH 自己的 ExpandButton 用的是内部 `actions.setExpanded(id, true)`）。

于是链路补成：

```text
agent: navigate { url, show: true }
  → 壳发现面板当前不可见（panelVisibleNow=false）
  → 取会话 id：面板上报过的（browserTabSessions）→ 没有就问插件 /state 的 driverSessionId
  → IPC browser-open-pane { tabId, sessionId, expand } 发给 DSH 页面
  → 面板（**不在 Panel 组件里**：用户从没打开过时组件根本没挂载）
       openTabIn(sessionId, BROWSER_TAB_KIND) → 失败再 openTab(...)
       expand 时：向壳问 panelVisible → 仍不可见才 toggleExpanded()
  → 面板挂载 → 发 bounds + show → 视图落在侧边栏里
```

三个防坑点，都是实测踩出来的：

1. **可见性要问壳，不能查 DOM**：`keepMounted` 让别的会话里没显示的面板体也留在文档中，
   `querySelector('.dsb-bar')` 是假阳性——第一次实测就因为这个跳过了展开，面板始终没出现。
   现在面板发 `{ name: 'panelVisible', tabId }`，壳回 `manager.panelVisibleNow`（`BrowserCommandResult.visible`）。
2. **只在「这一轮面板从未显示过」时才允许展开**（壳传 `expand`）：已经显示过说明布局是用户的，
   盲目 `toggleExpanded()` 会把用户展开着的侧栏收起来。
3. **拒绝也要说实话**：DSH 没给入口 / 会话未挂载 / 展开后仍不可见，都会写一行 diag 日志，
   页面照旧在后台加载，`navigate` 的结果里写明「侧边栏没开」。

**实测（自己跑，不靠用户）**：面板关闭状态下调工具桥 `navigate { url, show: true }`

| | 接展开之前 | 接上之后 |
| --- | --- | --- |
| 会话 id | `未知` | `session-4e00fdcc-ed49-49a3-ba0e-42ead0668ab6` |
| 工具结果 | 「**后台**标签 agent，侧边栏没开」 | 「标签 tab4，**侧边栏里可见**」 |
| 结果 | 面板没出现 | 面板挂载 → 报尺寸 → 视图嵌进侧边栏 |

（`[面板] 已请求打开侧边栏浏览器…` 与「助手要求显示页面…」两行日志成对出现，是这条链路的诊断锚点。）

**实测证据**

| 验证 | 结果 |
| --- | --- |
| 端到端探针（真实 Electron + 真 `BrowserViewManager`） | 遮罩上真点击 → 接管；工具调用**阻塞**（2 秒后仍未结束）；在页面上真点一下 → `autoReleaseAt` 被推后、**过了原窗口仍在等**；停止操作约 7.2 秒后自动交还 → 调用**自己继续**并返回 `页面快照…`，前缀「等待了约 7 秒」 |
| **接管发生在调用正在飞时**（复现用户那次） | 3 秒的调用在 t=3.15s 内部已结束，但结果被扣住；t=5.44s 自动交还后才交付（`heldAfterCallFinished: true`）——这一步无法在接管期间结束 |
| **真机实测（用户自己的会话）** | 23:49:53 起 `navigate` 在飞 → 23:49:55 用户点击接管 → 该调用被按住，**23:50:40 自动交还后才交付**，工具结果原文：「用户把浏览器控制权交还给了助手（等待了约 31 秒），本次调用继续执行：已打开 https://www.baidu.com/s?wd=dsh…」；agent 的下一步 `snapshot` 在交还后 1.3 秒才发起——**接管期间它确实在等** |
| **「等待了，但交还后就结束」的根因（实测对照）** | 同一条流程跑了两次：**通知没写进会话的那次**，交还后 1.3 秒 agent 自己继续发 `snapshot`；**通知写进去的那次**，模型读到「用户已接管…不要重复尝试操作页面」，回答「我暂停所有页面操作，等控制权交还后再继续」然后 `turn/end`——**是我写的通知把它劝停了**。现在：调用在飞时**不写通知**（解释随被扣住的结果返回），只在没活可扣时写，且文案明说「无需动作、不要因此结束回合、不要承诺稍后继续」 |
| **修复后的真机复验（通过）** | 01:27:40 用户点击接管（恰好在 `navigate` 返回后 1ms，结果仍被扣住）→ 「等待了约 30 秒」→ 01:28:25 自动交还（44.6 秒，用户一直在操作）→ **交还后模型立刻并行发起 `web_search` 继续任务**，随后 snapshot → screenshot → present → 回答，全程跑完，没有再出现「我暂停，稍后继续」 |
| **真机快照耗时是页面相关的** | 必应页 `snapshot` 0.57s / 0.03s（113 个元素）；百度结果页 36s / 26KB（169 个元素）——差异来自页面本身，不是普遍卡死 |
| 空闲窗口被活动推后（真机） | 接管发生在 23:49:55，自动交还发生在 23:50:40（**45.9 秒** > 30 秒默认值）：用户一直在操作，窗口一直被推后 |
| 会话写入（真实 `dsh-session` 服务） | `accepted: true`、出现在 `deriveMessages()` 里、`source.kind = "desktop-shell-browser-control"`、**不**被当成用户提问 |
| 多会话下的投递目标（实测踩坑） | 用户在**新会话**里，而面板所属会话是旧的 → 提示落到 `unknown-session`、真机日志报「未能写入会话」。已改为优先投递给**原生工具执行时记下的驱动会话**（`exec.agent.session`） |
| 单元测试 | 等待与超时两条路径（`browser-tools.test.ts` 13 条）、空闲窗口与文案（`browser-control.test.ts` 8 条）、设置三处漂移（`settings-parity.test.ts` 5 条） |

### 4.8 多会话下的放置规则：一条消息、一个实例（M12）

用户报的 bug：**A 会话在用浏览器并保持打开，切到 B 会话（没开侧边栏）时，A 的页面会闪现一下。**
「页面嵌入的逻辑做得不清楚」这个判断是对的，根因就是放置决策散在三条消息里：

```text
旧：syncBounds()  →  { name: 'bounds', rect }         // 位置
                  →  { name: 'show' } | { name: 'hide' }   // 可见性
    状态订阅      →  if (hasPage) { name: 'show' }        // ← 无条件的第二处 show（元凶）
```

切到 B 之后，A 的面板（`keepMounted` 一直挂着）照样收到它自己页面的状态推送，于是发出那条
**无条件 `show`**；主进程手里只有「上次量到的矩形」，就按它把 A 的视图画了出来——正好盖在 B 的界面上。
（原生视图永远在 DOM 之上，所以哪怕只闪一下也非常显眼。）

现在的规则（[client.js](../../src-tauri/resources/dsh-desktop-shell/client.js) 的 `syncBounds` +
[browser-tabs.ts](../electron/src/browser-tabs.ts) 的 `panel` 命令）：

1. **一次测量 → 一条消息**：`{ name: 'panel', instanceId, visible, rect? }`。
   `visible = 面板这个 occurrence 在屏幕上 && 已经加载过页面`；不可见就别带 rect。
   位置和可见性绑在一起，不再有「先报位置、再单独说显示」的中间态。
2. **主进程只认当前实例**：每个面板 occurrence 有一个 `instanceId`；同 tab 上换实例时先 park，
   旧实例迟到的放置请求不会挪动原生视图。
3. **`visible: false` 永远只是 park**：不销毁页面、不建档、不创建视图（所以后台会话的面板报告是无害的）。
   这条也是「副作用的唯一出口」：agent 的 `show`（`show('agent')`）仍然只在 `panelVisibleNow` 为真时才生效。
4. 面板侧**只此一处**发放置消息（`browser-state` 订阅也走它），`bounds` / `show` / `hide` 降级为
   主进程侧的原语（供探针与兼容使用）。

单测钉住这条约束（`plugin-panel.test.ts`：客户端里不得再出现 `void send({ name: 'show' })`、
`name: 'bounds'`、`hasPageRef.current ? 'show' : 'hide'`；必须有 `instanceId`；
`browser-tabs.test.ts`：后台会话的 `panel visible:false` 既不建档也不影响前台会话的视图）。

**同时改进的「agent 替你打开侧边栏」**（M11 的续）：展开侧栏之后还要**选中**我们的 tab，
所以链路补成 `openTabIn/openTab → 问壳 panelVisible → 读侧栏是否已展开 → 必要时 toggleExpanded() →
tabsIn(sessionId) 找到 tab → focus(tabId) → 再问一次壳`；会话 id 拿不到时退回**侧栏自己挂载的会话**
（`sidebarRight.mounted`）。

**踩坑：「打开一下立马关闭，手动打开又被关一次」**（用户实报）。`toggleExpanded()` 是**切换**，
而我最初拿「面板不可见」去推断「侧栏收起了」——侧栏展开着但选中了别的 pane 时同样不可见，
于是 agent 的请求把用户已展开的侧栏**收了起来**；用户手动打开后，另一个请求的待执行定时器又关一次。
修法：**先读状态再决定**，控制器有公开读法 `sidebarRight.isExpanded()`（收起或没有挂载 seat 时为
`false`），读不到再退回布局 `mountedSurface()?.layout.expanded`；**两者都读不到就什么都不做**
（宁可打不开，也不能误收起）。日志里能直接看出走了哪条：
「侧栏本来就是展开的：只选中浏览器 tab，不再切换侧栏」/「侧栏此前是收起的，已展开以显示它」/
「读不到侧栏展开状态，按兵不动以免误收起侧栏」。单测钉住这条（`plugin-panel.test.ts`：
`toggleExpanded()` 必须出现在 `expanded` 判断的 else 分支里）。

实测状态：带会话 id 的真实 agent 流程里成功过一次（结果文案「侧边栏里可见」）；脚本直连工具桥
（没有 agent 会话、也没有会话 id）时链路走完到「已聚焦侧栏里的浏览器 tab（tab2）」为止，
但壳仍报不可见——**tab 被选中了，它所在的 pane 没被显示**，这一步 DSH 没有给插件干净的入口。

**踩坑：「侧边栏打开了，但 agent 请求的页面没显示」**（用户实报）。两个独立原因叠在一起：

1. **新命令绕过了「接管后台页面」**：`show` 命令里有 `adoptAgentTab()`（面板刚出现时，把它自己的空 tab
   换成 agent 在后台标签里开好的页面），我加的原子 `panel` 命令没调它 → 面板出现时是**空浏览器**。
   现在 `panel visible:true` 里同样调用 `adoptAgentTab()`（幂等：面板 tab 已有页面就什么都不做）。
2. **`hasPageRef` 是面板的本地状态**：agent 先在后台标签加载页面、面板随后才挂载时，面板并不知道
   已经有页面 → 报 `visible:false` → 原生视图永不摆放。现在面板**变得可见时先问一次
   `{ name: 'state' }`**，据此设置 `hasPageRef`/`view`，再 `syncBounds()`；这也顺带修好了
   「切走会话再切回来，面板空白」（面板重新挂载后本地状态归零）这一类问题。

回归测试：`browser-tabs.test.ts` 的「a panel that appears takes over the page the agent opened in the
background」（先后台打开 → 面板出现 → 断言面板 tab 拿到了那个 URL、后台 tab 被销毁）；
`plugin-panel.test.ts` 钉住「面板变可见时先 `send({ name: 'state' })`」。总数 241 项 / 234 通过。

**再踩一次：侧边栏开了，里面是「开始」引导页 + 空面板**（用户截图实报）。这次是两个更根本的问题：

1. **`toggleExpanded()` 会把引导页留在原地**。DSH 自己点引导页那张「浏览器」卡片时走的是
   `tab.actions.openTab(kind, { replaceTab: true })`——**替换掉占位的引导页**；我只调
   `openTabIn/openTab`，tab 建了但 pane 里还是引导页。后来在 DSH 客户端里找到了**给插件用的正规入口**：
   `sidebarRight.commandTarget()`（捕获当前 pane）+ `sidebarRight.openTabFromTarget(kind, target)`，
   它一次做完四件事——必要时用 `actions.setExpanded(sessionId, true)`（**set，不是 toggle**）展开、
   把引导页替换掉（`replaceTab: tab.id`）、定位到正确 pane、交给它聚焦。现在这是首选路径，
   并把 `commandTarget` 显式传 `document.body`（默认取「当前焦点元素」，会把我们的 tab 塞进用户正在用的
   那个 pane）。日志里写明了走的哪条：`方式 openTabFromTarget` / `方式 openTabIn/openTab`。
2. **死锁**：面板只有「已经有页面」才肯报 `visible: true`，而壳只有收到 `visible: true` 才把 agent
   后台标签里的页面**交给**这个空面板 → 空面板永远不会被交页面。修法：把两个信号拆开——
   `onScreen`（在屏幕上）与 `visible`（在屏幕上**且**有页面）。壳在 `onScreen: true` 时就执行
   `adoptAgentTab()`（幂等），但只在 `visible: true` 时摆放原生视图（空视图会盖住面板自己的空态提示）。
   面板在被 adoption 之后会收到状态推送 → 报 `visible: true` → 视图被摆放。

回归测试：`browser-tabs.test.ts` 的「an on-screen but empty panel adopts the agent page (the deadlock
that left it blank)」——`onScreen:true, visible:false` 时页面必须被交付、且视图保持 park；
随后 `visible:true` 才摆放。`plugin-panel.test.ts` 钉住 `onScreen` / `visible` 是两个信号。

3. **交付页面时只看 `agent` 标签是不够的**：用户实报「侧边栏开了，但里面还是空态（上方输入网址开始浏览）」，
   日志显示 `方式 openTabFromTarget` 成功、面板也打开了，但没有任何 adoption。原因是 agent 这次**没有**
   用 `agent` 标签：上一轮留下过一个隐藏的面板标签，`tabs.target()` 一直选它（最近 touch 过），
   于是页面在那个旧标签里，而新出现的是**另一个 occurrence**。现在 adoption 泛化成
   `adoptBackgroundTab`：扫描所有「自己不是当前面板且有 URL」的标签，优先 `agent`，其次最近使用；
   接过来之后只关闭 `agent` 这种临时标签，**早先周期留下的用户可见标签保持不动**。
   回归测试：「a fresh panel also takes the page from an older hidden panel tab」。
   总数 242 项 / 235 通过。

### 4.9 壳自己的浏览器抽屉（M13：放弃闯 DSH 分栏，改用自己的容器）

上面 §4.7–4.8 的一连串 bug（浮层闪现、误收起侧栏、引导页占位、空面板）**根源都是同一件事**：
浏览器视图放在 DSH 的右侧栏里，于是"位置/可见性/打开"三件事都要跟 DSH 的分栏框架协商
（`commandTarget`、`openTabFromTarget`、`isExpanded`、`sidebar.right.pane.tab` 的所有权与渲染授权）。

**先做了可行性研究**（读 DSH 的 bundle）：

| 事实 | 结论 |
| --- | --- |
| `root` 插槽声明五个席位：`sidebar`/`main`/`rightbar`(single)/**`shell.overlay`(list)**/`shell.leading` | 右栏 `rightbar` 已被 `dsh-client-ui-sidebar-right` **独占**，插件加不了第二个右栏 |
| 槽渲染的 `renderSlot` 是「静态缩窄到已声明 children」，越权抛 `SlotOwnershipError`/`StaleAuthorizationError`；跨包复用只对 **Component Factory** 有效 | **现有 DSH pane 不能被搬进我们的容器**（它们不是 factory） |
| 插件可见的客户端服务只有 `documentPreviews`/`layout`/`loader`/`modules`/`pluginNavigation`/`resources`/`sessions`/`sidebarRight(Tabs)`/`uiRenderer` | 没有 files/git/terminal/run 服务 → 想在抽屉里重做 IDE 功能只能从零写 |
| `shell.overlay` 是 **list** 席，`chat`/`plugin-manager`/`schedule`/`settings-account`/`session-log`/`shortcuts`/`workspace` 都在用；注册形状 `ctx.slots.register({name:'shell.overlay', id, locale, inject}, Component)` | **我们的抽屉可以合法注册成浮层** ✓ |

**于是方案定为**：抽屉是我们自己的（`shell.overlay` 里的右边缘浮层），**浏览器搬进抽屉**；
IDE 功能（工作区文件/预览/git/终端/运行配置）**继续留在 DSH 的右侧栏**——零重写，因为它们
本来就是 DSH 的插件，且 `rightbar` 是单席，我们既占不了也不该占。

**实现**（[client.js](../../src-tauri/resources/dsh-desktop-shell/client.js) +
[main.ts](../electron/src/main.ts) + [browser-prefs.ts](../electron/src/browser-prefs.ts)）：

- 抽屉正文**直接复用** `createPanelComponent`（同一套工具栏/地址栏/历史/收藏/下载/设备/拾取/冻结），
  只传一个固定的 `useTabInfo`（抽屉只有一个视图，id 固定 `drawer`）——**没有重写任何浏览器功能**；
- 开关由壳决定：`IPC.browser-drawer`（主 → 页）+ 页 → 壳的 `drawerState`/`drawer` 命令，
  状态与宽度持久化在 `browser-prefs.json`（`drawer: {open, width}`，宽度 320–1200，默认 560）；
- agent 的 `navigate { show: true }` → **直接打开抽屉**（不再碰 DSH 的分栏）；
- 页面启动时问一次 `drawerState`，所以刷新页面不会与壳的开关状态不一致；
- DSH 右侧栏里的「浏览器」pane 变成**可选**（设置项 `browser.paneInSidebar`，默认 **关**）——
  打开时仍走 §4.7/4.8 那套（`openTabFromTarget` 等），关掉时侧边栏只保留 IDE 功能，不会出现两份浏览器。

**真机实测（脚本直连工具桥，模拟 agent 请求显示）**：

```text
03:24:34.509 浏览器抽屉：打开（助手要求显示页面）                     ← 壳决定，零 DSH 依赖
03:24:34.703 浏览器面板已打开，接管后台标签的页面 https://example.com/   ← adoption 把 agent 的页面接进抽屉
state → { 当前目标: drawer, URL: https://example.com/, 面板可见: 是 }   ← 原生视图确实摆进抽屉并可见
```

**尚未做的**（等用户看过形状再定）：用户侧的开关入口（快捷键 / 按钮；目前只有 agent 请求与设置）、
多标签条（视图本来就是多个，可以自己画）、以及把"面板上报矩形"彻底换成壳自己算几何。

### 4.11 方案 A：回到 DSH 右侧栏，但按源码的契约来（M14）

拿到 DSH 源码（`D:\workspace\research\deepseek-harness`）后重做了这一块。**结论：不需要替换宿主。**
框架本来就是为"本仓库之外的 tab 类型"设计的，我们只要按契约写。

**源码给出的关键事实**（都在 `packages/client/ui-sidebar-right`）：

| 事实 | 出处 | 对我们的意义 |
| --- | --- | --- |
| `sidebar.right.pane.tab` 按类型 `id` 派发，"key 域保持开放字符串空间，**因为 tab 类型可能来自本仓库之外**" | `src/client/contract/slots.ts` L5–8 | 我们这种外部类型是一等公民 |
| 两阶段注册；"guide 用的就是同一条路径，**ui-sidebar-documentpreview 是活证据**" | `src/client/index.ts` L18–21 | 我们的注册方式是对的 |
| `openTab`/`openTabIn` → `placeTab` → store 的 `openContent`，而 `openContent` **第一件事**就是 `planSetExpanded(state, true)` | `src/client/stores.ts` L308–311（shipped rc.1 同处 L5266） | **"打开即展开"**——以前那套 `commandTarget`/`openTabFromTarget`/读 `isExpanded` 再 toggle 的逆向补丁全部删掉 |
| `multiple: true` = 每次 open 独立内容；省略则同 pane 内 reveal 复用 | `src/client/tab-registry.ts` | 多标签用官方机制；agent 反复"显示"时我们自己先 `tabsIn` 复用 |
| `SidebarRightTabDefinition.guide` = 引导页卡片（`title`/`description`/`icon`/**`commandId`**） | 同上 | **手动入口**就是引导页那张卡（DSH 自己那张"浏览器"卡也是这么来的） |
| 正文拿到 `SidebarRightTabInfo`：`sidebar.expanded`、`panel.id`、`tab.visible`（"Only the foreground Session is visible. Docked bodies require expansion and selection"） | `src/client/contract/slots.ts` L164–195 | 摆放只看官方 `tab.visible`（我们本来就在用） |
| 每会话隔离是宿主内建：store 按 `sessionId` 建、`session-views.ts` 管多会话、`tab-inventory.ts` 管各会话的 tab | `src/client/stores.ts` L173–186 等 | 我们在抽屉里自造的 `drawer-tabs.ts` 是重复实现 |

**这一轮改了什么**：

1. **打开逻辑**（[client.js](../../src-tauri/resources/dsh-desktop-shell/client.js)）：`openTabIn(sessionId, kind)`（会话定向）→ 退 `openTab(kind)`；
   先 `tabsIn(sessionId)` 找同类 tab，有就 `focus` 复用（`multiple:true` 下每次 open 都是新标签）；
   删除 `commandTarget` / `openTabFromTarget` / 延迟 toggle / 重放 openTabIn 那一整套；
   `toggleExpanded()` 只在文档化的 `isExpanded() === false` 时调用。
2. **关闭 DSH 自带的浏览器插件**（[desktop-files.ts](../electron/src/desktop-files.ts)）：overlay 里加
   `- id: ui-sidebar-browser` + `disabled: true`（DSH 自己的测试 overlay `apps/web/tests/no-sidebar-browser.overlay.yml`
   就是同一个机制）。它不认领资源地址（定义里没有 `patterns`），所以关掉不会让链接失效；好处是引导页
   只剩我们一张"浏览器"卡、侧栏里只有我们一个浏览器 pane。
3. **手动入口**：引导页卡片（`guide`，带 `commandId`）+ 快捷键命令 `dsh-desktop.browser.new`
   （`ctx.shortcuts.register`，默认键 desktop 平台 `primary+shift+B`）。
4. **抽屉降级为可选**：设置 `browser.paneInSidebar` 现在**默认开**（= 用 DSH 右侧栏的 tab）；
   关掉才注册 `shell.overlay` 里的抽屉 + 右边缘按钮。避免两套标签记账同时活着。
5. **放置诊断**：panel 每次状态变化（或 10 秒）写一行
   `[面板] 放置：宿主可见=… 侧栏展开=… 测量=W×H onScreen=…`，把"为什么没摆放"一眼说清
   （宿主可见性来自官方 `tab.visible`，展开态来自 `sidebar.expanded`）。

**真机实测（脚本直连工具桥，模拟 agent `navigate {show:true}`）**：

```text
助手要求显示页面：已请面板打开侧边栏浏览器（会话 未知，面板从未显示过→必要时展开侧栏）
[面板] 已请求显示侧边栏浏览器（会话 未知，方式 openTabIn/openTab（自带展开），壳原本请求展开）
[面板] 已聚焦侧栏里的浏览器 tab（tab10）
[面板] 放置：宿主可见=true 侧栏展开=true 测量=863×914 onScreen=true
state → 共 1 个标签（tab10，当前目标、可见）URL: https://example.com/  面板可见: 是
```

**测试**：249 项 / 242 通过（7 个既有 blake2b 失败）。新增护栏钉住：注册形状（`id`/`kind`/`multiple`/
`keepMounted`/`guide.commandId`/快捷键）、"逆向补丁已消失"（源码里不得再出现 `openTabFromTarget(`/
`commandTarget(`）、以及 overlay 里必须禁用 `ui-sidebar-browser`。

**两个用户实报 bug 的根因与修法（M14 补）**：

1. **「agent 正在访问的页面不显示，下一轮才出现」**：面板 tab 之前是**新建一个空视图再复制 URL**
   （`manager.navigate(donorUrl)`）。复制是**快照**：agent 还在加载时复制到的是旧状态，真正的页面
   要等 agent 下一次调用（那时可见 tab 才成为它的 target）才出现——正好是用户描述的现象。
   现在改成**移交视图**：`adoptAgentTab()` 直接把这个 tab **记录**（连同存活的 `WebContentsView`）
   挪到面板的 id 下，面板自己那个空视图销毁；视图的 `notify`/`onPick`/`onControlChange`
   经 `rebindManager` 重指到面板的 occurrence（[browser-view.ts](../electron/src/browser-view.ts) 的 `rebind`）。
   于是**只有一个视图、不重载、不闪旧内容**，agent 此刻的加载就发生在用户看得见的地方。
   日志：`浏览器面板已接管后台视图（同一个视图，页面不重载）：<url>`。
2. **「新建一个会话，这次侧边栏没有打开」**：这是本轮引入的**回归**。`openTabIn(sessionId, …)` 对
   **store 从未被采纳**的会话是**静默 no-op**（源码注释：*nothing happens for a session whose store was
   never adopted*）且**不抛错**，我的代码把"没抛错"当成功 return，于是再也没走 `openTab` 兜底。
   现在调用后必须核对 `tabsIn(sessionId)` 里有没有我们的 kind，没有就抛错进入兜底
   （`openTab(kind)` 作用于当前屏幕上的会话——新会话通常正是在屏幕上的那个，其 store 已采纳）。

回归测试：`browser-tabs.test.ts` 三处 adoption 断言改成"**记录移动、不新建视图**"
（`fakes.has('panel-1') === false` / `fakes.get('agent')?.destroyed === false` / `tabState` 带过页面）；
`plugin-panel.test.ts` 钉住 `openTabIn` 的效果核对。实测：
`视图已销毁 → 浏览器面板已接管后台视图（同一个视图，页面不重载）→ 面板可见: 是`。
**会话隔离与"同会话同一个浏览器"（M15，用户实报第二轮）**：

用户截图暴露三个问题，根因都是**浏览器标签没有按会话划分**：

1. **侧边栏开着但空着**：面板先就位、agent 后导航时，**没有任何事件去移交**（接管原本只在面板
   claim 时发生）。现在每次 agent 调用结束都会 `adoptForSession(sessionId)` 再检查一次。
2. **第二个会话复用了第一个会话的浏览器**（agent 原话："已有一个标签正停在 OpenAI 新闻页"）：
   agent 的后台标签 id 是**全局** `agent`，且 `target()` 不带会话。现在：
   - 后台标签按会话：`agent:<sessionId>`（`agentTabId()`）；
   - `toolHost(sessionId)` 绑定调用方会话，`target(sessionId)` 优先"**本会话可见的面板 tab**"，
     再退本会话 scratch，再退本会话其它标签；
   - 接管只在**同会话**内进行（`adoptAgentTab` 过滤 donor 的归属）；
   - `tabs(sessionId)` / `state().tabCount` 也只报本会话的标签。
   会话 id 的来源：插件从 `exec.agent.session.id` 取出，随工具桥 POST 体一起送到壳
   （`agent-bridge` 的 `call(name, args, signal, sessionId)`），MCP 表面没有会话 id 时为空。
3. **同会话里 agent 与侧边栏不是同一个浏览器**：现在同一会话若有**可见的面板 tab**，agent 直接
   驱动**那一个**（不再另建隐藏副本），面板出现的时机只影响"何时移交"，不影响"是不是同一个视图"。

实测（直连桥带 sessionId）：

```text
A: navigate(example.com)   → 已打开（后台标签 agent:session-A…）
A: state                   → 共 1 个标签，当前目标 agent:session-A
B: state                   → 共 0 个标签，当前目标 (无)          ← 隔离
B: navigate(iana.org)      → 已打开（后台标签 agent:session-B…）
A/B: tabs                  → 各自只看到自己那一页
```

回归测试：`browser-tabs.test.ts` 新增「two conversations never share a browser tab」与
「an agent call in a conversation drives that conversation's on-screen panel tab」。
**已知边界**：DSH 的 `sidebarRight` 绑定"屏幕上那个会话"，所以当 agent 在**后台会话**里要求显示页面、
而该会话的 store 尚未被采纳时，`openTabIn` 是 no-op，我们核对后退回 `openTab`（打开你在看的那个
会话）。同会话（正常情形）不受影响。

### 4.11.7 M22：遮罩跟 **agent 的回合**走（不再一闪一闪），并彻底修掉"卡住不撤"

用户复验后报了三件事：

> 遮罩层一直会一会显示一会消失……浏览器总是一闪一闪的。而且在 agent 执行完后，遮罩层没有关闭，
> 等我从会话切走再切回来，它关闭了……是不是在执行过程中，我会话切走了也会导致遮罩层消失啊。

三件事其实是**两个真 bug + 一个设计问题**：

| 现象 | 根因 |
|---|---|
| 执行完后遮罩**卡住**，切走再切回才消失 | `showVeil` 是 async（第一次要给遮罩建一个 WebContentsView）。一次很快的调用可能在 `await` 返回**之前**就结束了，于是 `endAgentActivity` 看到"遮罩还没显示"直接 return（`if (!this.veilVisible) return`），随后那次 show 才完成 —— 遮罩亮着，而**已经没有人负责把它关掉**。切走会话会 park 视图（`hide()` 里顺手 `hideVeil()`），这就是"切走再切回来它才消失" |
| 一闪一闪 | 遮罩是按**每一次工具调用**开关的（begin 显示 / end 在 `MIN_VEIL_MS` 后隐藏），而两次调用之间模型要思考几秒到几十秒；更糟的是每次 begin 都会 `loadURL` 重写遮罩文档来换文案 —— **给一个已经在屏幕上的透明层重载文档，本身就是一次可见的闪烁** |
| 担心切走会话会丢控制 | 状态本身没丢（`agentCalls`/回合状态都留着），但 **park 语义**以前是"关掉"：`hide()` 调 `hideVeil()` 把意图也清了，切回来只靠"下一次工具调用"重新升起 |

修法是把遮罩从一个"到处开关的布尔"改成**一条推导规则**：

```ts
private veilShouldBeUp(): boolean {
  if (this.userDriving) return false                                  // 用户接管了：不显示
  if (this.agentCalls > 0) return true                                // 有调用在跑
  if (this.turnRunning === true && this.turnTouched) return true       // 回合还在跑，且这一回合碰过这个浏览器
  return Date.now() < this.lingerUntil                                // 刚结束：短暂保留，避免连续回合闪
}
```

1. **回合信号来自 DSH 自己**（这是用户说的"监控 agent 的状态"）。DSH 客户端有权威的会话运行状态：
   `uiSession.sessionStatus`（由服务端 `api-session/status` 事件驱动，见
   `packages/client/ui-session`）。面板 `ctx.inject(['uiSession'])` 读它，变化时发
   `{name:'agentRunning', running}`；壳把它路由给**该会话的**浏览器视图们
   （`BrowserTabs.handle` 的 `agentRunning` 分支，不会为没碰过的回合造视图）。
   回合结束 → 遮罩**立刻**撤下；拿不到这个服务（老版本 DSH）→ 退回 `VEIL_LINGER_MS = 8s` 的兜底。
2. **文案原地改，不重载文档**：遮罩文档多了 `window.__dshVeilLabel`，壳用一次
   `executeJavaScript` 改文字，不再 `loadURL`。
3. **park ≠ 停手**：`hide()` 现在只 park 视图与遮罩层（`syncVeil` 负责摆位），**不清除标记意图**。
   所以切走会话时遮罩跟着视图一起 park（原生视图本来也不可能浮在别的会话上），切回来时
   `show()` → `applyBounds` → `syncVeil` 直接把遮罩带回来 —— 执行过程中来回切会话不会丢控制权。
4. **不会再有卡住的遮罩**：`showVeil` 在 `await` 之后重新判断一次"还该不该显示"，不该就立刻撤下。
5. 面板里那条「助手正在操作」横条用同一条规则（`state().agentActive = veilShouldBeUp()`），
   所以横条和原生遮罩永远同步。

实测（隔离实例，连续两次工具调用，间隔约 200ms）：

```
2026-…07:43:02.659Z 遮罩已显示（正在打开网页（navigate））
2026-…07:43:03.771Z 遮罩已隐藏
```

——**一对**，中间没有第二次显示/隐藏（改之前是每一次调用一对）。真回合（真实对话里 agent 连续操作）
由回合信号保持整段亮着，回合结束时立刻撤下。

测试：253 项、246 通过（7 个既有 blake2b）。新增用例：回合信号按会话路由且不造视图、
遮罩文案原地更新（不重载）、linger 常量合理。

### 4.11.6 M21：组件身份 = **侧边栏 tab occurrence**；遮罩是组件的内部状态

用户重新表述了架构（原话要点）：

> 打开的每一个浏览器是独立的实体……agent 在控制的浏览器需要有「agent 控制遮罩层」，这个遮罩层
> 是属于这个浏览器的，别的浏览器不共享……agent 只需要管理跟这个浏览器的控制状态就可以了，不用
> 关心遮罩层的显隐，因为这个显隐的状态在浏览器里……agent 执行完了一定要关闭遮罩层（最好是监控
> agent 的状态，如果执行结束了则自动关闭，如果让 agent 主动关闭，我怕因为 LLM 模型漂移问题，最后没关闭）。

这条**修正了 M18 的抽象**（M18 写的是"一个会话 = 一个壳视图 + 一个 scratch"）。正确的单位是
**DSH 侧边栏里的一次 tab**，不是会话：用户可以在同一个会话里开多个浏览器 tab（tab 类型本来就注册成
`multiple: true`），每个 tab 都是一个独立组件实例。落地为三条规则：

1. **身份 = `<会话 id>::<侧边栏 tab id>`**（[client.js](../src-tauri/resources/dsh-desktop-shell/client.js) 的 `viewId`）。
   - 只按会话：同会话的多个 tab 会被压成同一个浏览器（多标签能力消失）。
   - 只按 tab id：DSH 的 tab id 按键会话铸造，两个会话的 `tab5` 撞车（M17 的真 bug）。
   - 两者相乘才是"这一次 tab occurrence"，也就等于"这一个组件实例"。
2. **adoption 只从 scratch 取视图**（[browser-tabs.ts](../electron/src/browser-tabs.ts) `adoptAgentTab`）。
   agent 在"还没有 tab"时浏览，页面活在按会话生成的 scratch 视图 `agent:<sessionId>` 里；第一个
   进入屏幕的 tab 把它**接管**（搬记录、不复制 URL、不重新加载）。
   关键约束：**scratch 是唯一的捐赠者**。同会话的另一个侧边栏 tab 是"另一个浏览器"，开第二个 tab
   必须得到一个**空**浏览器，而不是把第一个 tab 的页面抢走——这条有专门用例
   （「a second tab in the same conversation is a second, empty browser」）。
3. **遮罩属于组件，agent 只谈控制权**。工具目录里没有遮罩工具；`beginAgentActivity` 只做一件事：
   在**这次调用将要驱动的那个视图**（`target(sessionId)`）上升起遮罩——而不是"给这个会话升起遮罩"。
   会话里已经有屏幕上的 tab 时两者等价，但在 adoption 前后它们不等价，按会话取会把遮罩升到另一个
   view 上（M20 记的"遮罩卡住"就有这一支）。

配套地，`target(sessionId)` 补上"**agent 的显式选择**"这一档（`chosenId`，由 `switch_tab` 写入）：
一个会话里有多个 tab 时，"屏幕上那个"永远只有一个，没有这一档 agent 就够不到另一个 tab。它**不**被
面板的布局流量（bounds/show/state）清掉——否则一次 resize 就把 agent 的选择偷回去——只在**用户真的
操作了浏览器**（`USER_ACTIVITY_COMMANDS`）或那个 tab 被关闭时清掉。

**"执行完一定关掉"是壳监控出来的，不是求模型记得**：

- 主路径：`main.ts` 的 `call()` 用 `try/finally` 把**每一次**工具调用括起来（原生工具与 MCP 两条
  通道都汇到这里，是唯一入口），调用一结束就 `endAgentActivity()`。
- 兜底：`BrowserViewManager` 另有一个 5 分钟看门狗（`AGENT_VEIL_MAX_MS`）。它衡量的是"**多久没有
  新调用**"而不是单次调用时长，所以 `wait`/长 `snapshot` 不会误撤；只有调用**再也不会回来**
  （CDP 卡死、渲染进程没了、传输被中断而 `finally` 没跑到）时才撤下遮罩并清零计数。

**这一轮顺带查实并修掉的两个真 bug**：

| bug | 现象 | 根因 | 修法 |
|---|---|---|---|
| 关闭侧边栏 tab 不销毁浏览器 | 关掉的标签页面继续在后台跑，原生视图泄漏 | close handler 发的是 DSH 的**裸 tab id**，壳里没有这个 key（其他命令都用 `viewId`） | 用同一个身份 `<会话>::<tab>` 发 `close`，并让壳在没有对应视图时记一行日志 |
| 每次 `navigate` 恰好 15 秒 | agent 每次打开网页都等 15 秒，遮罩也跟着挂 15 秒 | `waitForLoad` 只等 `did-finish-load`，而调用方的 `loadURL` **已经**在同一个事件上 resolve 了；晚一步注册就永远等不到，只能耗满超时 | 同时监听 `did-stop-loading` 并按 `isLoading()` 轮询（120ms），实测 15.0s → 0.2s 级 |

实测（隔离实例 41733，agent 工具桥直连）：

```
已打开 https://example.com/（标题：Example Domain）
  （标签 session-b23e0bec-…::tab4，侧边栏里可见：用户看到的正是这一页）
遮罩已显示（正在打开网页（navigate)）   →   遮罩已隐藏
```

- 目标是**用户已经打开的那个 tab**（`…::tab4`），不是新造一个隐藏视图；
- 第二个会话（`verify-B`）浏览得到自己的 `agent:verify-B`，且屏幕上那个会话仍是
  `…::tab4` / `https://example.com/`、`面板可见: 是`（互不干扰）；
- 遮罩成对出现，没有残留。

测试：250 项、243 通过（7 个既有 blake2b 失败）。新增/改写用例：adoption 搬视图不重载、
adoption 后遮罩仍落在同一个视图上、同会话第二个 tab 是空浏览器、agent 能显式选择驱动哪个 tab、
关闭 tab 只销毁那一个、agent marker 落在"这次调用将驱动的视图"、**新会话第一次调用就显示页面**。

#### 复验修复：新会话第一次打开浏览器"什么都不显示，切走再切回来才显示"

用户实报。两个 bug 叠在一起，缺一个都复现：

1. **状态推送按错字段过滤**（[client.js](../src-tauri/resources/dsh-desktop-shell/client.js)）。
   主进程的 `browser-state` 推送是按**视图 id**（`<会话>::<侧边栏 tab>`）打标的，而客户端订阅里写的是
   `next.tabId !== tabId`（DSH 的裸 tab id）——于是**所有**推送都被丢掉，面板永远不知道"页面已经有了"。
   它不会主动上报可见，原生视图也就永远不被摆放。改用 `viewId`（标题条那一层仍用裸 `tabId`，因为
   那是 DSH 自己的 key）。
2. **adoption 只有一个触发点，而它在错误的时刻到达**。壳是**先**请页面开 tab、**再**加载页面的
   （这样侧栏有整个加载时间去挂载），所以面板的第一次声明**必然**发生在页面还没有 URL 的时候：
   `adoptAgentTab` 找不到捐赠者，什么都不做，而此后再没有任何东西让面板重新声明一次。
   修法：`adoptForSession(sessionId)` 作为**第二个触发点**，在导航成功（页面有 URL）的那一刻调用——
   找到该会话"在屏幕上、且还是空的"那个 tab，把后台视图搬过去。声明触发仍然保留，覆盖反方向
   （agent 已经在浏览、用户才打开 tab）。

时序上两种情况都覆盖：声明早于加载完成 → 由导航后的第二触发点接管；声明晚于加载完成 → 由声明自己接管。

另外把工具返回的"可见/后台"改成**问事实**：adoption 之后状态推送→面板重新声明→壳摆放是**一个来回**，
所以 `navigate(show: true)` 会最多等 400ms（`settleVisible`）再如实回答用户是否真的看到了这一页；
面板不在屏幕上时立即返回，不空等。

回归测试：`browser-tabs.test.ts` 的「a new conversation's first call shows the page without switching
tabs」按真实时序构造（第一次调用建后台视图 → 面板声明空 tab → 导航成功 → 断言页面已上屏、tab 数仍为 1）；
`plugin-panel.test.ts` 用源码断言钉住推送过滤必须比 `viewId`。

### 4.11.5 M20：遮罩归视图所有（跟 webview 走，而不是另管一套状态）

用户的最后一条建议：**遮罩应该跟着 webview 走**，切换会话时不该出现"遮罩丢失/残留"；而且遮罩
状态应该由"agent 调用浏览器接口"这件事本身带出来，不该单独给 agent 一个遮罩接口。

先确认第二点：**我们从来没有给 agent 遮罩接口**——工具目录里没有遮罩工具，
`begin/endAgentActivity` 由桌面壳在 `call()` 的 try/finally 里自动配对（M19 已让它覆盖第一次调用）。
所以这条本来就是对的，现在有测试钉住。

第一点做了两处结构性改动：

1. **`syncVeil(rect)`：遮罩位置只有一个决定点**（[browser-view.ts](../electron/src/browser-view.ts)）。
   规则写在一处——`veilVisible && !userDriving && 矩形可用` 才摆在视图矩形上，否则 park。
   `applyBounds`（视图移动）、`showVeil`、`hideVeil` 全部走它。于是**park 视图就是在同一次调用里
   park 遮罩**，不可能出现"视图走了遮罩留下"（用户报的残留），也不会出现"视图在屏幕上但遮罩被丢掉"。
2. **同时只有一个表面在屏幕上**（[browser-tabs.ts](../electron/src/browser-tabs.ts) `panel` 分支）：
   某个会话的视图被摆上时，**其余会话的视图一律 `hide()`**。这是"切会话"这条路径上的兜底：
   即使 DSH 那边没有及时上报 `visible:false`，旧会话的视图（连同它的遮罩）也会被 park。

新增用例「placing a conversation's view parks every other one, veil included」；
246 项测试 239 通过（7 个既有 blake2b）。真机日志仍是成对的：
`遮罩已显示（正在打开网页（navigate））` → `遮罩已隐藏`。

**顺带记录一个真实失败路径**：重启后如果 DSH 还没有挂载任何会话（停在首页/工作区），
`openTab` 会抛 `sidebarRight: no session surface is mounted` —— 我们如实报告"DSH 未接受打开请求
（页面留在后台）"，不假装成功。会话打开后一切正常。
### 4.11.4 M19：控制标记随调用自动出现、自动释放

用户复验后的最后一条：**第一次导航时看不到"agent 正在操作"，要等第二次操作才出现；而且调用结束后
也没有释放**。根因在 `beginAgentActivity(toolName, sessionId)`：

```ts
const target = this.target(sessionId)
if (target === undefined) return          // ← 第一次调用时视图还不存在
```

一个会话的**第一个**调用通常就是创建视图的那一次（`navigate`），所以：

- 升起遮罩时找不到视图 → 直接 return → **第一次导航完全没有标记**；
- 第二次调用时视图已存在 → 有标记 ✓（用户看到的正是这样）；
- 由于第一次没记录在案，`end` 也就无从释放。

修法就是用户建议的"接口自带标记"：

1. **`beginAgentActivity` 先 `ensure` 会话视图**，再记录并按 manager 升起遮罩——第一调用也有标记；
2. **`endAgentActivity` 无条件释放**：先按 manager 递减在飞计数，**再对所有未跟踪的视图兜底调用一次**
   （manager 内部 `agentCalls > 0` 才生效，所以兜底不会误减）。超时、提前返回、视图中途出现等
   任何路径都不会留下卡住的遮罩。

遮罩状态同时通过 `push()` 推给面板（`state.agentActive` → 面板顶部的"助手正在操作"横条），
所以浮窗与横条一起出现、一起消失。

真机日志（新会话的第一次调用）：

```text
遮罩已显示（正在打开网页（navigate））      ← 第一次调用就有
遮罩已隐藏                                  ← 调用结束即释放
```

新增用例「the agent marker is automatic: it appears on the very first call of a conversation」；
245 项测试 238 通过（7 个既有 blake2b）。
### 4.11.3 M18：按用户的模型简化 —— 一个会话 = 一个壳视图

> **已被 §4.11.6（M21）取代**：身份的正确单位是「侧边栏 tab occurrence」而不是会话——同一个会话也可以
> 开多个浏览器 tab，每个 tab 都是一个独立组件实例。M18 的"会话 = 视图"只在"一个会话只开一个 tab"时
> 成立；下面保留当时的推理与删改记录。

用户看完前三轮后给了一个更简单的模型，而且是对的：

> agent 发起浏览器访问 → 判断侧边栏是否开启 → 开启后让壳的 webview 加载网页；会话和这个浏览器视图
> 有个关系；新建会话就新建视图；切换会话就切换到对应视图。

也就是说：**身份应该是"会话"，不是 DSH 的 tab id**。M17 的 `session::tabId` 只是把撞车问题绕开，
模型上仍然是"两个东西再互相移交"。这一轮把移交整套删掉：

| 删掉 | 原来为什么要它 | 现在为什么不需要 |
| --- | --- | --- |
| `adoptAgentTab()`（移交视图记录 + 重建 record） | 面板 tab 与 agent 后台 tab 是**两个视图**，要把 agent 的视图挪给面板 | 视图 id 就是会话 id，**本来就是同一个视图** |
| `adoptForSession()`（每次调用后再检查） | 面板先就位、agent 后导航时没有事件去移交 | 同上，没有可移交的东西 |
| `rebindManager` / `BrowserViewManager.rebind()`（重接推送/拾取） | 记录换 id 后要把推送改指向新 id | id 不再变化 |
| `agentTabId(session) = 'agent:<session>'` 的临时标签 | agent 先用后台标签，等面板出现再合并 | 直接用会话 id 当视图 id |

保留并强化的：会话隔离（`target(sessionId)`、`tabs(sessionId)`、`tabCount` 按会话）、
遮罩按 **manager** 记账（不再依赖 id）、面板 claim 只认自己的会话（后台会话的 claim 只会 park）。

**行为**（正是用户描述的那条链路）：

1. agent 在会话 S 发起访问 → 视图 `S` 按需创建（`ensure(S)`），页面就加载在那里；
2. 侧边栏没开 → 壳请页面打开（`sidebar.right` 的 `openTabIn/openTab`，自带展开）；
3. 面板出现并 claim 会话 S → **同一个视图**被摆到面板的矩形里（没有复制、没有重载、没有等待）；
4. 切到别的会话 → S 的 claim 变成 `visible:false`，视图被 park（页面继续在后台跑）；
5. 新会话发起访问 → 新的视图，旧会话的页面不会出现。

**验证**：`tsc` 干净；244 项测试 237 通过（7 个既有 blake2b）。重写了 6 条旧模型下的测试，新用例：
「one conversation owns one view, so the panel shows the page the agent loaded」、
「a panel that is open first is filled by the agent's next navigation」、
「two conversations never share a browser view」（含切换会话时另一个被 park）、
「the veil comes down on the view that raised it」。真机（真实会话 id）：
`navigate { show: true }` → 结果文本
`（标签 session-1a9c1bcd-…，侧边栏里可见：用户看到的正是这一页）`，`面板可见: 是`，
`遮罩已显示 → 遮罩已隐藏`。

**又一次低级事故（如实记录）**：删 `adoptAgentTab/adoptForSession` 时我用了一个跨行正则，
把 `browser-tabs.ts` 从 665 行删到 276 行（`toolHost` 等整段丢失）。靠 **`dist/main.js.map` 里的
`sourcesContent`** 完整恢复了上一次构建的源码，再用 `edit` 的精确锚点重做删除。
教训升级版：**删代码一律用精确锚点（`edit`），绝不用行区间拼接或跨行正则；构建产物里的 sourcemap
是这类事故的安全网（值得保留）。**
### 4.11.2 M17：会话隔离的真正漏洞 —— DSH 的 tab id 是**按会话**铸造的

用户第三个会话复验后报了三件事：①侧栏打开后页面要等一会才加载；②agent 调用结束后浏览器仍显示
"被 agent 控制中"；③新会话的侧栏显示的是**上一个会话**的页面。

**根因是同一个**：DSH 的 dockkit 把 tab id 的计数器放在**每个会话的 store** 里
（`stores.ts` 的 `SurfaceState.minted` 注释：*How many ids this surface has minted*），所以
**两个会话都会出现 `tab5` 这种 id**。而桌面壳的视图表是按"面板报上来的 id"存的：

- 新会话的 `tab5` 撞上旧会话的 `tab5` → `ensure()` 直接返回**旧会话那个视图** →
  新会话的侧栏显示旧会话的页面（③）；
- agent 后来的 `navigate` 落在这个被复用的视图上 → 用户看到"打开之后过一会页面才出来"（①）；
- `beginAgentActivity` 与 `endAgentActivity` 分别在移交前后解析 target，落到**不同视图** →
  遮罩计数停在 1，永远不会隐藏（②，`endAgentActivity` 只在同一個 manager 上递减）。

**修法**（两处，都是"把身份说清楚"而不是加特判）：

1. **视图 id 会话限定**（[client.js](../../src-tauri/resources/dsh-desktop-shell/client.js)）：
   面板发给壳的 id 是 `<sessionId>::<tabId>`（没有会话 id 时保持原样），状态推送与拾取事件也按
   这个 id 过滤。DSH 的 id 再撞也不会撞到壳的视图表。工具结果里显示的标签 id 因此长这样：
   `session-401669bb-…::tab2`（对模型是好事：一眼看出属于哪个会话）。
2. **在飞调用按 manager 记账**（[browser-tabs.ts](../electron/src/browser-tabs.ts)）：
   `inflightCalls: Map<BrowserViewManager, number>`。视图被移交给面板时 **record 的 id 变了、
   manager 没变**，所以 `end` 按 manager 回收遮罩才是对的。原来按 tab id 找 target 的做法正是
   遮罩卡住的原因。

**验证**：`tsc` 干净；247 项测试 240 通过（7 个既有 blake2b）；新增护栏
「a panel view id is session-qualified」与新增用例
「the veil comes down on the view that raised it, even after the panel takes it over」；
真机 `navigate { show: true }` → 结果文本
`（标签 session-401669bb-…::tab2，侧边栏里可见：用户看到的正是这一页）`，
日志 `遮罩已显示（正在打开网页（navigate））→ 遮罩已隐藏`。
### 4.11.1 M16：清理与"侧栏打不开"的真凶

用户报"现在侧边栏都打不开了"。日志显示机器其实是工作的（`视图已创建 → 面板已接管后台视图 →
snapshot/click`），真正的原因是**我改过的两段模型可见文本**：

- `navigate` 的 `show` 描述写着"面板没打开时它什么也不会打开……不会强行弹出"；
- 技能里写着"`show: true` **不会替你打开侧边栏**"、"工具返回面板没打开时，告诉用户去右侧栏打开"。

模型照着做：它认为侧栏不会自己开，于是先去请求用户（截图里"请你打开面板"），再在后台加载。
`show:true` 早就能可靠打开（§4.11 的 `openContent` 自带展开 + 核对兜底），所以这两段文本已经
改回正确语义：**`show:true` 就是"打开右侧栏并把这一页摆到用户眼前"，同一个视图**；
只有 `show:false` 才是纯后台。

**顺手做的清理（删掉半套系统，而不是再加补丁）**：

| 删掉 | 为什么 |
| --- | --- |
| 抽屉组件、启动按钮、右边缘让位/拖宽逻辑、`.dsb-drawer*`/`.dsb-launcher` CSS | 方案 A 之后浏览器只有一个表面（右侧栏 tab），抽屉是第二个系统 |
| `drawer-tabs.ts` + 单测、`browser-prefs.drawer`、`IPC.browser-drawer` + preload、主进程 6 条抽屉命令 | 宿主已经提供多标签与会话隔离，这套记账是重复实现 |
| `browser.paneInSidebar` 设置（壳/插件 host/插件 client 三处 + 护栏） | 只有一个表面就没有"放哪"的问题 |
| 客户端里 `shell.overlay` 注册、`sidebarRightWidth`/`useSidebarRightOffset` | 随抽屉一起 |

同时把 `navigate` 的工具结果文案改成如实描述：可见时说"用户看到的正是这一页"；
不可见时说清常见原因（该会话不在屏幕前台／右侧栏被收起）并明确"不要因此停下"。

**过程的教训（如实记录）**：清理时我用一次 PowerShell 行区间拼接删代码，用了一个没在同一次进程里
重算的变量，把 `client.js` **整份复制了一遍**；恢复时又切错接缝，文件一度语法不合法。最后按
"前缀 + 接缝 + 唯一结尾"重建并逐项自检（关键符号各出现一次、语法检查、`tsc`、246 项测试）才恢复。
**教训：这类删除不要用行号拼接，用 `edit` 的精确锚点。**

**验证**（清理后）：`tsc` 干净；245 项测试 238 通过（7 个既有 blake2b）；真机
`navigate { show: true }` → 结果文本"（标签 tab5，侧边栏里可见：用户看到的正是这一页）"。
**结果与边界**：唯一表面是 DSH 右侧栏里的浏览器 tab（与文件/终端/预览并列），多标签/会话隔离/展开
按钮/引导页卡片全部由宿主提供；我们只负责原生视图、遮罩、控制权移交与那一套工具。抽屉保留给
"想要独立浮层"的用户（设置里可切），但两套不会同时注册。



- **遮挡处理（冻结快照）**：原生 `WebContentsView` 永远盖在 DOM 上，所以位置信息/收藏栏这类下拉只要
  一打开就会被页面压住。做法：面板打开菜单前让主进程 `capturePage()` 截一张图并 park 视图，
  面板把这张图当页面底渲染，菜单就能点；关菜单时恢复。
  两个必要的细节：**冻结期间 `show()` 是空操作**（否则拖侧栏触发的 bounds 上报会把页面抢回菜单上面）；
  **`hide()` 会清掉冻结标记**（否则「菜单开着切走标签」会让这个视图以后再也显示不出来）。
- **菜单一定会关**：点菜单外面、按 Esc、切走标签、面板卸载四条路径都收尾并解冻——菜单开着意味着
  用户看到的是静止的图，所以任何一条漏掉的路径都像是「卡住」。
- **没有可见表面时不冻结**：空标签（还没输入网址）或已被 park 的标签上打开菜单，根本没有原生表面
  需要遮，于是 `freeze` 直接回答 `frozen: false`，菜单画在空舞台上即可。早期版本在这里照样「冻结」，
  拿不到帧、却让舞台显示「页面已暂停」的提示——看起来就像浏览器坏了。
- **截图失败也要 park**：`capturePage()` 可能失败（窗口隐藏、导航中、DevTools 占用）。这时仍然要
  park 表面（否则菜单会被网页盖住、完全点不到），只是没有帧，面板给一段诚实的提示。
- **面板侧诊断进 `shell.log`**：`[面板] 菜单打开 / 菜单关闭（原因）/ 冻结：有帧 N` 与主进程的
  `冻结视图（帧=…）` / `解冻视图：已恢复|无需恢复` 成对出现。客户端 console 在壳里看不到，
  这条通道是这类「看不见的状态机」唯一的现场证据（上面那个空白问题就是靠它定位的）。
- **主页可设置**：`⋯` 菜单里显示当前主页，并提供「把当前页设为主页」/「清除主页」——
  以前只有读取、没有写入入口，主页按钮等于没用。
- **下载栏**：会话级（不是 per-tab）——标签可以在下载中途关掉，文件得继续下。文件名冲突自动
  变成 `x (1).pdf`；进度推送按 300 ms 合并。
- **设备行**：预设 / 自定义宽高（240–2560 夹紧）/ 旋转（交换宽高并告诉 Chromium 屏幕转了）/
  「跟随窗口」清掉模拟。规则抽到纯模块 [browser-device.ts](../electron/src/browser-device.ts)，
  所以有单测（`browser-device.test.ts`）；下载同理（[browser-downloads.ts](../electron/src/browser-downloads.ts)）。

## 5. M5 交付（设置开关 + 运行诊断）✅

### 5.1 `browser.enabled` 开关

关掉之后：**不注入**工具面（agent 看不到任何浏览器工具——原生工具不注册、MCP 行也不注入）、
**不启动**工具桥、面板 tab 也不注册；浏览器本体代码仍在包里，随时可以再打开。

- 设置文档的真相源仍是 `shell-settings.json`，新增长度最小的 `browser.enabled`（缺省＝开，
  所以老设置文件不会被当成「关闭」）。三处写法都改了：
  - 壳：`electron/src/settings.ts`（读取）+ `settings-shape.ts`（合并写入）+ `settings-ui/index.html`（壳自己的设置页）；
  - 插件 host 半：`src-tauri/resources/dsh-desktop-shell/index.js`（`validatePatch` 白名单 + `withDefaults` + PUT 的嵌套合并）；
  - 插件 client 半：`client.js`（DSH 设置页「桌面端」的复选框 + patch + 打开面板前先读设置决定是否注册）。
- **`validatePatch` 白名单是这把锁的钥匙**：往设置文档里加字段却忘了改它，保存会直接报
  「未知设置项」。这种三处漂移正是本仓库踩过的坑，所以新增了
  [settings-parity.test.ts](../electron/src/settings-parity.test.ts)——它把插件与壳的三个文件当**文本**读，
  断言字段在每一侧都存在（是漂移护栏，不是行为测试，文档里也这么写）。
- 生效时机：开关是**启动时**的决策（工具行/工具桥）与**页面加载时**的决策（面板注册），
  所以改完要重载 DSH 界面，最直接的是设置页的「保存并重启」。

### 5.1.1 `browser.agentTools` 开关（工具面）

`auto`（默认）/ `native` / `mcp`，语义与自动回退见 §3.2。它同样走三处：壳的 `settings.ts`
（类型 + 读取，并由 `main.ts` 交给 `decideToolSurface`）、插件 host 半的
`TOOL_SURFACES` 校验 + `withDefaults`、插件 client 半的下拉框与提交补丁。
设置页「运行状态」多一行**浏览器工具呈现方式**：`原生工具` / `MCP 工具 · <原因>`，
原因就是 `decideToolSurface` 给出的那句（例如「自动回退 MCP：上次注册失败…」）。

### 5.2 让状态看得见（否则「开着但没工具」和「根本没注入」长得一样）

- `desktop-facts.json` 新增 `browser: { enabled, tools, bridge, toolSurface, toolSurfaceReason, nativeToolCount }`
  ——**只记数量、枚举与原因**，能力路径与 bearer 从不落盘。壳在启动时写入（`main.ts` → `writeFacts`）。
- DSH 设置页「运行状态」新增三行：
  - **浏览器工具**：`14 个工具` / `14 个工具（工具桥未启动）` / `已关闭`；
  - **浏览器工具呈现方式**：`原生工具` / `MCP 工具 · <原因>`；
  - **浏览器面板**：`已注册` / `设置里已关闭` / `桌面壳未提供能力（旧版壳？）` /
    `DSH 侧缺少 sidebarRight（版本不匹配）` / `注册失败（见日志）` / `等待注册`。
  这些分支由 `client.js` 里的 `browserPanelCheck` 记录，注册路径的每个失败点都写它。
  验收时第一眼就能分清「DSH 版本不匹配」和「壳没注入」——这是本功能最容易静默失败的一步。

## 6. 验证记录

### 6.1 一次白屏事故与由此加的护栏（务必先读）

**现象**：右侧栏整块白屏；`shell.log` 里**没有任何错误**，也**没有**「侧边栏浏览器视图已创建」。
（面板没挂载 ⇒ 没发 `create` ⇒ 没有原生视图。）

**根因**：`BrowserPanel` 里导航订阅的 `useEffect` 依赖数组引用了**后面才 `const` 声明**的
`refreshHistory`（我把浏览器外观的 helper 写在了 effect 之后）。依赖数组是在**渲染期**求值的，
于是抛 `ReferenceError: Cannot access 'refreshHistory' before initialization`（TDZ）→ 面板正文渲染
失败 → 白屏。而 `apply` 正常返回、host 半正常，所以外层链路看不出任何异常。

**四条护栏**（这类问题不该再靠肉眼）：

1. [plugin-panel.test.ts](../electron/src/plugin-panel.test.ts)：把 `client.js` 放进最小 DSH 模块宿主
   （`window.__ModuleLoader__` + 最小 React hooks + 假 cordis 服务）里真正跑一遍——
   `apply` → 渲染 `Panel` → 模拟一次拾取。回归时它直接失败（就是上面那个 TDZ）。
   同一套还钉住：chip 事件（`slash/input-insert-reference` + 自包含 ref + `draftRev` span）、
   chip 不生效时退化为纯文本、以及「缺 sessionId / 缺 inputActions 也要能渲染」。
2. [main.ts](../electron/src/main.ts) 把 **DSH 页面（渲染进程）的 error/warning 转发进 `shell.log`**
   （过滤 Electron 自带的「未打包」安全提示）。以前客户端插件的异常只出现在 DevTools 里，
   远程诊断完全看不到。
3. 面板注册**不再压在「await 读设置」上**：先注册，读到「已关闭」再调 disposer 撤销。
   否则那次网络往返一旦挂住，面板就永远不出现（同样是白屏，且无日志）。
4. 组件内顺序约定写进注释：所有 helper 必须放在使用它们的 effect **之前**。

**第二次事故（同一片白）**：修完 `hide()` 之后我让 `freeze()` 复用 `hide()` 来 park 视图，
而 `hide()` 的任务正是「清掉冻结标记」——于是冻结把自己刚设的标记清掉了，`unfreeze()` 认为
「没有冻结」直接返回，**视图永久 park**（关闭菜单后 React 又把冻结图清掉 → 中间空白）。
修法：把这段状态抽成纯模块 [browser-freeze.ts](../electron/src/browser-freeze.ts)
（`beginFreeze` / `endFreeze` / `clearFreeze` / `blocksSurfaceShow`），**park 与 hide 分成两条路径**
（`freeze()` 只 park 表面，不经过 `hide()`），并用 [browser-freeze.test.ts](../electron/src/browser-freeze.test.ts)
钉死四条语义：可见时冻结→关闭要恢复；不可见时冻结→关闭不得显示；hide 清掉冻结；
重复解冻无害。教训是同一条：**主进程里这类「标记 + 副作用」的状态机必须能被单测直接驱动**。

> 经验：`apply` 不抛错 ≠ 插件没问题。**渲染期**的错误（TDZ、undefined props、hook 顺序）
> 只会在面板里留一片白，所以插件必须有能真跑一遍的宿主测试。

自动化（可在无 GUI 环境跑）：

```powershell
cd electron
# 本机没有独立 node，用工作区里的 Electron 以 Node 模式跑：
$env:ELECTRON_RUN_AS_NODE='1'
node_modules\electron\dist\electron.exe node_modules\typescript\bin\tsc --noEmit   # 0
node_modules\electron\dist\electron.exe scripts\run-tests.mjs                      # 228 tests / 221 pass / 7 fail(既有)
node_modules\electron\dist\electron.exe build.mjs                                  # dist ready
```

> 7 个失败全部来自既有的 `blake2b.test.ts`：它用 `crypto.createHash('blake2b512')` 做参照，
> 而 Electron/BoringSSL 没有该摘要。用 `git archive HEAD` 的**未改动**代码复跑得到同样 7 个失败，
> 与本功能无关。

本轮新增的单测（36 个文件中的 21 个）：`browser-geometry.test.ts`、`browser-tools.test.ts`、
`agent-bridge.test.ts`、`browser-snapshot.test.ts`、`browser-tabs.test.ts`、`browser-picker.test.ts`、
`browser-prefs.test.ts`、`settings.test.ts`（新增浏览器开关用例）、`settings-parity.test.ts`（三处漂移护栏）、
`browser-device.test.ts`（设备预设/夹紧/旋转）、`browser-freeze.test.ts`（冻结/解冻/hide 的状态语义）、`browser-tool-surface.test.ts`（原生/MCP/自动回退的判定）、`browser-tool-schema.test.ts`（schema 是否落在原生子集内）、`async-timeout.test.ts`（卡住的渲染进程要有界）、`browser-skill.test.ts`（技能字段契约：注册能过、加载也要能过）、`browser-overlay.test.ts`（遮罩出现的时机、文案、点击标记）、`browser-control.test.ts`（等待/活动/自动交还的规则与文案）、`browser-downloads.test.ts`（下载取名与状态机）、`plugin-panel.test.ts`（在最小宿主里真跑一遍面板：白屏护栏 + chip 链路）
覆盖矩形/地址策略、工具文案与参数（含 tabs/switch_tab/screenshot.fullPage）、MCP 鉴权与
tools/list+call 往返、注入脚本语法、多标签目标选择规则、拾取通道与 nonce 校验、
设置合并与三处漂移护栏、以及「面板能渲染出来」这条底线。
> 一个测试环境的坑：`node --test` 走 Node 的类型剥离模式，**不支持构造函数参数属性**
> （`constructor(private readonly x)`），所以被单测导入的模块（如 `browser-tabs.ts`）必须写成
> 显式字段赋值。Electron 侧不参与单测的模块不受影响。

外部证据（本次实测，非推断）：

1. `dsh --dump-config`：overlay 里的 MCP 行确实进入合成树；
2. 起一个**真实 dsh**（隔离 `DSH_HOME` + 备用端口 + 我们格式的 overlay）：三种 `name` 写法
   （包名 / 绝对路径 / file URL）**都能挂载并带 bearer 打到我们的能力路径**；
3. 用 **DSH 自己的 MCP 客户端**（`@modelcontextprotocol/client@2.0.0`）连我们的 SDK 1.31 服务：
   `initialize` 成功、`tools/list` 返回 **14 个工具**（含 `tabs`/`switch_tab`）、`tools/call` 触发我们的处理器；
4. esbuild 打包后的桥（与 `dist/main.js` 同样的打包方式）单独跑通一次完整 MCP 往返；
5. **仓库自带的 smoke 测试跑通**（真实 Electron 壳 + 隔离 userData/DSH_HOME + 备用端口 41730）：
   `SMOKE cookie (isolated home) → PASS`，日志里出现「浏览器 agent 工具桥已就绪（14 个工具，MCP/loopback）」，
   DSH 子进程起来了、面板插件 host 半注册了路由、DSH 页面加载完成（468 节点、`readyState=complete`）、
   cookie 换取成功。这说明 M1–M5 的主进程改动**没有破坏启动链路**；
6. **开关关闭路径实测**：预写 `browser.enabled=false` 的 `shell-settings.json` 后以同样方式启动真实壳，
   实测 `{ overlayHasPanelPlugin: true, overlayHasMcpRow: false, overlayHasMcpClient: false,
   factsBrowser: { enabled: false, tools: 0, bridge: false }, logHasBridgeReady: false,
   logHasDisabledNotice: true }` —— 开关确实同时掐掉了 MCP 注入与工具桥，面板插件仍在（否则设置页也进不去）；
7. **原生工具面实测**（真实壳 + 隔离实例，本轮）：overlay 里**没有** MCP 行、插件拿到 `nativeTools`
   配置；`browser-tool-registration.json` 为 `{ ok: true, count: 14 }`；日志出现
   「已注册内置技能 sidebar-browser」「已注册 14 个原生浏览器工具」「面板插件已注册 14 个原生浏览器工具」；
8. **走插件同一条路直接打工具**（curl 打 `/call/<capability>`，即插件 `execute` 用的端点）：
   `snapshot`（已加载页）0.0s 返回完整快照、`find` 0.0s、`click index=1` 0.7s 成功、
   未知工具名返回 `isError`；空白标签上的 `snapshot` **0.1s** 返回「页面还没有加载」而不是挂住；
   防护抽查：带 `Origin` → 403，无 token → 401；
9. **技能契约实测**：`scripts\check-skill-contract.mjs` 在真实 `dsh-skill` + 真实 Cordis 上下文里
   `register → list → get` 通过（含「故意缺 source 必须被拒」的反向断言）；修前用户实际报错为
   `loaded skill "sidebar-browser" source must be a string`（见 §6.3）；
10. **两个被这一轮验证逼出来的真 bug**（见 §6.2）：`click` 读 `null.tag`（**每次点击都失败**）、
    空白标签上的页面脚本 `executeJavaScript` 永不返回（30s+ 挂住模型的回合）。

### 6.2 这一轮从验证里揪出来的两个真 bug

两个都不是迁移本身引入的，而是**「把工具面接到真实调用链上」才暴露出来的旧缺陷**——MCP 时代同样存在，
只是没人从这条路上走过去：

1. **`click` 对任何元素都失败**：页面脚本 `buildElementCenterScript` 在**没有被遮挡**时返回
   `obscured: null`，而 `browser-view.ts` 只判了 `!== undefined`（TS 类型当时写的是
   `obscured?: {…}`，把这个谎圆过去了），于是 `null` 一路传到
   [browser-tools.ts](../electron/src/browser-tools.ts) 的 `result.obscured.tag` → 抛
   `Cannot read properties of null (reading 'tag')`。修法：类型改成 `… | null` 并把判断改成
   「既不是 undefined 也不是 null」——顺手让类型不再说谎。
   实测：修前 `click index=1` 报错，修后 0.7s 成功并跟随跳转。
2. **空白标签上的工具会挂住**：视图从未导航过时 `executeJavaScript` **永不 settle**，`snapshot`
   于是挂到 30s+ 才被传输层掐断（模型的回合就那样卡着）。修法：`script()` 先判断
   「有没有真正的文档」（`about:blank`／空 URL 不算），没有就立刻返回
   「页面还没有加载：先用 navigate 打开一个网址」；再用
   [async-timeout.ts](../electron/src/async-timeout.ts) 的 `withTimeout` 给所有页面脚本加 20s 上界，
   超时给出「页面可能卡住了，试试 reload」。实测：空白标签 `snapshot` 从 30s+ 变成 **0.1s** 的明确错误。

教训与 §6.1 相同：**新增一条调用路径时，要用真实请求把每个工具都走一遍**——这一次是靠
`/call` 端点上的一串 curl 做到的，成本几分钟，抓到的是「点击永远失败」这种级别的缺陷。

### 6.3 内置技能「注册成功但加载失败」

**现象**（用户实测）：日志里「已注册内置技能 sidebar-browser」一切正常，但模型一打开技能就报
`Error: loaded skill "sidebar-browser" source must be a string`。

**根因**：注册与加载是两套校验。`ctx.skills.register(skill)` 只查 name / description / invocation；
而 `registry.get(name)`（模型加载技能走的就是这里）会再跑一次 `validateDefinition()`，它额外要求
`source` / `provider` / `content` 都是字符串。`provider` 由注册表补默认值，**`source` 必须注册时自己给**——
我漏了它，于是"注册成功"这个信号是假的。

**修法**：技能定义移到独立模块 [browser-skill.js](../src-tauri/resources/dsh-desktop-shell/browser-skill.js)
并补上 `source: 'desktop-shell'`（独立成文件是为了让测试能直接 import 它）。两层护栏见 §3.3：
可移植的字段契约测试 + 用真实注册表跑 `register → list → get` 的核对脚本（附带"故意缺 source 必须被拒"
的反向断言，避免出现"什么都没发生也算通过"的假绿）。

**教训**：「注册成功」不等于「能用」。凡是**注册时宽松、使用时严格**的接口，验证必须走使用者那条路
（这里是 `get()`），而不是注册那条路。

跑**开发通道**（端口 41733、独立 userData/profile），与在跑的正式实例互不干扰：

```powershell
cd electron
pnpm build
$env:DSH_DESKTOP_DSH_ENTRY = 'D:\Program Files\DSH Desktop\resources\runtime\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js'
pnpm start
```

（仓库里的 `electron/runtime/dsh` 只带 bin 垫片、不带 375 MiB 运行时；打包运行自带，不需要这个变量。）

1. 右侧栏 guide 出现「浏览器」→ 点开是新 tab（标题「浏览器」）；
2. 地址栏输入 `example.com`：原生视图加载；`←`/`→`/`⟳` 生效；拖动侧栏/缩放窗口网页跟随；
3. 再从 guide 开第二个浏览器 tab（`multiple: true`）：两个标签各自一个页面、各自历史；
   在两个标签间切换时网页跟着切，被切走的那个隐藏但保活；tab chip 标题显示页面标题；
4. 关闭一个标签：只销毁那一个视图（日志「侧边栏浏览器视图已销毁」），另一个不受影响；
5. 在对话里让 agent 调用浏览器工具（例如「用浏览器打开 example.com，读一下页面结构」）：
   应先 `mcp__desktop_browser__navigate`，再 `mcp__desktop_browser__snapshot`；
6. 开了多个标签时让 agent 先 `tabs` 看列表、`switch_tab` 选目标，确认后续操作作用在选中的那个；
7. 若面板没开：`navigate` 会创建一个隐藏标签（后台浏览），`state`/`tabs` 会标出它是后台的不可见；
8. **元素拾取**：点工具栏 `⌖` → 在网页上移动鼠标（蓝色高亮）→ 点击某个元素 →
   输入框里应立刻出现一个**引用 chip**（`@ #选择器`，可删），发送时才展开成
   `--- 页面元素 (#sel) --- … --- end ---`；面板**保持干净**（成功时不显示任何东西）。
   若 chip 通道不可用会退化为纯文本插入，两条都不行才提示并复制到剪贴板；
9. **设备模拟**：点 📱 → 出现设备行；切 iPhone 页面按手机视口重排；改宽高立即生效；
   旋转交换宽高；「跟随窗口」回到全宽；
10. **整页截图**：让 agent 调 `mcp__desktop_browser__screenshot`（`fullPage: true`），
    结果里应说明「整页」并给出 PNG 路径；
11. **开关**：DSH 设置页 → 桌面端 → 「侧边栏浏览器」取消勾选 → 保存并重启 →
    侧边栏不再出现「浏览器」，让 agent 尝试用浏览器工具应报「没有这个工具」；
    设置页「运行状态」里应显示 **浏览器面板：设置里已关闭**、**浏览器工具：已关闭**。
    重新勾选并重启后恢复；
12. **历史下拉**：点地址栏 → 下拉出现（页面变成一张冻结图），能点、能删单条、能清空；
    点菜单外面 / 按 Esc 都要关掉并**立刻恢复页面**（不是留下静止图）；
13. **下载**：在浏览器里点一个下载链接 → 面板底部出现下载条（带进度）→ 完成后「打开」/「📂」
    可用；「清除已完成」清掉它；文件落在系统「下载」目录，重名自动加 `(1)`；
14. **收藏**：★ 收藏 → `⋯` 打开「显示收藏栏」→ 收藏栏出现；**双击**改名，悬停出现 `×` 删除；
    重启应用后收藏与主页仍在；
15. **主页设置**：`⋯` 菜单里能看到当前主页；打开一个网站后点「把当前页设为主页」，`⌂` 应打开它；
    「清除主页」后 `⌂` 打开空白页；
16. **空标签开菜单**：在新标签（还没输入网址）上点 `⋯` → 菜单正常出现，**不应**出现「页面已暂停」提示；
    关掉菜单后 `⌖` 仍是灰的、舞台回到「在上方输入网址开始浏览」；
17. **原生工具面**：设置页「运行状态」应显示 **浏览器工具呈现方式：原生工具**；`desktop-facts.json` 里
    `browser.toolSurface == "native"`；overlay（`dsh-overlay.yml`）里**没有** `desktop-browser-mcp` 行；
    日志里有「已注册 14 个原生浏览器工具」与「已注册内置技能 sidebar-browser」；
18. **回退路径**：把设置页的「浏览器工具呈现方式」改成 `mcp` → 保存并重启 → overlay 里应出现 MCP 行、
    运行状态显示 **MCP 工具**，让 agent 打开一个网页仍然可用（证明两条门面等价）；
19. **技能生效**：新开一个对话说「用侧边栏浏览器打开 example.com 并读一下页面结构」，
    模型应当按 `navigate → snapshot → 用 [n] 索引` 的顺序做，而不是猜坐标或盲点；
20. **助手遮罩**：让 agent 在浏览器里做任何操作（例如「打开 example.com 并读页面结构」）→
    网页上应出现一层**半透明暗色遮罩**，中间写着「助手正在操作 · 正在打开网页（navigate）」与本轮工具名；
    调用结束后遮罩自动消失（`shell.log` 里有「遮罩已显示/已隐藏」）。`state`/`tabs` **不应**触发遮罩；
21. **点击接管 → agent 等待**：遮罩出现时在网页上点一下 → 遮罩立刻消失，面板出现
    **「你已接管浏览器 · N 秒无操作后自动交还 · 立即交还」**；此时让 agent 再操作 → 它**不失败**，
    而是**一直等着**（那次工具调用一直不返回）；你继续在页面上点/滚/打字 → 倒计时一直往后推、它一直等；
22. **空闲自动交还**：停止操作，等倒计时归零 → 面板提示消失，agent 那个调用**自己继续**并返回真实结果，
    开头是「用户把浏览器控制权交还给了助手（等待了约 N 秒），本次调用继续执行：」；
    日志里能看到「用户已停止操作 N 秒：控制权自动交还给助手」；
23. **主动通知**：接管那一刻 `shell.log` 应有「浏览器控制权已交给用户…」与
    「[dsh-desktop-shell] 已向会话写入控制权提示：…」两行；对话里也能看到那条 `【浏览器】…` 提示
    （它以 `source.kind = desktop-shell-browser-control` 写入，不会被当成你自己说的话，也不会凭空触发新回合）；
24. **设置**：DSH 设置页 → 桌面端 → 「接管后自动交还（秒）」改成 10 → 保存并重启 → 再接管，
    倒计时应从 10 秒开始；
25. **点击**（上一轮修复）：让 agent `click` 一个元素 → 应返回「已点击 元素 [n]」而不是
    `Cannot read properties of null`；空白标签上 `snapshot` 应**立刻**返回「页面还没有加载」而不是卡住。

## 8. 下一步

- 剩下的 one-code 差距只有两项，且都是「默认行为已经安全、只是缺交互」：站点证书提示
  （`certificate-error`，现在是加载失败）与 HTTP 授权弹窗（`login` 事件，现在是拒绝）。
- 页面内查找 / 缩放：one-code 也没有，属于「需要时再加」。
- 把「当前目标标签」暴露成 DSH 的会话级状态，让模型在回答里能引用「你正在看的这个页面」。
- **`snapshot` 在重页面上太慢也太大**：真机实测百度结果页（169 个可交互元素）耗时 **36 秒**、返回
  **26KB** 文本（约 7–8k tokens）。要查的方向：选择器构造是否退化成 O(n²)、可见性计算的开销、
  以及按视口/元素数更早地截断（现在只截展示条数，不截扫描量）。这条与接管无关，但是真机上最影响体验的
  一项。
- 原生工具面既然已经在插件里，可以顺手用上 DSH 自己的策略钩子：`ctx.tools.guard` /
  `tools/pre-execute` 做「有副作用的点击先问用户」、`ctx.tools.restrict` 按 agent 收紧浏览器工具；
  这些是 MCP 门面拿不到的，也是当初决定迁移的理由。

## 9. 发布注意

功能发版需 `pnpm runtime:prepare`，让 `runtime/dsh/desktop-runtime.json.shell` 等于新版本号，
再走 [release-electron.mjs](../electron/scripts/release-electron.mjs)；面板插件与工具桥都随包分发
（桥在 `dist/main.js` 里，插件走既有 `extraResources`）。

**发版前必跑**：`node_modules\electron\dist\electron.exe scripts\run-tests.mjs`（应 0 新增失败），
尤其是 [browser-tool-schema.test.ts](../electron/src/browser-tool-schema.test.ts)——它挡的是
「新版 DSH 扩大了/收紧了原生注册表的 schema 子集，导致原生工具在用户机器上静默消失」这一类问题；
以及 [settings-parity.test.ts](../electron/src/settings-parity.test.ts)（设置三处漂移）。
用新版 DSH 更新 `runtime/dsh` 之后，还要跑 `node_modules\electron\dist\electron.exe scripts\check-skill-contract.mjs`（期望 `SKILL_CONTRACT PASS`），并按 §7 的第 17/18/19 条各走一遍，确认原生与回退两条门面、以及技能都能加载。

## 10. 与 one-code 的复用关系（MIT）

| one-code 文件 | 用法 |
| --- | --- |
| `browser/BrowserManager.ts` | 蓝本：视图创建、离屏停放、导航/开窗策略、事件→状态推送 |
| `browser/snapshotScript.ts` | **逐字复用** → `browser-snapshot.ts` |
| `browser/browserInput.ts` | **复用**（1 行本地改动）→ `browser-input.ts` |
| `browser/pickerScript.ts` | **复用**（改回传通道为免 preload 的双通道 + nonce）→ `browser-picker.ts` |
| `browser/agentBrowserTools.ts` | 工具语义与文案蓝本 → `browser-tools.ts` |
| `web/webMcpServer.ts` | MCP over loopback 的样板思路（我们用官方 SDK 实现） |
| `renderer/lib/browserOcclusion.ts`、`hooks/useSuppressBrowserView.ts` | M3 遮挡处理参考 |