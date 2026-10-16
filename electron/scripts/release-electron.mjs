#!/usr/bin/env node
/**
 * Electron-shell release: build → sign with the existing minisign key → verify the
 * signature ourselves → write `latest.json` → publish.
 *
 * The same NSIS bytes serve two audiences:
 * - existing Electron installs, which read `latest.json` and verify with minisign;
 * - existing Tauri installs, whose updater reads the same manifest, verifies the same
 *   signature, and then runs the installer with `/P /R /UPDATE /ARGS` (which
 *   `scripts/installer-bridge.nsh` translates into a silent install).
 *
 * Safety rails:
 * - `--dry-run` builds, signs and writes the manifest, but publishes nothing;
 * - a non-prerelease publish requires `--yes`, because it makes every installed Tauri
 *   client migrate on its next check, and a published version can never be reused.
 *
 * Usage:
 *   node scripts/release-electron.mjs 0.3.0 --notes "..." --dry-run
 *   node scripts/release-electron.mjs 0.3.0 --notes "..." --prerelease
 *   node scripts/release-electron.mjs 0.3.0 --notes "..." --yes
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { delimiter as pathDelimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { verifyMinisign } from '../src/minisign.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(root, '..')
const REPO = 'gzh330205/deepseek-harness-desktop'

const args = process.argv.slice(2)
const version = args.find(argument => !argument.startsWith('--') && /^\d+\.\d+\.\d+/u.test(argument))
const dryRun = args.includes('--dry-run')
const prerelease = args.includes('--prerelease')
const confirmed = args.includes('--yes')
const skipBuild = args.includes('--skip-build')
const skipSmoke = args.includes('--skip-smoke')
const notesIndex = args.indexOf('--notes')
const notes = notesIndex >= 0 ? args[notesIndex + 1] : undefined

function fail(message) {
  process.stderr.write(`错误：${message}\n`)
  process.exit(1)
}

/**
 * Environment for electron-builder, with DSH Desktop's own runtime kept out of `PATH`.
 *
 * The app prepends its runtime `bin` to the `PATH` of the dsh process it spawns
 * (`host-process.ts`) so that dsh can find the bundled pnpm. Any build started from inside the app —
 * an agent session, a terminal opened by it — inherits that, and electron-builder probes `pnpm` to
 * collect the dependency tree. Resolving the app's runtime shim there is wrong twice over: it is not
 * the project's toolchain, and in a packaged install its pnpm lives inside `app.asar`, which made the
 * whole build die with `Cannot find module …app.asar.unpacked\…\pnpm.cjs`.
 *
 * @returns A copy of the environment without any DSH Desktop install in `PATH`.
 */
function builderEnvironment() {
  const key = Object.keys(process.env).find(name => name.toUpperCase() === 'PATH') ?? 'PATH'
  const current = process.env[key] ?? ''
  const kept = current.split(pathDelimiter).filter(entry => entry !== '' && !/DSH Desktop/iu.test(entry))
  return { ...process.env, [key]: kept.join(pathDelimiter) }
}

if (version === undefined) fail('用法：release-electron.mjs <version> --notes "…" [--dry-run|--prerelease|--yes]')
if (notes === undefined || notes.trim() === '') {
  fail('必须提供 --notes：每次发布都要有用户可见的改动说明（禁止空说明发布）')
}
if (!dryRun && !prerelease && !confirmed) {
  fail('非预发布发布会立刻让所有已安装的 Tauri 客户端在下次检查时迁移到 Electron 版，且版本号不可复用。确认无误请追加 --yes')
}

// 1. Version consistency: package.json is the single source for the Electron shell.
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (manifest.version !== version) {
  fail(`electron/package.json version = ${manifest.version}，与传入的 ${version} 不一致`)
}

// The Tauri shell must not be publishing the same version.
const tauriConf = JSON.parse(readFileSync(join(repoRoot, 'electron', 'update-key.json'), 'utf8'))
if (tauriConf.version === version) {
  process.stdout.write(`提示：Tauri 壳当前版本也是 ${version}；两者的 Release 资产会落在同一个 tag 上。\n`)
}

const outputDir = join(root, 'release')
const artifactName = `DSH.Desktop_${version}_x64-setup.exe`
const artifactPath = join(outputDir, artifactName)

// The bundled runtime must have been rebuilt for this version. Its manifest records the
// shell version it was produced for, and a stale tree would otherwise ship silently: the
// file count and hashes would still verify, they would just describe the previous build.
const runtimeManifestPath = join(root, 'runtime', 'dsh', 'desktop-runtime.json')
if (!existsSync(runtimeManifestPath)) {
  fail('缺少随包运行时清单，先运行 pnpm runtime:prepare')
}
const runtimeManifest = JSON.parse(readFileSync(runtimeManifestPath, 'utf8'))
if (runtimeManifest.shell !== version) {
  fail(`随包运行时是为 ${String(runtimeManifest.shell)} 构建的，与要发布的 ${version} 不一致：先运行 pnpm runtime:prepare`)
}

// The tunnel binary is part of what the user gets: a missing or stale one ships a feature that
// cannot start, and the installer is the last place to find that out.
const cloudflaredPin = JSON.parse(readFileSync(join(root, 'cloudflared-pin.json'), 'utf8'))
const cloudflaredArtifact = cloudflaredPin.artifacts?.['win32-x64']
const cloudflaredPath = join(root, 'resources', 'cloudflared', 'cloudflared.exe')
if (!existsSync(cloudflaredPath)) {
  fail('缺少随包 cloudflared：先运行 `pnpm cloudflared:prepare`')
}
if (cloudflaredArtifact !== undefined) {
  const digest = createHash('sha256').update(readFileSync(cloudflaredPath)).digest('hex')
  if (digest !== cloudflaredArtifact.sha256) {
    fail(`随包 cloudflared 与 pin 不一致（pin ${String(cloudflaredPin.version)}）：实际 ${digest}`)
  }
  process.stdout.write(`==> 随包 cloudflared ${String(cloudflaredPin.version)} 哈希与 pin 一致\n`)
}

// 2. Build.
if (skipBuild) {
  if (!existsSync(artifactPath)) fail(`--skip-build 但找不到产物：${artifactPath}`)
} else {
  process.stdout.write('==> electron-builder --win nsis\n')
  execFileSync(process.execPath, [
    join(root, 'node_modules', 'electron-builder', 'cli.js'),
    '--win', 'nsis', '--publish', 'never', '--config', 'electron-builder.config.mjs',
  ], { cwd: root, stdio: 'inherit', env: builderEnvironment() })
}

if (!existsSync(artifactPath)) {
  fail(`打包后仍找不到产物：${artifactPath}（检查 electron-builder.config.mjs 的 artifactName）`)
}
const artifact = readFileSync(artifactPath)
process.stdout.write(`==> 产物 ${artifactName}：${(statSync(artifactPath).size / 1024 / 1024).toFixed(1)} MiB\n`)

// 2b. Verify what is about to be signed: the packaged runtime's file count, every critical
// hash, and that no foreign-platform file reached the integrity set. Signing an installer
// whose payload is subtly wrong is worse than not publishing at all.
process.stdout.write('==> 校验打包载荷\n')
execFileSync(process.execPath, [
  join(root, 'scripts', 'verify-package.mjs'), '--dir', join(outputDir, 'win-unpacked'),
], { cwd: root, stdio: 'inherit' })

// 2c. The Android client is part of what this release delivers, so it is built and inspected here
// rather than by hand: an unsigned or mis-versioned APK must fail the release, not reach the phone.
const apkName = 'DSH.Pocket.apk'
const apkPath = join(outputDir, apkName)

/** The Android SDK, resolved the way the Gradle build itself resolves it. */
function androidSdkRoot() {
  const fromEnv = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT
  if (fromEnv !== undefined && existsSync(fromEnv)) return fromEnv
  const local = join(repoRoot, 'android', 'local.properties')
  if (existsSync(local)) {
    const line = readFileSync(local, 'utf8').split('\n').find(entry => entry.startsWith('sdk.dir='))
    if (line !== undefined) {
      const value = line.slice('sdk.dir='.length).trim()
      if (existsSync(value)) return value
    }
  }
  fail('找不到 Android SDK：设置 ANDROID_HOME，或在 android/local.properties 写 sdk.dir')
}

/** The newest build-tools directory; the APK tools live there. */
function buildToolsDir() {
  const root = join(androidSdkRoot(), 'build-tools')
  if (!existsSync(root)) fail(`Android SDK 里没有 build-tools：${root}`)
  const versions = readdirSync(root)
    .filter(entry => /^\d/u.test(entry))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const newest = versions.at(-1)
  if (newest === undefined) fail(`Android SDK 的 build-tools 是空的：${root}`)
  return join(root, newest)
}

const apkSource = join(repoRoot, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
if (!skipBuild) {
  process.stdout.write('==> gradlew :app:assembleRelease（Android 客户端）\n')
  const androidDir = join(repoRoot, 'android')
  // `gradlew.bat` is a batch file, and Node cannot spawn one directly on Windows (ENOENT/EINVAL):
  // it has to go through the command interpreter. Arguments are fixed literals, never user input.
  const gradle = process.platform === 'win32'
    ? [process.env.ComSpec ?? 'cmd.exe', ['/c', join(androidDir, 'gradlew.bat'), ':app:assembleRelease', '--console=plain']]
    : [join(androidDir, 'gradlew'), [':app:assembleRelease', '--console=plain']]
  execFileSync(gradle[0], gradle[1], { cwd: androidDir, stdio: 'inherit' })
}
if (!existsSync(apkSource)) {
  fail(`找不到 Android 客户端产物：${apkSource}（先运行 android 下的 gradlew :app:assembleRelease）`)
}

const tools = buildToolsDir()
const aapt = join(tools, process.platform === 'win32' ? 'aapt2.exe' : 'aapt2')
const apksigner = join(tools, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner')

/**
 * Run one of the Android SDK's tools.
 *
 * `apksigner` is a batch file on Windows, and Node cannot spawn those directly (EINVAL): the command
 * interpreter has to do it. Arguments here are fixed literals — no user input reaches this call.
 *
 * @param tool - Absolute path of the tool.
 * @param args - Arguments to pass.
 * @returns The tool's stdout.
 */
function runTool(tool, args) {
  const batch = /\.(?:bat|cmd)$/iu.test(tool)
  const file = batch ? process.env.ComSpec ?? 'cmd.exe' : tool
  const full = batch ? ['/c', tool, ...args] : args
  return execFileSync(file, full, { encoding: 'utf8', windowsHide: true })
}
// `aapt2 dump badging` prints human-readable lines; reading the package identity out of them is how
// the release proves the APK matches what android/app/build.gradle declares.
const badging = runTool(aapt, ['dump', 'badging', apkSource])
const apkVersion = /versionName='([^']+)'/u.exec(badging)?.[1]
const apkVersionCode = /versionCode='(\d+)'/u.exec(badging)?.[1]
const apkPackage = /package: name='([^']+)'/u.exec(badging)?.[1]
// build-tools 36 renamed this line from `sdkVersion:` to `minSdkVersion:`, so accept both rather than
// depending on which build-tools a machine happens to have.
const apkMinSdk = /(?:minSdkVersion|sdkVersion):'(\d+)'/u.exec(badging)?.[1]
const apkTargetSdk = /targetSdkVersion:'(\d+)'/u.exec(badging)?.[1]
if (apkPackage === undefined || apkVersion === undefined || apkVersionCode === undefined
  || apkMinSdk === undefined || apkTargetSdk === undefined) {
  // These four numbers describe which phones can install this at all, so they are not optional.
  fail('APK 元数据读不出来（包名/版本/minSdk/targetSdk），产物可能损坏')
}
process.stdout.write('==> apksigner verify（手机客户端必须已签名）\n')
const signatureReport = runTool(apksigner, ['verify', '--verbose', '--print-certs', apkSource])
if (!/Verified using v2 scheme/u.test(signatureReport)) {
  fail('APK 没有通过 v2 签名校验：拒绝发布未签名的手机客户端')
}
const signerLine = /Signer #1 certificate DN: (.+)/u.exec(signatureReport)?.[1]?.trim() ?? '(未知)'
// A stable asset name: `releases/latest/download/DSH.Pocket.apk` then always serves the newest client,
// which is what the settings page turns into a QR code that never has to be regenerated.
copyFileSync(apkSource, apkPath)
const apkBytes = readFileSync(apkPath)
const apkSha256 = createHash('sha256').update(apkBytes).digest('hex')
process.stdout.write(`==> ${apkName}：${(apkBytes.length / 1024 / 1024).toFixed(1)} MiB，包名 ${apkPackage}，`
  + `版本 ${apkVersion}(${apkVersionCode})，minSdk ${String(apkMinSdk)}，targetSdk ${String(apkTargetSdk)}，`
  + `签名者 ${signerLine}\n`)
process.stdout.write(`    sha256 ${apkSha256}\n`)

// 2d. The smokes are release gates, not decoration: they boot the packaged shell and the gateway and
// talk to them over real sockets. This is the last moment to catch a broken build before it is public
// — and before every installed copy starts updating itself to it.
if (!skipSmoke) {
  process.stdout.write('==> smoke：打包版壳\n')
  try {
    execFileSync(process.execPath, [join(root, 'scripts', 'smoke.mjs'), 'cookie', '--packaged'],
      { cwd: root, stdio: 'inherit' })
  } catch {
    fail('打包版 smoke 失败：拒绝发布（--skip-smoke 可跳过，但请先弄清原因）')
  }
  process.stdout.write('==> smoke：手机访问网关\n')
  try {
    execFileSync(process.execPath, [join(root, 'scripts', 'smoke-pocket.mjs')], { cwd: root, stdio: 'inherit' })
  } catch {
    fail('网关 smoke 失败：拒绝发布（--skip-smoke 可跳过，但请先弄清原因）')
  }
} else {
  process.stdout.write('==> 已跳过 smoke（--skip-smoke）\n')
}

// 3. Sign with the Tauri/minisign key. Empty password is this key's configuration, and
//    going through a shell would swallow the empty argument, so call the CLI directly.
const keyPath = resolve(repoRoot, process.env.DSH_DESKTOP_SIGNING_KEY_PATH ?? 'electron/keys/dsh-desktop.key')
if (!existsSync(keyPath)) fail(`缺少签名私钥：${keyPath}`)
process.stdout.write('==> tauri signer sign\n')
execFileSync(process.execPath, [
  join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'), 'signer', 'sign', artifactPath,
], {
  cwd: repoRoot,
  stdio: ['ignore', 'ignore', 'inherit'],
  env: {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyPath, 'utf8'),
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '',
  },
})

const signaturePath = `${artifactPath}.sig`
if (!existsSync(signaturePath)) fail(`缺少签名文件：${signaturePath}`)
const signature = readFileSync(signaturePath, 'utf8').trim()

// 4. Verify what we are about to publish, with the public key that ships in the app.
const verified = await verifyMinisign(artifact, signature, tauriConf.pubkey)
if (verified.ok !== true) fail(`自校验失败，拒绝发布：${verified.reason}`)
process.stdout.write('==> 签名自校验通过\n')

// 5. Manifest. Single source of truth for both client generations; new keys stay additive.
const manifestJson = {
  version,
  notes: `https://github.com/${REPO}/releases/tag/v${version}`,
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z'),
  platforms: {
    'windows-x86_64': {
      signature,
      url: `https://github.com/${REPO}/releases/download/v${version}/${artifactName}`,
    },
  },
  shell: { minimum: '0.3.0', channel: prerelease ? 'prerelease' : 'stable' },
  // The phone client travels in the same release but updates on its own schedule. The field is
  // additive on purpose: `fetchManifest` reads the keys it knows and ignores the rest, so older
  // clients keep updating exactly as before.
  apk: {
    package: apkPackage,
    version: apkVersion,
    versionCode: Number(apkVersionCode),
    minSdk: Number(apkMinSdk),
    targetSdk: Number(apkTargetSdk),
    // A stable asset name, so `releases/latest/download/DSH.Pocket.apk` is a permanent link that
    // always serves the newest client — that is what the settings page turns into a QR code.
    url: `https://github.com/${REPO}/releases/latest/download/${apkName}`,
    sha256: apkSha256,
  },
}
mkdirSync(outputDir, { recursive: true })
const manifestPath = join(outputDir, 'latest.json')
writeFileSync(manifestPath, `${JSON.stringify(manifestJson, null, 2)}\n`, 'utf8')
process.stdout.write(`==> latest.json 已生成：${manifestPath}\n`)

if (dryRun) {
  process.stdout.write('\n发布计划（--dry-run，未上传）：\n')
  // Mirror the real invocation: one release, four assets.
  process.stdout.write([
    `  gh release create v${version} \\`,
    `    ${artifactPath} \\`,
    `    ${signaturePath} \\`,
    `    ${manifestPath} \\`,
    `    ${apkPath} \\`,
    `    --repo ${REPO} --title v${version}${prerelease ? ' --prerelease' : ''} --notes "…"`,
    '',
  ].join('\n'))
  process.stdout.write(`\n清单：\n${JSON.stringify(manifestJson, null, 2)}\n`)
  process.exit(0)
}

// 6. Publish. The installer, its signature, and the manifest travel together.
//
// `gh` is invoked without a shell on purpose: a shell would expand the `*` in
// `--notes` as a glob and mangle the release notes.
function resolveGh() {
  const candidates = [
    'gh',
    'C:\\Program Files\\GitHub CLI\\gh.exe',
    'D:\\Program Files\\GitHub CLI\\gh.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', 'gh.exe'),
    join(process.env.USERPROFILE ?? '', 'AppData', 'Local', 'Programs', 'GitHub CLI', 'gh.exe'),
  ]
  for (const candidate of candidates) {
    if (candidate === 'gh') continue
    if (existsSync(candidate)) return candidate
  }
  return 'gh'
}

process.stdout.write('==> gh release create\n')
execFileSync(resolveGh(), [
  'release', 'create', `v${version}`,
  artifactPath, signaturePath, manifestPath, apkPath,
  '--repo', REPO,
  '--title', `v${version}`,
  '--notes', notes,
  ...prerelease ? ['--prerelease'] : [],
], { stdio: 'inherit' })

process.stdout.write([
  '',
  `✅ Release v${version} 发布完成`,
  `   ${prerelease ? '（预发布：releases/latest 不会指向它，已安装的 Tauri 客户端不受影响）' : '（正式发布：已安装的 Tauri 客户端会在下次检查时迁移到 Electron 版）'}`,
  `   下载页: https://github.com/${REPO}/releases/tag/v${version}`,
  `   清单:   https://github.com/${REPO}/releases/latest/download/latest.json`,
  `   手机端: https://github.com/${REPO}/releases/latest/download/${apkName}`,
  '',
].join('\n'))
