# Agent Note: Android 客户端（DSH 口袋，WebView 薄壳）

Status: implemented

## Problem

用户要一个**装在手机上的入口**（不是浏览器书签）来用电脑上的 DSH。这个入口要能：扫电脑上显示的二维码、
记住地址与密码、在电脑的多个地址里自动挑一个能连的，并在电脑上的 DSH 重启（会话失效）后自动重新登录。

桌面侧的网关已经落地（[手机访问网关](../architecture/2026-10-16-phone-gateway.md)）：它提供带密码的 DSH
页面、自己的登录页与 `dsh_pocket` 会话 cookie。手机端要解决的只是「找到它、登进去、把它显示出来」。

## Decision

**薄壳，界面一律不自己实现**：`android/`（Java，Gradle 8.7 + AGP 8.5.2，minSdk 26 / compileSdk 34）。

| 文件 | 职责 |
|---|---|
| `PocketAddress.java` | 纯逻辑：把扫到/输入的文本规范成 `scheme://host:port/`、判断是否局域网、排序去重 |
| `PocketClient.java` | 网关的两个问题：`probe()`（在吗？要不要登录？）与 `login()`（换会话 cookie） |
| `PocketStore.java` | 记住地址（普通 prefs）与**可选**记住的密码（`EncryptedSharedPreferences`） |
| `MainActivity.java` | 编排：探测 → 登录 → 把 cookie 交给 CookieManager → WebView 显示 DSH |

四条关键决定：

1. **界面由网关提供，App 不重写 DSH。** 显示的就是电脑上那套 DSH（同一份页面、同一个实时同步），所以
   桌面更新不会让手机端「不兼容」，最多刷一次页面。这也是不选原生重写的理由。
2. **密码在 App 里输，不在网页里输。** 这样才有「记住密码」——会话随电脑上的 DSH 重启失效，是手机端唯一
   会再次被要求输密码的场景，也正是最需要自动重登的场景。密码进 `EncryptedSharedPreferences`；
   **设备密钥库不可用时宁可不保存**（并如实告诉用户），也不写明文 prefs。
3. **`probe` 401 与 403 语义分开。** 401 = 网关在、要密码；403 = 被 Host 白名单拒了（换地址）；连不上 =
   给具体原因（不在同一 WiFi / 开关关着 / 找不到主机）。「它没反应」对用户没有价值。
4. **会话在页面层失效时自动重登**：`WebViewClient.onReceivedHttpError` 收到主框架 401 时，用记住的密码
   重新换 cookie 再加载，而不是把登录页甩给用户。

## Alternatives considered

- **原生 Compose 重写 DSH 界面**：最强理由是体验最原生（原生滚动、离线缓存、原生通知）。放弃原因：等于
  长期分叉 DSH 的 UI 与客户端协议，桌面每次升级都可能破，工作量高一个数量级，而用户要的核心只是「在手机上
  用电脑上的 DSH」。
- **TWA / PWA**：最强理由几乎是零成本。放弃原因：TWA 要固定域名 + `asset links`，与快速隧道的随机域名
  不兼容；PWA 仍要用户自己在浏览器里「添加到主屏幕」，不是「一个 APK」。
- **Kotlin**：最强理由是 Android 的现状语言。放弃原因是这个 App 只有四个文件、没有协程需求，而 Java 让
  构建只需要 AGP，不必再引 Kotlin 插件（依赖面越小，构建越不容易在别人的机器上坏）。
- **让 WebView 自己渲染网关的登录页**（不自己登录）：最强理由是代码最少、不必碰密码。放弃原因：就没有
  「记住密码」了，而电脑上的 DSH 每次重启都会让用户重新输一遍。
- **OkHttp / Retrofit**：最强理由是成熟。放弃原因：只需要两个请求；用 `HttpURLConnection` 还能让
  `PocketClient` 不带任何 Android 依赖，从而能在 JVM 上拿真实 HTTP 服务器测。

## Consequences

- 手机端与电脑上看到的是同一个 DSH，实时同步；地址、密码、会话都由 App 管，网页侧只有网关那一套认证。
- 代价：明文 HTTP 是必需的（局域网网关就是 http），因此 `usesCleartextTraffic="true"` 并附了说明；公网通道
  （P3）会是 https。
- 已知边界：**只在同一 WiFi 下可用**——公网隧道是 P3；Android 8.0+。
- 未验证项（如实记录）：**没有在真机或模拟器上安装运行过**。本机 `adb devices` 为空，SDK 里也没有系统镜像。
  已验证的是：能构建、能装（APK 结构与签名合法）、逻辑有 JVM 单测。真机冒烟需要一台手机
  （`adb install -r app-release.apk`）或下载系统镜像起模拟器。

### 构建期踩到的三件事（都不在代码里，值得留档）

1. **清单重复声明扫码 Activity**：`zxing-android-embedded` 自己声明了 `CaptureActivity`（sensorLandscape +
   自带主题），再声明一次就是清单合并失败。方向锁用运行时的 `ScanOptions.setOrientationLocked(true)` 解决。
2. **Kotlin stdlib 重复类**：扫码库带 `kotlin-stdlib-jdk7/jdk8 1.6.21`，appcompat 带 `kotlin-stdlib 1.8.22`，
   同名类两边都有 → `checkDebugDuplicateClasses` 失败。用 `kotlin-bom:1.8.22` 对齐全部 Kotlin 依赖。
3. **Android 单测编译不到 JDK 内部包**：单测用的是 `android.jar`，没有 `com.sun.net.httpserver`。所以测试里
   自带了一个 40 行的 `TestHttpServer`（`ServerSocket` 手写），零依赖且能断言服务端**实际收到**了什么。

## Evidence

- **JVM 单测 16 条**（`./gradlew :app:testDebugUnitTest`）：地址规则 9 条（扫码带路径、手输 `ip:port`、
  https 隧道、IPv6 字面量往返、非法输入一律拒、私网/回环判定、局域网优先与去重）；网关客户端 7 条
  （真实 socket：200/401/403/连不上各自的语义、登录 POST 的表单编码与 `Set-Cookie` 提取、303 没有 cookie
  不算会话、401/429 文案不同）。
- **构建**：`:app:assembleDebug` 与 `:app:assembleRelease` 均成功；发布包 3.5 MiB。
- **产物验证**（`aapt2 dump badging` + `apksigner verify --print-certs`）：
  `package=com.dshdesktop.pocket`、`versionCode=1`、`versionName=1.0.0`、`sdkVersion=26`、
  `targetSdkVersion=34`、`launchable-activity=com.dshdesktop.pocket.MainActivity`、标签「DSH 口袋」、
  权限只含 INTERNET / ACCESS_NETWORK_STATE / CAMERA；APK Signature Scheme v2 验证通过，证书 DN
  `CN=DSH Pocket`。
- 签名密钥在 `android/keys/`（不入库）并备份到 `%USERPROFILE%\.dsh-desktop-keys\`；构建说明见
  [android/README.md](../../../android/README.md)。

## 与后续阶段的关系

公网隧道（P3）、移动布局与压缩保活（P4）、发版集成（P5）的计划见
[proposed: 手机访问后续阶段](../../proposed/feature/2026-10-16-phone-access-and-apk.md)。P3 落地后，本 App
只需多存一个公网地址（`PocketAddress.order` 已经会把局域网排在前面，公网地址自动成为备用）。
