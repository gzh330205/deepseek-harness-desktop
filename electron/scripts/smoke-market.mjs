#!/usr/bin/env node
/**
 * Smoke: does the market window actually come up?
 *
 * The unit tests prove the catalog and the install path; `verify-package` proves the page, the bridge
 * and the channels are inside the archive. Neither proves that clicking the menu item yields a window
 * with a rendered page — for that the app has to run. This boots the packaged shell with
 * `DSH_DESKTOP_OPEN_MARKET=1` (a verification hook in `main.ts`), waits for the two lines the window
 * writes to `shell.log` (`market window ready`, `market page loaded`) and fails on a load error or a
 * timeout. Nothing here needs the DSH service: that is the point of the market being a shell surface.
 *
 * Usage: node scripts/smoke-market.mjs [--exe <path>] [--timeout <seconds>]
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const exeIndex = args.indexOf('--exe')
const timeoutIndex = args.indexOf('--timeout')
const executable = exeIndex >= 0 && args[exeIndex + 1] !== undefined
  ? resolve(args[exeIndex + 1])
  : join(root, 'release', 'win-unpacked', 'DSH Desktop.exe')
const timeoutSeconds = timeoutIndex >= 0 && args[timeoutIndex + 1] !== undefined ? Number(args[timeoutIndex + 1]) : 90

if (!existsSync(executable)) {
  process.stderr.write(`smoke-market: 找不到可执行文件 ${executable}（先运行 pnpm package:dir，或用 --exe 指定）\n`)
  process.exit(1)
}

const userData = mkdtempSync(join(tmpdir(), 'dsh-market-smoke-'))
const log = join(userData, 'shell.log')
const fail = message => {
  process.stdout.write(`${JSON.stringify({ ok: false, reason: message, log })}\n`)
  process.exit(1)
}

const child = spawn(executable, [], {
  cwd: root,
  env: {
    ...process.env,
    DSH_DESKTOP_USER_DATA_DIR: userData,
    DSH_DESKTOP_DSH_HOME: join(userData, 'dsh-home'),
    DSH_DESKTOP_PORT: process.env.DSH_DESKTOP_MARKET_SMOKE_PORT ?? '41736',
    DSH_DESKTOP_OPEN_MARKET: '1',
  },
  stdio: 'ignore',
  windowsHide: true,
})
child.on('error', error => { fail(`启动失败：${error.message}`) })

const stop = () => {
  if (child.exitCode === null) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
}

const deadline = Date.now() + timeoutSeconds * 1000
const wanted = ['market window ready', 'market page loaded', 'market runtime ok', 'market catalog ok']
let seen = []
while (Date.now() < deadline) {
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1000))
  if (!existsSync(log)) continue
  const text = readFileSync(log, 'utf8')
  if (/market page failed to load/u.test(text)) {
    stop()
    fail(`市场页面加载失败：${text.split(/\r?\n/u).find(line => line.includes('market page failed to load')) ?? ''}`)
  }
  if (/market runtime failed/u.test(text)) {
    stop()
    fail(`市场运行时不能启动（打包态安装会 ENOENT）：${text.split(/\r?\n/u).find(line => line.includes('market runtime failed')) ?? ''}`)
  }
  if (/market catalog failed/u.test(text)) {
    stop()
    fail(`社区目录加载失败（首屏会没有列表）：${text.split(/\r?\n/u).find(line => line.includes('market catalog failed')) ?? ''}`)
  }
  seen = wanted.filter(marker => text.includes(marker))
  if (seen.length === wanted.length) break
}

stop()
if (seen.length !== wanted.length) fail(`等待超时（${String(timeoutSeconds)}s），只看到：${seen.join(', ') || '无'}`)
process.stdout.write(`${JSON.stringify({ ok: true, markers: seen, log })}\n`)
process.exit(0)
