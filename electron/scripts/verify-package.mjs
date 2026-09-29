#!/usr/bin/env node
/**
 * Verify a packaged app directory actually contains the runtime it claims.
 *
 * electron-builder excludes a source directory's root `node_modules`, so an
 * `extraResources` entry pointing at `runtime/dsh` copies only the manifest and still
 * exits 0 — the app then silently falls back to a system dsh. That failure was measured,
 * not imagined, so packaging ends with this check.
 *
 * Usage: node scripts/verify-package.mjs [--dir <unpackedDir>]
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isForeignPlatformPath } from './runtime-policy.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dirIndex = process.argv.indexOf('--dir')
const unpacked = dirIndex >= 0 && process.argv[dirIndex + 1] !== undefined
  ? resolve(process.argv[dirIndex + 1])
  : join(root, 'release', 'win-unpacked')
const resources = join(unpacked, 'resources')

function fail(message) {
  process.stderr.write(`打包校验失败：${message}\n`)
  process.exit(1)
}

const sourceManifestPath = join(root, 'runtime', 'dsh', 'desktop-runtime.json')
if (!existsSync(sourceManifestPath)) fail('缺少 runtime/dsh/desktop-runtime.json，先运行 prepare-runtime.mjs')
const expected = JSON.parse(readFileSync(sourceManifestPath, 'utf8'))

const packagedRuntime = join(resources, 'runtime', 'dsh')
const packagedManifestPath = join(packagedRuntime, 'desktop-runtime.json')
if (!existsSync(packagedManifestPath)) fail(`打包目录里没有随包运行时：${packagedRuntime}`)
const packaged = JSON.parse(readFileSync(packagedManifestPath, 'utf8'))
if (packaged.dsh !== expected.dsh || packaged.listDigest !== expected.listDigest) {
  fail(`随包运行时与源不一致（dsh ${String(packaged.dsh)} vs ${String(expected.dsh)}）`)
}

let files = 0
const walk = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) walk(join(directory, entry.name))
    else if (entry.isFile()) files += 1
  }
}
walk(packagedRuntime)
// The manifest itself is written after the file list was taken.
if (files !== packaged.files + 1) {
  fail(`随包运行时文件数不符：打包目录 ${String(files)} 个，清单声明 ${String(packaged.files)} + 1。检查 electron-builder 的 extraResources 是否漏了 node_modules 条目。`)
}

// A foreign binary in the integrity set is how a working install was refused once: the
// file shipped, did not survive installation, and the shell refused to start over a file
// it would never load. Fail the build instead of shipping that again.
for (const relativePath of Object.keys(packaged.critical)) {
  if (isForeignPlatformPath(relativePath, packaged.platform, packaged.arch)) {
    fail(`关键文件表里出现了其他平台/架构的文件：${relativePath}（应被 prepare-runtime 裁掉）`)
  }
}

for (const relativePath of Object.keys(packaged.critical)) {
  const path = join(packagedRuntime, relativePath)
  if (!existsSync(path)) fail(`随包运行时缺少关键文件：${relativePath}`)
  if (statSync(path).size === 0) fail(`随包运行时关键文件为空：${relativePath}`)
}
if (!existsSync(join(packagedRuntime, packaged.entry))) fail(`随包运行时缺少入口：${packaged.entry}`)

for (const required of ['dsh-desktop-shell/index.js', 'dsh-desktop-shell/client.js']) {
  if (!existsSync(join(resources, required))) fail(`缺少面板插件资源：resources/${required}`)
}
if (!existsSync(join(resources, 'app.asar'))) fail('缺少 app.asar')

process.stdout.write(
  `打包校验通过：dsh ${packaged.dsh}（Electron ${packaged.electron}）、${String(files)} 个文件、`
  + `关键文件 ${String(Object.keys(packaged.critical).length)} 个\n`,
)
