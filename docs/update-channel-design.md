# 更新通道设计（D2 决议）

> 决议日期：2026-09-28
> 关联：[Tauri → Electron 迁移评估](tauri-to-electron-migration.md) · [P0 技术验证记录](electron-p0-verification.md)
> 本文的每条结论都有本机可复核的证据；证据来源分两类：本仓库/依赖源码（可 grep），以及本机实际执行的签名往返（脚本可重跑）。

## 1. 决议

**D2 = 自建更新通道：继续用现有 minisign 密钥对 + `latest.json`，不采购代码签名证书，不把完整性交给 electron-updater 的验签。**

| 项 | 决议 |
|---|---|
| 信任根 | 沿用 `src-tauri/keys/dsh-desktop.key` 与 `tauri.conf.json` 里的公钥（minisign / Ed25519） |
| 清单 | **一份 `latest.json`**，同时服务 Tauri 老客户端与 Electron 新客户端 |
| 传输 | Electron 侧 P3 先做全量下载（带进度）；差分（blockmap）作为 P4 优化，**且差分后仍必须过 minisign** |
| 安装 | NSIS 静默安装，参数 `/S --updated`（electron-builder 语义） |
| 老用户迁移 | 用**同一把私钥**给 electron-builder 的 NSIS 产物签名，写进老 `latest.json`；通过自定义 NSIS 宏把 Tauri 的 `/UPDATE` 翻译成静默安装，并顺手卸掉旧版 |
| 代码签名证书 | 不采购。若将来采购，只作为**额外**一层（`publisherName` 真验签），不替代 minisign |

## 2. 为什么不能依赖 electron-updater 的验签

`electron-updater@6.8.9` 的 `NsisUpdater.verifySignature()`（`out/NsisUpdater.js:84`）：

```js
async verifySignature(tempUpdateFile) {
    let publisherName;
    try {
        publisherName = (await this.configOnDisk.value).publisherName;
        if (publisherName == null) {
            return null;          // ← 直接放行，不验签
        }
    } catch (e) { if (e.code === "ENOENT") return null; throw e }
    return await this._verifyUpdateCodeSignature([publisherName], tempUpdateFile);
}
```

调用处（同文件 `:52`）：只有返回非 `null` 才抛 `ERR_UPDATER_INVALID_SIGNATURE`。

结论：**`app-update.yml` 里没有 `publisherName` 时，electron-updater 对整个下载链路不做任何完整性校验。** 而没有代码签名证书时 electron-builder 就不会写入该字段（官方 `electron-builder-config.mjs` 正是 `publisherName: windowsSigner === undefined ? undefined : …`）。所以「用 electron-updater 就够了」是错的：它会把一个未验签的安装包静默装上。

## 3. 信任根与签名格式（已实测）

Tauri 的 `.sig` / `latest.json.signature` 与公钥字段都是 **base64 包裹的 minisign 文本**。本仓库实测：

| 项 | 实测值 |
|---|---|
| 公钥文件首行 | `untrusted comment: minisign public key: 8B9998BC1C52422` |
| 公钥 blob | 42 字节，算法标识 `Ed`，keyId **`2224c5c18b99b908`** |
| 签名 blob | 74 字节，算法标识 **`ED`**（Ed25519 预哈希 BLAKE2b-512），keyId 与公钥一致 |
| `.sig` 文件 | **单行** base64（396–424 字符），可安全嵌入 JSON 字符串 |
| 私钥口令 | 空（`tauri signer sign` 以 `-p ""` 成功签名） |

因此校验算法是确定的：`Ed25519_verify(BLAKE2b512(fileBytes), sigBlock[10..74], pubkeyBlock[10..42])`。

**已实现并验证**：`electron/src/minisign.ts` + `electron/src/minisign.test.ts`（5 项测试，含篡改拒绝、异钥 keyId 拒绝、畸形输入不抛异常），以及跨真实尺寸产物的往返脚本：

```bash
cd electron && node scripts/minisign-roundtrip.mjs 8
# → artifact 8 MiB / 8388608 bytes，签名 424 字符、单行
# → verifyGenuine: { ok: true }
# → verifyTampered: { ok: false, reason: "签名校验失败：内容与签名不匹配" }
# → 退出码 0
```

这条往返证明了桥接的核心：**给任意产物（包括 electron-builder 打出的 NSIS）签名，并用仓库里已发布的公钥验证通过。**

## 4. Electron 侧更新流程（P3 实现规格）

1. 取清单：`https://github.com/gzh330205/deepseek-harness-desktop/releases/latest/download/latest.json`
2. 比较 `version` 与 `app.getVersion()`（semver，**只接受更高版本**；预发布排序沿用 `electron/src/gates.ts:compareVersions` 的规则）。
3. 静默检查（启动后延迟 + 十进制的抖动退避，失败指数退避到 1 小时上限，成功后重置）。检查期间不弹窗。
4. 用户确认后下载到 `app.getPath('userData')/updates/`，UI 显示百分比；支持取消与重试。
5. **下载完成先校验**：用内置公钥（与 `tauri.conf.json` 同一把）对**落盘文件字节**做 minisign 校验。
   - 失败：删除文件、报错并停止，**绝不安装**。
   - 成功：进入下一步。
6. 安装前交接：等待正在运行的任务收尾（P2 的 `dsh-desktop-shell` 任务查询），然后 `spawn(installer, ['/S', '--updated'])`，随即退出应用。
7. 安装器结束页拉起新版本（见 5.4 的自定义宏，桥接场景也同样拉起）。

> 差分（P4）：若接入 `electron-updater` 的 `downloadUpdate()` 做 blockmap 差分，**只允许它担任传输**；步骤 5 的 minisign 校验不可省略，且校验对象是它交给我们的 pending 安装包文件。校验不过就回退到第 4 步的全量下载。

## 5. 桥接：老 Tauri 用户自动迁移到 Electron 版

### 5.1 Tauri 客户端会怎么执行我们的安装包（源码证据）

`tauri-plugin-updater@2.10.1`：

- `src/config.rs:36`：`installMode: passive` → **`["/P", "/R"]`**（本仓库 `tauri.conf.json` 设的就是 `passive`）
- `src/updater.rs:799`：NSIS 分支拼出 `install_mode.nsis_args() + "/UPDATE" + "/ARGS" + <转义后的当前 exe 参数>`
- `src/updater.rs:855`：`ShellExecuteW("open", installer, parameters, …, SW_SHOW)` 之后**立即 `std::process::exit(0)`**

即：老客户端下载并验签我们的 NSIS 后，会以

```
DSH Desktop_0.3.0_x64-setup.exe /P /R /UPDATE /ARGS "C:\...\dsh-desktop.exe"
```

启动它并**自己退出**——它不等待安装器，也不负责把应用拉回来。

### 5.2 electron-builder 的安装器认哪些参数（源码证据）

`app-builder-lib@26.15.3/templates/nsis`：

| 参数 | 处理 |
|---|---|
| `/S` | NSIS 核心静默（模板内多处 `${if} ${Silent}`） |
| `/allusers`、`/currentuser` | `assistedInstaller.nsh:123,129` 用 `${GetOptions}` 解析 |
| `--updated` | electron-builder 自己的「这是更新」信号：`assistedInstaller.nsh:53`、`common.nsh:126`、`installUtil.nsh:206` 都靠它决定保留用户数据、装完用 `--updated` 拉起应用 |
| `/P`、`/R`、`/UPDATE`、`/ARGS` | **完全没有处理**，被忽略 |

所以直接桥接的默认后果是：**安装器会显示完整界面**（因为不认 `/P`），用户得点几下；装完结束页会拉起新应用（`installSection.nsh:93` 的 `RUN_AFTER_FINISH` 与 `common.nsh:131` 的 `ExecShellAsUser … $startAppArgs`）。

### 5.3 让它变成无感迁移：翻译参数

模板提供官方挂钩点（`installer.nsi:79` 与 `installSection.nsh:81`）：

```
!ifmacrodef customInit      → !insertmacro customInit      （.onInit 内，页面构建前）
!ifmacrodef customInstall   → !insertmacro customInstall   （安装阶段）
```

因此在自己的 `installer-bridge.nsh` 里：

```nsis
!macro customInit
  ${GetParameters} $R0
  ${GetOptions} $R0 "/UPDATE" $R1        ; Tauri 的更新信号
  ${IfNot} ${Errors}
    SetSilent silent                     ; 无界面安装
  ${EndIf}
!macroend

; Tauri 的 updater 已经 exit(0)，所以必须有东西把应用拉回来。electron-builder 只在
; `${isForceRun} ${andIf} ${Silent}` 时自启（installSection.nsh:106），而 Tauri 既不传
; --force-run 也不传 --updated。customInstall 运行时文件、注册项与快捷方式都已就绪
; （installSection.nsh:66-69），因此在这里直接拉起是安全的。
!macro customInstall
  ${GetParameters} $R0
  ${GetOptions} $R0 "/UPDATE" $R1
  ${IfNot} ${Errors}
    ExecShell "open" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ${EndIf}
!macroend
```

> `SetSilent silent` 必须在 `.onInit` 内调用，而 `customInit` 正好挂在 `.onInit`（`installer.nsi:79`）。`FileFunc.nsh`（`${GetOptions}` 的来源）经 `multiUser.nsh` 全局可用，无需额外 include。
>
> **P3 真机实测**：漏掉 `customInstall` 这段时，静默安装以退出码 0 完成、但应用不会回来——用户看到的是「应用关了，什么都没发生」。补上后安装器 12 s 静默完成并把应用拉起。详见 [P3 验证记录](electron-p3-verification.md)。

### 5.4 旧 Tauri 版的清理放在应用侧（P3 落地时修正）

原方案是在 `customInstall` 里 `ExecWait` 调用旧版的卸载器。**落地时改掉了**：`ExecWait` 等的是另一个产品的卸载器，NSIS 没有超时，那个卸载器一旦弹 UI，安装过程就永久卡住。

改由应用在首次运行时处理（`electron/src/legacy-cleanup.ts`）：

- 枚举注册表 Uninstall 的**子键名**（不是搜值数据），逐个读取 `DisplayName` / `InstallLocation` / `UninstallString`；
- 匹配 `DisplayName` 为 `DSH Desktop`（Tauri）或以 `DSH Desktop ` 开头（electron-builder 会写成 `DSH Desktop <版本>`）；
- 用**卸载器所在目录**排除自己——这条是关键：electron-builder **不往卸载键写 `InstallLocation`**，只看安装目录会让应用提议卸载它自己；而且 `UninstallString` 形如 `"…\Uninstall DSH Desktop.exe" /currentuser`，去引号必须按「第一对引号内」解析，否则路径全错（这两个坑都在真机上踩到过）；
- 弹出询问框，**只在用户同意后**才执行卸载；有 90 s 超时、返回码与日志；询问结果写标记文件，不重复打扰。

### 5.5 迁移后的状态

- 旧 Tauri 版被静默卸载（或至少不再与新版并存）；
- 新 Electron 版装在自己的目录（electron-builder 默认与 Tauri 的目录不同），用户数据 `~/.dsh` 与 `%APPDATA%` 下的壳数据沿用；
- 应用被安装器拉起。

## 6. 一个 Release 里的资产布局

| 资产 | 用途 |
|---|---|
| `DSH.Desktop_0.3.0_x64-setup.exe` | Electron 版安装包，**同时**是桥接包（同一份字节，签名一次） |
| `DSH.Desktop_0.3.0_x64-setup.exe.sig` | minisign 签名（新增，便于人工核对） |
| `latest.json` | **唯一清单**：老 Tauri 客户端与 Electron 客户端都读它 |
| `DSH.Desktop_0.3.0_x64-setup.exe.blockmap` | 仅当 P4 启用差分时才有（electron-builder 默认产出） |
| `latest.yml` | 仅当 P4 接入 electron-updater 时才有；**它不是真相源**，版本必须与 `latest.json` 一致，发布脚本要断言二者相同 |

`latest.json` 沿用现有格式，新增内容只追加：

```json
{
  "version": "0.3.0",
  "notes": "https://github.com/gzh330205/deepseek-harness-desktop/releases/tag/v0.3.0",
  "pub_date": "2026-09-28T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<minisign 单行 base64>",
      "url": "https://github.com/.../releases/download/v0.3.0/DSH.Desktop_0.3.0_x64-setup.exe"
    }
  },
  "shell": { "minimum": "0.3.0", "channel": "stable" }
}
```

- `platforms.windows-x86_64` 保持 Tauri 已解析的字段名与含义；
- 新增顶层键（如 `shell`）供 Electron 侧使用。**Tauri 的 serde 默认忽略未知字段**（需在 P3 用一次真实老客户端验证，见第 8 节）；
- 资产名里的空格会被 GitHub 规范化成点号，`url` 必须用规范化后的名字（现有脚本已处理）。

## 7. 版本与通道策略

- Electron 首个版本定 **0.3.0**（当前 Tauri 已发布到 0.2.x，0.3.0 更高，老客户端才会接受）。
- 通道：沿用「GitHub Release 即稳定通道」，不引入 electron-updater 的 channel 概念；若将来要 beta，用 GitHub 的 prerelease 标记——`releases/latest` 会自动跳过 prerelease，正好当灰度开关。
- 回滚：客户端只接受更高版本，所以**不能靠改清单降级**。出问题只能发一个更高的修复版本（与现状一致）。
- 发布脚本：`scripts/release.sh` 拆成两条路径共用一段收尾（签名 → 生成 latest.json → `gh release create`），Tauri 版继续可用，Electron 版新增 `scripts/release-electron.mjs`。

## 8. 已验证 / 待验证

**已在本机验证（可复核）**

| 项 | 证据 |
|---|---|
| `.sig` 可安全嵌入 JSON（单行） | `minisign-roundtrip.mjs` 输出 `signatureIsSingleLine: true` |
| 现有私钥可用于给任意产物签名（口令为空） | 同上，8 MiB 随机产物签名成功 |
| 用仓库已发布公钥可验证该签名 | `verifyGenuine: { ok: true }` |
| 篡改一个字节被拒 | `verifyTampered` 返回不匹配 |
| 校验器对畸形输入不抛异常 | `minisign.test.ts` 5/5 通过 |
| electron-updater 无 `publisherName` 时跳过验签 | 依赖源码 `NsisUpdater.js:84-99` |
| Tauri 客户端的安装参数与 `exit(0)` 行为 | `tauri-plugin-updater` 源码 `config.rs:36`、`updater.rs:799,855` |
| electron-builder 只认 `/S`、`--updated`、用户范围开关 | `templates/nsis` 源码 |
| 自定义 `.nsh` 挂钩点存在 | `installer.nsi:79`、`installSection.nsh:81` |

**待验证（P3 落地时，需要一次真实发布 / 一次真机安装）**

> P3 已完成的本地验证（打包产物端到端冒烟、真实产物签名与自校验、发布脚本 dry-run）见 [P3 验证记录](electron-p3-verification.md)。下面只剩必须产生对外副作用的项。

1. ~~electron-builder 真实 NSIS 产物上签名~~ —— **已完成**（97.6 MiB 真实产物，签名 + 自校验通过）；仍待做的是让**真实老 Tauri 客户端**下载并验签；
2. 老客户端以 `/P /R /UPDATE /ARGS` 启动该安装器时的真实行为（静默宏是否生效、是否被 UAC 拦、装完是否拉起应用）；
3. `customInstall` 里卸载旧 Tauri 版的 `ExecWait` 是否干净（注册项、目录、快捷方式）；
4. Tauri 的 serde 是否真的忽略 `latest.json` 的新顶层键；
5. `latest.json` 与 `latest.yml`（若启用）版本一致性断言；
6. Windows SmartScreen 对未签名安装包的拦截情况（无证书的代价，需实测确认提示文案与绕行路径）。

## 9. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 无代码签名证书 | SmartScreen 警告、企业策略可能拦截 | 已知代价；文档给出手动放行路径；将来可加证书做**额外**验签 |
| 桥接安装器显示界面（若静默宏失效） | 老用户看到一次安装向导 | `customInit` 翻译 `/UPDATE`；即使失效也只是「多几次点击」，不是失败 |
| 两套卸载注册项并存 | 用户看到两个「DSH Desktop」 | 不改 NSIS（`ExecWait` 无超时会卡住安装），改由应用首次运行时询问并卸载旧版；发布前用手工安装实测 |
| 全量下载体积（P3 无差分） | 每次更新下 ~100 MB | 先用 `electronLanguages`/压缩把包做小；P4 接 blockmap 差分 |
| `latest.json` 与 `latest.yml` 漂移 | 两代客户端看到不同版本 | 发布脚本断言一致；P4 之前干脆不产出 `latest.yml` |
| 清单被 GitHub 缓存 | 更新延迟 | `releases/latest/download/` 是 302 重定向且不缓存清单（现状已如此） |
