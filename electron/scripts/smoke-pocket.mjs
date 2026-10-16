#!/usr/bin/env node
/**
 * Smoke: does phone access really serve DSH over the local network, behind its own password?
 *
 * The unit tests prove the proxy in isolation and the settings tests prove the document; neither
 * proves the thing the user actually does — turn the switch on, scan, type the password, use DSH.
 * This boots the real shell (dev tree by default, packaged with `--exe`) with phone access enabled
 * in an isolated userData directory, then acts like the phone:
 *
 *   1. the gateway answers at the address the shell logged,
 *   2. without a session it answers the login page, not DSH,
 *   3. a request aimed at another name (`Host: evil.example`) is refused — the rebinding defence,
 *   4. the password from `pocket.json` signs in and the next request is served by DSH itself,
 *   5. DSH still listens on loopback only: the whole point of the gateway.
 *
 * Usage: node scripts/smoke-pocket.mjs [--exe <path>] [--timeout <seconds>]
 * Exit code 0 with `{"ok":true,…}` on success, 1 with a reason otherwise.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const exeIndex = args.indexOf('--exe')
const timeoutIndex = args.indexOf('--timeout')
const timeoutSeconds = timeoutIndex >= 0 && args[timeoutIndex + 1] !== undefined ? Number(args[timeoutIndex + 1]) : 240
const executable = exeIndex >= 0 && args[exeIndex + 1] !== undefined ? resolve(args[exeIndex + 1]) : undefined

const DSH_PORT = process.env.DSH_DESKTOP_POCKET_SMOKE_DSH_PORT ?? '41734'
const POCKET_PORT = process.env.DSH_DESKTOP_POCKET_SMOKE_PORT ?? '41735'

const userData = mkdtempSync(join(tmpdir(), 'dsh-pocket-smoke-'))
const logPath = join(userData, 'shell.log')
const settingsPath = join(userData, 'shell-settings.json')
const statePath = join(userData, 'pocket.json')

const fail = (reason) => {
  stop()
  process.stdout.write(`${JSON.stringify({ ok: false, reason, log: logPath })}\n`)
  if (existsSync(logPath)) process.stderr.write(readFileSync(logPath, 'utf8').split('\n').slice(-25).join('\n'))
  process.exit(1)
}

// An agent session inside the app exports `ELECTRON_RUN_AS_NODE`, which turns any Electron binary
// into plain Node: the app would exit in a second, writing nothing. (Same trap the other smokes hit.)
const childEnvironment = { ...process.env }
delete childEnvironment.ELECTRON_RUN_AS_NODE
delete childEnvironment.ELECTRON_NO_ATTACH_CONSOLE

/** Phone access on, DSH on a spare port, in a directory nobody else touches. */
writeFileSync(settingsPath, `${JSON.stringify({
  service: { port: Number(DSH_PORT) },
  closeBehavior: 'exit',
  pocket: { enabled: true, port: Number(POCKET_PORT) },
}, null, 2)}\n`, 'utf8')

// The dev tree runs through the local Electron; a packaged build is a single binary.
const electronPath = executable === undefined ? require('electron') : undefined
const command = executable ?? electronPath
const commandArgs = executable === undefined ? [root] : []

const child = spawn(command, commandArgs, {
  cwd: root,
  env: {
    ...childEnvironment,
    DSH_DESKTOP_USER_DATA_DIR: userData,
    DSH_DESKTOP_DSH_HOME: join(userData, 'dsh-home'),
    DSH_DESKTOP_PORT: DSH_PORT,
    DSH_DESKTOP_LOAD_MODE: 'cookie',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})

let appOutput = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => { appOutput += chunk })
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => { appOutput += chunk })
child.on('error', (error) => { fail(`启动失败：${error.message}`) })

function stop() {
  if (child.exitCode === null) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
}

const sleep = (ms) => new Promise(resolvePromise => setTimeout(resolvePromise, ms))

/**
 * One HTTP call, written straight onto a socket.
 *
 * Deliberately not `http.request`: this machine sets `NODE_USE_ENV_PROXY=1` with a local Clash proxy
 * and a `NO_PROXY` that only covers `localhost`, so a request carrying `Host: evil.example` was sent
 * to the proxy instead of to the gateway — and the proxy's own empty 502 was read as the gateway's
 * answer. Raw bytes are also the faithful simulation: this is exactly what a phone (or an attacker's
 * page) puts on the wire.
 */
function call(url, options = {}) {
  const target = new URL(url)
  const path = `${target.pathname}${target.search}`
  const body = options.body ?? ''
  const headers = [
    `${options.method ?? 'GET'} ${path} HTTP/1.1`,
    `Host: ${options.host ?? target.host}`,
    ...(options.cookie === undefined ? [] : [`Cookie: ${options.cookie}`]),
    ...(body === '' ? [] : ['Content-Type: application/x-www-form-urlencoded', `Content-Length: ${Buffer.byteLength(body)}`]),
    'Connection: close',
    '',
    '',
  ].join('\r\n')

  return new Promise((resolvePromise, reject) => {
    const socket = connect(Number(target.port), target.hostname)
    let text = ''
    const timer = setTimeout(() => { socket.destroy(new Error('请求超时')) }, 20_000)
    socket.setEncoding('utf8')
    socket.on('connect', () => { socket.write(headers + body) })
    socket.on('data', chunk => { text += chunk })
    socket.on('error', error => { clearTimeout(timer); reject(error) })
    socket.on('close', () => {
      clearTimeout(timer)
      const separator = text.indexOf('\r\n\r\n')
      const head = separator < 0 ? text : text.slice(0, separator)
      const rest = separator < 0 ? '' : text.slice(separator + 4)
      const lines = head.split('\r\n')
      const status = Number(/^HTTP\/1\.1 (\d+)/u.exec(lines[0] ?? '')?.[1] ?? 0)
      const parsed = {}
      for (const line of lines.slice(1)) {
        const at = line.indexOf(':')
        if (at <= 0) continue
        const name = line.slice(0, at).trim().toLowerCase()
        const value = line.slice(at + 1).trim()
        parsed[name] = parsed[name] === undefined ? value : [].concat(parsed[name], value)
      }
      resolvePromise({ status, headers: parsed, body: rest })
    })
  })
}

/** Wait for the shell to log the gateway address it actually bound. */
async function waitForGateway() {
  const deadline = Date.now() + timeoutSeconds * 1000
  while (Date.now() < deadline) {
    if (existsSync(logPath)) {
      const text = readFileSync(logPath, 'utf8')
      const match = /手机访问已开启：(http:\/\/[^\s（]+)/u.exec(text)
      if (match !== null) return match[1]
      const failure = /手机访问(未开启|启动失败)：([^\n]*)/u.exec(text)
      if (failure !== null) fail(`手机访问没有起来：${failure[2] ?? ''}`)
    }
    if (child.exitCode !== null) fail(`应用提前退出（exit ${String(child.exitCode)}）：${appOutput.slice(-400)}`)
    await sleep(1_000)
  }
  return undefined
}

const markers = []
const gateway = await waitForGateway()
if (gateway === undefined) fail(`等待 ${String(timeoutSeconds)}s 仍未看到手机访问启动日志`)

if (!existsSync(statePath)) fail('没有生成 pocket.json（密码没有落盘）')
const password = JSON.parse(readFileSync(statePath, 'utf8'))?.lan?.password
if (typeof password !== 'string' || password.length < 8) fail(`pocket.json 里的密码不可用：${String(password)}`)
markers.push('pocket password persisted')

// 1. No session: the login page, never DSH.
const anonymous = await call(gateway)
if (anonymous.status !== 401) fail(`未登录应返回 401，实际 ${String(anonymous.status)}：${anonymous.body.slice(0, 160)}`)
if (!anonymous.body.includes('访问密码')) fail('未登录的应答不是登录页')
markers.push('anonymous request gets the login page')

// 2. A name this machine does not serve is refused (DNS rebinding defence).
const rebound = await call(gateway, { host: 'evil.example' })
if (rebound.status !== 403) fail(`换域名应返回 403，实际 ${String(rebound.status)}：${rebound.body.slice(0, 160)}`)
markers.push('foreign Host refused (403)')

// 3. A wrong password is refused, and the right one signs in.
const wrong = await call(`${gateway}__pocket/login`, { method: 'POST', body: 'password=Wrong1234' })
if (wrong.status !== 401) fail(`错误密码应返回 401，实际 ${String(wrong.status)}`)
const login = await call(`${gateway}__pocket/login?next=%2F`, { method: 'POST', body: `password=${encodeURIComponent(password)}` })
if (login.status !== 303) fail(`正确密码应返回 303，实际 ${String(login.status)}`)
const setCookie = String(login.headers['set-cookie'] ?? '')
const session = /dsh_pocket=([^;]+)/u.exec(setCookie)?.[1]
if (session === undefined) fail('登录应答没有会话 cookie')
markers.push('wrong password refused, right password signs in')

// 4. With the session, DSH itself answers — this is the path the phone uses.
let served
const servedDeadline = Date.now() + 60_000
while (Date.now() < servedDeadline) {
  served = await call(gateway, { cookie: `dsh_pocket=${session}` })
  if (served.status === 200) break
  await sleep(1_000)
}
if (served?.status !== 200) fail(`登录后应拿到 DSH 页面，实际 ${String(served?.status)}`)
if (!served.body.includes('__DSH_BOOT__')) fail('登录后的应答不像 DSH 页面（缺少 __DSH_BOOT__）')
if (JSON.stringify(served.headers['set-cookie'] ?? '').includes('dsh-auth')) fail('DSH 的 cookie 被转发给了手机')
markers.push('signed-in request is served by DSH, without leaking its cookie')

// 5. DSH itself must still be loopback only.
const netstat = await new Promise((resolvePromise) => {
  const probe = spawn('netstat', ['-ano'], { windowsHide: true })
  let text = ''
  probe.stdout.on('data', (chunk) => { text += String(chunk) })
  probe.on('close', () => { resolvePromise(text) })
})
const listening = netstat.split('\n').filter(line => line.includes(`:${DSH_PORT} `) && /LISTENING/iu.test(line))
if (listening.length === 0) fail(`netstat 里没有看到 DSH 监听 ${DSH_PORT}`)
const exposed = listening.filter(line => !line.includes('127.0.0.1:'))
if (exposed.length > 0) fail(`DSH 自己暴露到了非 loopback 地址：${exposed.join(' | ')}`)
markers.push(`DSH still listens on 127.0.0.1:${DSH_PORT} only`)

stop()
process.stdout.write(`${JSON.stringify({ ok: true, markers, gateway, log: logPath })}\n`)
// Best effort only: the app has just been killed and Windows may still hold its files. A failed
// cleanup must not turn a passing run into a failing exit code.
try {
  rmSync(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
} catch {
  // The directory is in tmp; leaving it behind is not worth a false failure.
}
process.exit(0)
