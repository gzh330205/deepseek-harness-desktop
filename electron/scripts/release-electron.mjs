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
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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
const tauriConf = JSON.parse(readFileSync(join(repoRoot, 'src-tauri', 'tauri.conf.json'), 'utf8'))
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

// 3. Sign with the Tauri/minisign key. Empty password is this key's configuration, and
//    going through a shell would swallow the empty argument, so call the CLI directly.
const keyPath = resolve(repoRoot, process.env.DSH_DESKTOP_SIGNING_KEY_PATH ?? 'src-tauri/keys/dsh-desktop.key')
if (!existsSync(keyPath)) fail(`缺少签名私钥：${keyPath}`)
process.stdout.write('==> tauri signer sign\n')
execFileSync(process.execPath, [
  join(repoRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'), 'signer', 'sign', artifactPath,
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
const verified = await verifyMinisign(artifact, signature, tauriConf.plugins.updater.pubkey)
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
}
mkdirSync(outputDir, { recursive: true })
const manifestPath = join(outputDir, 'latest.json')
writeFileSync(manifestPath, `${JSON.stringify(manifestJson, null, 2)}\n`, 'utf8')
process.stdout.write(`==> latest.json 已生成：${manifestPath}\n`)

if (dryRun) {
  process.stdout.write('\n发布计划（--dry-run，未上传）：\n')
  // Mirror the real invocation: one release, three assets.
  process.stdout.write([
    `  gh release create v${version} \\`,
    `    ${artifactPath} \\`,
    `    ${signaturePath} \\`,
    `    ${manifestPath} \\`,
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
  artifactPath, signaturePath, manifestPath,
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
  '',
].join('\n'))
