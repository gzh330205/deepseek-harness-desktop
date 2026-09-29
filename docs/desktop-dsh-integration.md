# DSH Desktop 与 DSH Web 集成设计

本文描述 DSH Desktop（Tauri 2 外壳）与 DeepSeek Harness（DSH）Web 走向一体化的技术设计：由 Desktop 把自身设置与信息注入 DSH，使用户在 DSH 设置页配置 Desktop，并在 DSH 页面查看 Desktop 信息。

## 1. 背景与目标

现状：DSH Desktop 与 DSH Web 是两个割裂的程序。Desktop 只负责拉起 DSH 服务并把 WebView 导航过去；Desktop 自己的设置需要单独的设置窗口，DSH 侧对 Desktop 的存在、版本、状态一无所知。

目标：

| 编号 | 目标 | 说明 |
| --- | --- | --- |
| G1 | Desktop 启动时注入自身设置与信息 | 把设置与运行事实暴露给 DSH，而不是各自维护一份 |
| G2 | 在 DSH 设置页配置 Desktop | 用户不再需要在 Desktop 原生设置窗口里操作 |
| G3 | 在 DSH 页面展示 Desktop 信息 | 版本、端口、面板状态等 |
| G4 | 形成一体化体验 | 单一入口、单一设置真相源 |

## 2. 已锁定的设计决定

| 编号 | 决定 | 说明 |
| --- | --- | --- |
| D1 | 设置真相源 = Desktop 的 `shell-settings.json` | 路径 `%APPDATA%\ai.deepseek.dsh-desktop\shell-settings.json`；DSH 仅作为编辑界面，不持有真相 |
| D2 | 只有 Desktop 自己拉起的 DSH 有面板 | 不接入、不复用外部 DSH 实例 |
| D3 | 直接实现「可编辑 + 重启联动」 | 不做只读版本 |
| D4 | Desktop 永远启动自己的 DSH 服务 | 收敛访问面：仅 loopback 绑定、启用 DSH 浏览器认证、`--no-open`、不泄露认证 token |
| D5 | 端口固定，占用即报错 | 默认端口 41729，可用环境变量 `DSH_DESKTOP_PORT` 覆盖；占用时要求用户关闭占用者 |
| D6 | 无浏览器认证或不支持 `--patch` → 拒绝启动 | 并要求用户升级 DSH |
| D7 | 完全删除 Desktop 自己的设置窗口 | 只保留「关于」窗口，内含面板状态诊断 |

## 3. 目标架构

```text
+---------------------------------------------------------------+
|                         DSH Desktop (Tauri 2)                 |
|                                                               |
|  shell-settings.json  <---- 读写 ---+                         |
|  (%APPDATA%\ai.deepseek.dsh-desktop)|                         |
|                                     |                         |
|                     +---------------+------------------+      |
|                     |      启动/重启编排（Rust）        |      |
|                     +---------------+------------------+      |
|                                     |                         |
|              写文件                 |                 spawn   |
|        +----------------------------+-------------+           |
|        v                            v             v           |
|  desktop-facts.json          dsh-overlay.yml   dsh web ...    |
+---------------------------------------------------------------+
         |                            |             |
         |  (桥目录 DSH_DESKTOP_BRIDGE_DIR)           |
         v                            v             v
+---------------------------------------------------------------+
|                        DSH 进程（子进程）                       |
|                                                               |
|  启动: dsh web --patch <overlay> --host 127.0.0.1             |
|        --port 41729 --no-open                                 |
|                                                               |
|  overlay 注入插件 dsh-desktop-shell                            |
|    +----------------------+     +-------------------------+   |
|    | host 半（Node/JS）    |     | client 半（浏览器）      |   |
|    | webServer.register   |<----| HTTP 调用                |   |
|    | /dsh-desktop-shell/  |     | settings.section 注册    |   |
|    |   v1/{bootstrap,     |     | id = desktop, order 18   |   |
|    |   state, settings}   |     +------------|------------+   |
|    +----------------------+                  |                |
+---------------------------------------------------------------+
                                               | Tauri 事件
                                               v
                              window.__TAURI__.event.emit(...)
                                               |
                                               v
                        Rust: app.listen(...) -> emit_to("main",
                              "dsh-desktop-state", ...)
```

关键链路：

| 环节 | 机制 |
| --- | --- |
| 设置读写 | Desktop 读写 `shell-settings.json` |
| 事实与覆盖 | Desktop 写 `desktop-facts.json` 与 `dsh-overlay.yml` |
| 启动命令 | `dsh web --patch <overlay> --host 127.0.0.1 --port 41729 --no-open` |
| 桥目录传递 | 环境变量 `DSH_DESKTOP_BRIDGE_DIR` |
| 插件注入 | 插件 `dsh-desktop-shell`（host 半 + client 半）由 overlay 注入 |
| 设置页入口 | client 半在 DSH 设置页注册 `settings.section` |
| 设置读写通道 | 页面经 HTTP 调 host 半读写设置 |
| 与外壳交互 | host/client 经 Tauri 事件与 Rust 交互：页面侧 `window.__TAURI__.event.emit`，Rust 侧 `app.listen`，Rust 用 `emit_to("main", "dsh-desktop-state", ...)` 回推 |

## 4. DSH 侧可用机制（含源码/实测依据）

| 机制 | 结论 | 依据 |
| --- | --- | --- |
| `dsh --patch <文件>` | 启动器级 overlay，可重复传入；层序为 bundles → profile 的 `cordis.patch.yml` → `--patch` overlay | 源码 |
| overlay 顶层 `- id: X` | 语义是「按 id 覆盖已有条目」；目标不存在会 warning 并跳过 | 源码 |
| 新增条目 | 必须使用 `- insert: [...]` | 源码 |
| `insert` 中的 `name` | 支持绝对/相对路径，DSH 会自动转成 `file://` URL（`anchorInsertedPluginNames`） | 源码 |
| 免安装加载 | 无需 pnpm 安装、无需修改用户 profile；P0 实测：隔离 `DSH_HOME` 下无 `node_modules` 也能加载 | P0 实测 |
| 客户端插件发现 | 由 `dsh-client-modules` 扫描 Loader 条目、读取最近 `package.json` 的 `dsh.client` + `exports["./client"]` 提供 | 源码 |
| 客户端注册 id | 必须等于包名 | 源码 |
| 设置页扩展点 | `settings.section`（整页）、`settings.general.item`、`settings.plugins.tab`；契约在 `@deepseek-ai/dsh-client-ui-settings` | 源码 |
| DSH 原生设置存储 | `ctx.configForms.get('<entry id>').set()` → `dsh-config-editor` 原子写 profile 的 `cordis.patch.yml`；仅 `.volatile()` 字段可编辑。**本设计不使用它**，仅作对照说明 | 源码 |
| 自定义 HTTP 路由 | `webServer.register({kind:'prefix', path, handler})` 可注册自定义路由 | 源码 |

## 5. 安全设计

### 5.1 P0 实测结论

| 编号 | 结论 |
| --- | --- |
| S1 | DSH 浏览器认证：裸请求 `GET /` 返回 401 + `dsh web authentication required` |
| S2 | 带 `?token=` 返回 303 + `Set-Cookie: dsh-auth-<sha256(authority)>`，属性 HttpOnly、SameSite=Strict、Max-Age 2592000（30 天） |
| S3 | 带该 cookie 请求返回 200 |
| S4 | **`webServer.register` 注册的自定义路由完全不受该认证保护**：不带 cookie 的 `GET` 直接 200 |
| S5 | 认证 cookie 的密钥持久化在 `$DSH_HOME/.credentials.yaml`，跨进程重启仍有效（30 天窗口） |
| S6 | 可用的桥 API 门禁方案（P0 实测可行）：把请求携带的 Cookie 透传回探 `GET /`，200 视为已认证、401 视为未认证（伪造 cookie 实测 401） |

S4 是本设计安全模型的核心前提：**不能假设自定义路由天然受保护**，必须在桥内部自行实现认证门禁。

### 5.2 桥 API 防护分层

| 层 | 措施 | 目的 |
| --- | --- | --- |
| ① 认证门禁 | 每个端点先做「Cookie 回探 `GET /`」，200 放行、401 拒绝；可加 5 秒 TTL 缓存 | 把自定义路由重新纳入 DSH 浏览器认证的保护范围 |
| ② 来源校验 | 校验 `Origin` 的 host 必须等于 `Host`；拒绝 `Sec-Fetch-Site: cross-site` | 阻断跨站发起 |
| ③ 写操作内容类型 | 写操作只接受 `content-type: application/json` | 跨站会触发 preflight，而服务端不返回 CORS 头，浏览器会拦截 |
| ④ 第二层凭证 | bootstrap token 作为第二层 | 纵深防御 |
| ⑤ 残留风险声明 | 以同一用户身份运行的本地进程可绕过以上全部措施 | 该进程本来就能直接读 `shell-settings.json`，因此不构成新增暴露面 |

### 5.3 其它收敛措施

| 措施 | 说明 |
| --- | --- |
| 仅绑 `127.0.0.1` | 不做 LAN 绑定 |
| 始终 `--no-open` | 不允许 DSH 自行打开系统浏览器 |
| overlay 覆盖 `web-runtime` 条目 | `printUrl: true`、`openBrowser: false`、`trustedHosts: []`，以强制打印认证地址、禁止自动开浏览器、去掉 LAN trust |
| 日志脱敏 | 日志中把 `token=` 脱敏 |
| 不落盘认证地址 | 不把认证地址写入文件、通知、剪贴板 |

## 6. 关键实现约束（P0 实测）

| 编号 | 约束 | 细节 |
| --- | --- | --- |
| C1 | `--patch` 必须排在 app 参数之前 | `dsh web --patch overlay.yml --host ... --port ... --no-open` 正确；`dsh web --host ... --patch ...` 会报 `error: unknown option '--patch'`（commander `passThroughOptions` 透传）。Desktop 拼参顺序必须固定 |
| C2 | host 半插件 `apply` 抛错 | DSH 仅打印 warning，服务照常启动 |
| C3 | client 半插件 `apply` 抛错 | **整个 DSH 页面 fail-loud**：实测页面显示 `Failed to load plugins` + `web boot: 1 entry did not activate <id>: failed`，设置与会话全部不可用 |
| C4 | client 半的编码纪律 | 必须全程 try/catch、只 inject 必然存在的服务、任何异常降级为「无面板」 |
| C5 | 端口 41729 | 实测可用，且不在本机 Windows 排除段（`netsh int ipv4 show excludedportrange protocol=tcp`） |
| C6 | 端口占用诊断 | 可用 `netstat -ano` 找 PID + `tasklist /FI "PID eq <pid>"` 取进程名 |

C3 决定了 client 半的实现标准：任何在 `apply` 期间未捕获的异常都会让 DSH 整体不可用，而不是仅仅让面板消失。

## 7. 数据流与重启联动

### 7.1 启动流程

```text
读 shell-settings.json
  -> 写 desktop-facts.json + dsh-overlay.yml
  -> spawn dsh web --patch <overlay> --host 127.0.0.1 --port 41729 --no-open
  -> 解析 stdout 中的认证地址
  -> 导航 WebView 至该地址
```

### 7.2 保存设置流程

```text
页面（client 半）
  -> 桥 API（host 半）
  -> 原子写 shell-settings.json，revision + 1
  -> 页面 emit Tauri 事件
  -> Rust 重读设置
  -> 可即时生效的项（如关闭行为）立即应用
  -> 代理等项标记「待重启生效」
```

### 7.3 重启联动流程

```text
页面「保存并重启 DSH」
  -> emit restart-dsh
  -> Rust 重写 overlay / facts
  -> 以新环境重开子进程
  -> 重新认证并导航
```

### 7.4 跨进程写冲突

页面（经 host 半）与 Desktop 都可能写 `shell-settings.json`。解决方式：

| 手段 | 说明 |
| --- | --- |
| revision CAS | 写入时携带期望 revision，不匹配则拒绝并回读 |
| 原子写 | 写临时文件 + rename，避免半写状态 |

## 8. 插件设计

| 项 | 内容 |
| --- | --- |
| 包名 | `dsh-desktop-shell` |
| 分发方式 | 随 Desktop 安装包作为 Tauri resource 分发 |
| 版本策略 | 与 Desktop 同步 |
| host 半 | 纯 JS、零 runtime 依赖 |
| host 端点 | `/dsh-desktop-shell/v1/bootstrap`、`/state`、`/settings`（GET/PUT） |
| client 半 | 注册 `settings.section`，id `desktop`，order 18 |
| 视觉 | 使用 DSH 设计变量 `--dsw-alias-*` 保证原生观感 |

页面展示内容与动作按钮：

| 区域 | 内容 |
| --- | --- |
| 展示 | Desktop 版本、DSH 版本与端口、面板注入状态、当前设置值 |
| 动作 | 保存设置、保存并重启 DSH、检查 Desktop 更新、聚焦主窗口 |

## 9. Desktop 侧改动概要

### 9.1 端口策略

| 项 | 内容 |
| --- | --- |
| 固定端口 | 默认 41729；占用即报错，要求用户关闭占用者 |
| 环境变量覆盖 | `DSH_DESKTOP_PORT` |
| 占用诊断 | 给出 PID 与进程名，并给出两条出路（关闭占用者 / 指定其它端口） |
| 失败态 | 端口不可用时进入明确失败态，不静默回退 |

### 9.2 启动三闸门

不通过则**不 spawn**，并引导用户升级 DSH。

| 闸门 | 检查 |
| --- | --- |
| 版本基线 | `dsh --version` ≥ 认证基线 `0.1.2-alpha.2` |
| overlay 能力 | `dsh --help` 含 `--patch` |
| 端口 | 端口可用（含占用诊断） |

### 9.3 删除项

| 删除对象 | 说明 |
| --- | --- |
| 外部实例发现/复用/HTTP 探测 | 整条链路删除（对应 D2） |
| 设置窗口（Rust 命令） | 设置相关命令删除 |
| 设置窗口（托盘菜单项） | 入口删除 |
| 设置窗口（`index.html` 设置面板） | 面板删除 |
| 设置窗口（`src/main.ts` 设置逻辑） | 逻辑删除 |
| `src-tauri/capabilities/default.json` 的 windows 列表项 | 设置窗口条目删除 |

### 9.4 保留项

「关于」窗口保留，显示：桌面版本、DSH 版本与端口、面板注入状态、更新检查。

### 9.5 Tauri 事件动作白名单

| 动作 | 说明 |
| --- | --- |
| `restart-dsh` | 重写 overlay/facts 并以新环境重启 DSH 子进程 |
| `check-desktop-update` | 触发桌面更新检查 |
| `show-settings-window` | 若设置窗口已删除则改为 `show-about` |
| `focus-main` | 聚焦主窗口 |

## 10. 兼容与降级矩阵

| 场景 | 行为 | 用户可见结果 |
| --- | --- | --- |
| DSH 支持 `--patch` 且支持浏览器认证 | 正常 | 面板可用，设置可编辑 |
| DSH 版本过低或无 `--patch` | 拒绝启动并引导升级 | 明确错误页 + 升级指引 |
| 端口被占用 | 报错含 PID/进程名与两条出路 | 错误提示，要求关闭占用者或指定其它端口 |
| 插件 host 半失败 | warning，服务照常启动 | 面板不可用，DSH 本体正常 |
| 插件 client 半失败 | 整页 fail-loud | DSH 设置与会话全部不可用，需回归测试覆盖 |
| 用户 profile 设置 `printUrl: false` | overlay 覆盖兜底 | 仍强制打印认证地址 |

## 11. 风险清单

| 编号 | 风险 | 说明 / 缓解 |
| --- | --- | --- |
| R1 | client 半 fail-loud | 任何未捕获异常导致整页不可用；缓解为 C4 的 try/catch 与降级纪律 |
| R2 | DSH 客户端 API 版本漂移 | `settings.section` 等契约可能变化；需按版本回归 |
| R3 | 原生设置接口 `.volatile()` | 仅作对照说明：本设计不使用 `configForms` 写入 profile |
| R4 | 跨进程写竞态 | revision CAS + 原子写（见 7.4） |
| R5 | cookie 30 天有效期 | 认证窗口为 2592000 秒；过期需重新认证 |
| R6 | 每次请求回探认证的延迟 | 待验证；缓解为 5 秒 TTL 缓存 |
| R7 | 主窗口导航白名单的实现方式 | 待验证；Tauri 2 主窗口由配置声明，`on_navigation` 需代码创建或事件内校验 |

## 12. 分阶段计划与验收

| 阶段 | 内容 | 验收标准 |
| --- | --- | --- |
| P0 | 探针验证注入、能力矩阵、fail-loud、端口诊断 | 见第 13 节，全部结论已实测 |
| P1 | Desktop 服务层反转：固定端口 / 三闸门 / 删除死代码 / token 脱敏 / overlay 与 facts 生成 | 启动路径只走三闸门；端口占用有 PID/进程名诊断；日志无明文 token；overlay 与 facts 按设置生成 |
| P2 | 插件 host 半桥 API | `/dsh-desktop-shell/v1/bootstrap`、`/state`、`/settings`（GET/PUT）可用；四层防护生效（含 cookie 回探） |
| P3 | 插件 client 半设置页 | `settings.section`（id `desktop`，order 18）出现在 DSH 设置页；读写走桥 API；任何异常降级为无面板 |
| P4 | Desktop 事件联动与重启 | `restart-dsh` / `check-desktop-update` / `focus-main` 生效；保存设置后按「即时生效 / 待重启生效」分类 |
| P5 | 删除设置窗口、文档与发版 | 设置窗口相关代码与 capabilities 条目全部移除；「关于」窗口含面板状态诊断；文档与发版完成 |

## 13. P0 验证结果（已完成）

| 编号 | 验证项 | 结果 |
| --- | --- | --- |
| P0-1 | overlay 注入 | 成功 |
| P0-2 | 无需安装、不改 profile | 通过（隔离 `DSH_HOME` 下无 `node_modules` 也能加载） |
| P0-3 | client 半进入 `__DSH_BOOT__` | 通过，且 `/plugins/??<id>/client.js&rev=<hash>` 可获取 |
| P0-4 | 真实 UI | 出现「桌面端（探针）」section |
| P0-5 | 桥读到 bridgeDir | 页面经桥读到 host 返回的 bridgeDir |
| P0-6 | 首页认证行为 | 裸请求 401；带 token 303；带 cookie 200 |
| P0-7 | 自定义路由认证 | 不受认证保护（200） |
| P0-8 | cookie 回探门禁 | 可行；伪造 cookie 实测 401 |
| P0-9 | host 半失败 | 仅 warning，服务照常启动 |
| P0-10 | client 半失败 | 整页不可用（fail-loud） |
| P0-11 | 端口 41729 | 可用，且不在本机 Windows 排除段 |
| P0-12 | overlay 覆盖 `web-runtime` | 可覆盖 |

探针在仓库外的隔离目录运行（`D:\workspace\research\dsh-desktop-probe`），全程隔离 `DSH_HOME`，未影响用户正在运行的 DSH。

## 14. 待验证清单

| 编号 | 待验证项 |
| --- | --- |
| T1 | 重启后的重新认证导航，需实机验证 |
| T2 | cookie 回探延迟与 TTL 缓存策略 |
| T3 | 用户 profile `printUrl: false` 场景 |
| T4 | 主窗口导航白名单在 Tauri 2 的实现方式 |
| T5 | 每个 DSH 版本升级时的 client 半回归 |

## 15. 实施状态（P0–P5 已完成）

| 阶段 | 内容 | 状态 | 验证方式 |
| --- | --- | --- | --- |
| P0 | 探针验证注入链路、能力矩阵、端口诊断、fail-loud 影响面 | 已完成 | 隔离 `DSH_HOME` 真实启动 + 浏览器观察 |
| P1 | 自启服务、固定端口 41729、启动三道闸门、删除复用/探测死代码、token 脱敏、overlay/facts 生成 | 已完成 | `cargo check/test`、`pnpm build`、真实启动 |
| P2 | 插件 host 半：`/state`、`/bootstrap`、`/settings`（GET/PUT，revision CAS + 原子写 + 校验） | 已完成 | curl 覆盖 401/403/409/400/200 与落盘校验 |
| P3 | 插件 client 半：设置页「桌面端」（状态卡、表单、动作按钮、i18n、降级） | 已完成 | 真实 DSH 页面渲染 + 保存回路 |
| P4 | 桌面壳事件桥、设置重读与应用、重启联动、状态推送、更新检查开关 | 已完成 | `cargo test` 与编译期检查（联动需 GUI 手测） |
| P5 | 删除桌面设置窗口、关于窗口扩充、文档与版本号 | 已完成 | `pnpm build`、`cargo test` |

已知偏差与后续加固：

- `bundle.resources` 中插件在安装产物里的落地路径为 `<resource_dir>/resources/dsh-desktop-shell/`；在真实安装包上验证前，开发模式可用 `DSH_DESKTOP_PLUGIN_PATH` 直接指定插件入口。
- 「保存并重启 DSH」「检查桌面端更新」两个面板动作依赖 Tauri 事件桥，需在桌面端窗口内手测。
- 主窗口导航白名单（只允许当前 DSH origin）尚未实现。
- `src/styles.css` 中桌面设置窗口的样式已不再使用（保留未删，以免影响其它未提交改动）。

## 附：术语

| 术语 | 一句话解释 |
| --- | --- |
| DSH | DeepSeek Harness，提供 `dsh web` 等命令的运行时与 Web 界面本体 |
| Desktop | DSH Desktop，基于 Tauri 2 的桌面外壳，负责启动并承载 DSH WebView |
| profile | DSH 的配置档案目录，其中 `cordis.patch.yml` 参与插件层序合成 |
| overlay | 通过 `--patch` 传入的 YAML 补丁文件，按 id 覆盖或经 `insert` 新增插件条目 |
| settings.section | DSH 客户端设置页的整页扩展点，插件可注册一个独立设置分区 |
| fail-loud | 出错即整体失败并显式报错，而非静默降级；client 半插件抛错会使整个 DSH 页面不可用 |
