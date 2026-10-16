# DSH 口袋（Android 客户端）

手机上的 DSH 入口。它本身不实现界面：桌面壳的**手机访问网关**（见
[手机访问网关笔记](../../.agents/notes/implemented/architecture/2026-10-16-phone-gateway.md)）提供带密码的
DSH 页面，这个 App 负责浏览器做不了的那几件事——**扫码、记地址、自动选路、会话过期后自动重新登录**。

## 构建

```sh
cd android
./gradlew :app:assembleDebug          # 调试包（debug 密钥签名）
./gradlew :app:assembleRelease        # 发布包（需要 keys/keystore.properties）
./gradlew :app:testDebugUnitTest      # 地址规则与网关客户端的 JVM 单测
```

前置：JDK 17+（本机 21）、Android SDK（platform 34 + build-tools 34.0.0）。SDK 路径写在
`local.properties`（不入库）。Gradle 由 wrapper 固定为 8.7，AGP 8.5.2。

产物：`android/app/build/outputs/apk/{debug,release}/`。

## 签名密钥（很重要）

- 密钥库：`android/keys/dsh-pocket.jks`，口令与别名在 `android/keys/keystore.properties`。
- 两者都在 `.gitignore` 里，**不会进仓库**；另有备份在 `%USERPROFILE%\.dsh-desktop-keys\`。
- **丢了就再也无法给已安装的旧版本发更新**（Android 不接受换了签名的同包名安装包），和桌面安装包密钥
  同等严重。请连同口令一起备份到别处。
- 没有密钥文件时 `assembleRelease` 仍能构建，只是产物未签名——这是给没有密钥的贡献者留的路。

## 安装

```sh
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

或把 APK 传到手机上点开安装（需要允许安装未知来源）。

## 版本

`app/build.gradle` 里的 `pocketVersionName` / `pocketVersionCode` 是 **APK 自己的版本**，与桌面壳的版本号
无关（它是独立的发布资产，见 P5）。每次发布前两个都要递增。

## 怎么用

1. 电脑上：设置 → 手机访问 → 打开开关（局域网默认是关的）。
2. 手机上打开 App → 「扫描二维码」扫电脑上显示的那个码。
3. 输一次电脑上显示的访问密码。若勾了「记住密码」，电脑上的 DSH 重启后手机会自动重新登录。

## 已知边界

- 只在**同一 WiFi** 下可用（公网隧道是 P3，尚未实现）。
- 需要 Android 8.0（API 26）及以上。
- 明文 HTTP 是必需的：局域网网关就是 http。流量不出本地网络；公网通道（P3）是 https。
