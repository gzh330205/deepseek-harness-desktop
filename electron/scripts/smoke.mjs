#!/usr/bin/env node
/**
 * Smoke runner for the P0 shell.
 *
 * Boots the real Electron shell in smoke mode against an isolated userData directory
 * and a spare port, then reports the single `SMOKE_RESULT` line the main process
 * prints. The shell exits on its own; this wrapper only relays the verdict.
 *
 * Usage: node scripts/smoke.mjs [cookie|token|proxy] [--isolate-home] [--packaged]
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const loadMode = args.find(argument => !argument.startsWith('--')) ?? process.env.DSH_DESKTOP_LOAD_MODE ?? 'cookie'
const isolateHome = args.includes('--isolate-home')
const packaged = args.includes('--packaged')
// --exe <path> targets another build (e.g. an installed copy) with --packaged semantics.
const exeIndex = args.indexOf('--exe')
const exeOverride = exeIndex >= 0 ? args[exeIndex + 1] : undefined
const port = process.env.DSH_DESKTOP_PORT ?? '41730'
const userData = mkdtempSync(join(tmpdir(), 'dsh-desktop-smoke-'))
const dshHome = isolateHome ? join(userData, 'dsh-home') : undefined

// A packaged build is launched without a script argument and reports through
// `<userData>/smoke-result.json`, because a GUI binary may have no console.
const packagedExecutable = exeOverride === undefined ? join(root, 'release', 'win-unpacked', 'DSH Desktop.exe') : resolve(exeOverride)
if (packaged && !existsSync(packagedExecutable)) {
  process.stderr.write(`smoke: 找不到打包产物 ${packagedExecutable}，先运行 pnpm package:dir\n`)
  process.exit(1)
}

const child = spawn(packaged ? packagedExecutable : electronPath, packaged ? [] : [root], {
  cwd: root,
  env: {
    ...process.env,
    DSH_DESKTOP_SMOKE: '1',
    DSH_DESKTOP_LOAD_MODE: loadMode,
    DSH_DESKTOP_PORT: port,
    DSH_DESKTOP_USER_DATA_DIR: userData,
    ...dshHome === undefined ? {} : { DSH_DESKTOP_DSH_HOME: dshHome },
    // Prove the packaged app needs no system dsh: replace the child's PATH entirely.
    ...process.env.DSH_DESKTOP_SMOKE_PATH === undefined
      ? {}
      : { PATH: process.env.DSH_DESKTOP_SMOKE_PATH, Path: process.env.DSH_DESKTOP_SMOKE_PATH },
  },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})

let buffer = ''
let result
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (line.startsWith('SMOKE_RESULT ')) {
      try {
        result = JSON.parse(line.slice('SMOKE_RESULT '.length))
      } catch (error) {
        process.stderr.write(`无法解析 SMOKE_RESULT：${String(error)}\n`)
      }
      continue
    }
    if (line.trim() !== '') process.stdout.write(`  · ${line}\n`)
  }
})
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => {
  const text = String(chunk).trim()
  if (text !== '') process.stderr.write(`  ! ${text}\n`)
})

const timer = setTimeout(() => { child.kill() }, 200_000)

child.on('close', (code) => {
  clearTimeout(timer)
  // Packaged builds may have no usable stdout; the shell also writes the verdict here.
  if (result === undefined) {
    const resultFile = join(userData, 'smoke-result.json')
    if (existsSync(resultFile)) {
      try {
        result = JSON.parse(readFileSync(resultFile, 'utf8'))
      } catch (error) {
        process.stderr.write(`无法解析 ${resultFile}：${String(error)}\n`)
      }
    }
  }
  if (result === undefined) {
    rmSync(userData, { recursive: true, force: true })
    process.stderr.write(`smoke: 未收到 SMOKE_RESULT（退出码 ${String(code)}）\n`)
    process.exit(1)
  }
  const homeOk = dshHome === undefined || result.dshHome === dshHome
  process.stdout.write(`\nSMOKE ${loadMode}${isolateHome ? ' (isolated home)' : ''}${packaged ? ' [packaged]' : ''} → ${result.ok === true && homeOk ? 'PASS' : 'FAIL'}\n`)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (!homeOk) process.stderr.write(`smoke: DSH home 未生效：期望 ${String(dshHome)}，实际 ${String(result.dshHome)}\n`)
  rmSync(userData, { recursive: true, force: true })
  process.exit(result.ok === true && homeOk ? 0 : 1)
})
