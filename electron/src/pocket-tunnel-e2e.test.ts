/**
 * The public door, over the real internet.
 *
 * `DSH_DESKTOP_POCKET_E2E=1` and skipped everywhere else, because it opens a tunnel to Cloudflare.
 * What it proves that the unit tests cannot: that the **bundled** cloudflared actually publishes us,
 * that the address it prints is reachable from outside this machine, and that the door standing there
 * asks for the public password — not the LAN one, and not nothing.
 *
 *   $env:DSH_DESKTOP_POCKET_E2E='1'; node --test src/pocket-tunnel-e2e.test.ts
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createPocketGateway, type PocketGateway } from './pocket-gateway.ts'
import { createPocketRateLimiter, createPocketSessions } from './pocket-auth.ts'
import { createPocketTunnel, type PocketTunnel } from './pocket-tunnel.ts'

const enabled = process.env.DSH_DESKTOP_POCKET_E2E === '1'
const here = dirname(fileURLToPath(import.meta.url))
const binary = resolve(here, '..', 'resources', 'cloudflared', 'cloudflared.exe')

/** Start an upstream DSH stand-in that answers every request with a marker. */
function startUpstream(): Promise<{ readonly server: Server; readonly port: number }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('upstream-dsh-body')
  })
  return new Promise(resolvePort => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolvePort({ server, port: typeof address === 'object' && address !== null ? address.port : 0 })
    })
  })
}

/** GET/POST a URL, following nothing: the redirects here are the answer, not a step. */
async function call(url: string, options: { readonly method?: string; readonly cookie?: string; readonly body?: string } = {}): Promise<{ status: number; body: string; cookie?: string }> {
  const response = await fetch(url, {
    redirect: 'manual',
    method: options.method ?? 'GET',
    headers: {
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
    },
    ...(options.body === undefined ? {} : { body: options.body }),
  })
  const text = await response.text()
  const setCookie = response.headers.getSetCookie()[0]
  return { status: response.status, body: text, ...(setCookie === undefined ? {} : { cookie: setCookie.split(';')[0] ?? '' }) }
}

/**
 * Wait until Cloudflare's edge actually serves the tunnel.
 *
 * The address appears in cloudflared's output before DNS and the edge are ready, so the first few
 * requests legitimately fail; the tunnel is up when we get an answer from *our* gateway.
 *
 * @param url - Public address.
 * @returns The first real answer.
 */
async function waitForEdge(url: string, timeoutMs = 90_000): Promise<{ status: number; body: string }> {
  const deadline = Date.now() + timeoutMs
  let last = 'no attempt'
  while (Date.now() < deadline) {
    try {
      const answer = await call(url)
      if (answer.status === 401 && answer.body.includes('访问密码')) return answer
      last = `HTTP ${String(answer.status)}`
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 2_000))
  }
  throw new Error(`公网地址在 ${String(timeoutMs / 1000)} 秒内没有就绪：${last}`)
}

test('a real quick tunnel publishes the public door, and only the public password opens it', { skip: enabled ? false : 'set DSH_DESKTOP_POCKET_E2E=1 to run' }, async () => {
  if (!existsSync(binary)) {
    assert.fail(`缺少随包 cloudflared：${binary}（先运行 pnpm cloudflared:prepare）`)
  }

  const upstream = await startUpstream()
  const sessions = createPocketSessions()
  const lanSessions = createPocketSessions()
  const publicPassword = 'Pub12345678'
  const lanPassword = 'Lan12345678'

  const closers: (() => Promise<void> | void)[] = []
  let tunnel: PocketTunnel | undefined
  try {
    // The door the internet reaches: loopback only, its own password, its own sessions.
    const publicDoor: PocketGateway = await createPocketGateway({
      scope: 'public',
      upstream: { host: '127.0.0.1', port: upstream.port },
      listenAddress: '127.0.0.1',
      port: 0,
      allowedHosts: ['127.0.0.1', 'localhost'],
      dshCookie: () => 'dsh-auth=e2e-cookie',
      password: () => publicPassword,
      sessions,
      limiter: createPocketRateLimiter(),
      log: line => { process.stdout.write(`${line}\n`) },
    })
    closers.push(() => publicDoor.close())

    // A session earned on the LAN door, to prove it is not a key to this one.
    const lanDoor = await createPocketGateway({
      scope: 'lan',
      upstream: { host: '127.0.0.1', port: upstream.port },
      listenAddress: '127.0.0.1',
      port: 0,
      allowedHosts: ['127.0.0.1'],
      dshCookie: () => 'dsh-auth=e2e-cookie',
      password: () => lanPassword,
      sessions: lanSessions,
      limiter: createPocketRateLimiter(),
      log: () => {},
    })
    closers.push(() => lanDoor.close())
    const lanLogin = await call(`http://127.0.0.1:${String(lanDoor.port)}/__pocket/login`, { method: 'POST', body: `password=${lanPassword}` })
    assert.equal(lanLogin.status, 303, '局域网门自己应该能登录，否则第 4 步证明不了什么')
    assert.ok(lanLogin.cookie !== undefined)

    tunnel = createPocketTunnel({
      binary,
      originPort: publicDoor.port,
      log: line => { process.stdout.write(`${line}\n`) },
    })
    const started = await tunnel.start({ mode: 'quick' })
    assert.equal(started.running, true, `隧道没有起来：${String(started.error)}`)
    const url = String(started.url)
    assert.match(url, /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/u)

    // 1. Reachable from outside, and it asks for a password.
    const landing = await waitForEdge(`${url}/`)
    assert.equal(landing.status, 401)

    const loginPage = await call(`${url}/__pocket/login`)
    assert.equal(loginPage.status, 200)
    assert.match(loginPage.body, /公网访问/u, '公网门上要说清这是公网访问')

    // 2. The LAN password is not the public password.
    const wrong = await call(`${url}/__pocket/login`, { method: 'POST', body: `password=${lanPassword}` })
    assert.equal(wrong.status, 401)

    // 3. The public password opens it, and the session works through the tunnel.
    const opened = await call(`${url}/__pocket/login`, { method: 'POST', body: `password=${publicPassword}` })
    assert.equal(opened.status, 303)
    assert.ok(opened.cookie !== undefined)
    const page = await call(`${url}/`, { cookie: opened.cookie })
    assert.equal(page.status, 200)
    assert.equal(page.body, 'upstream-dsh-body')

    // 4. A session from the LAN door is worthless here.
    const lanSession = await call(`${url}/`, { cookie: lanLogin.cookie ?? '' })
    assert.equal(lanSession.status, 401, '局域网会话不能在公网门上通用')

    // 5. Closing the tunnel closes the door.
    await tunnel.stop()
    tunnel = undefined
    let stillServing = true
    try {
      const after = await call(`${url}/`)
      stillServing = after.body.includes('upstream-dsh-body')
    } catch {
      stillServing = false
    }
    assert.equal(stillServing, false, '隧道停掉后公网地址不该还能访问')
  } finally {
    if (tunnel !== undefined) await tunnel.stop()
    for (const close of closers.reverse()) await close()
    await new Promise<void>(resolveClose => { upstream.server.close(() => { resolveClose() }) })
  }
})
