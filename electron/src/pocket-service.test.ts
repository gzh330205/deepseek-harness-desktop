import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { DEFAULT_POCKET_PORT, createPocketService, type PocketService } from './pocket-service.ts'
import type { PocketTunnel, PocketTunnelStatus } from './pocket-tunnel.ts'
import { DEFAULT_POCKET_SETTINGS } from './settings-shape.ts'

const closers: (() => Promise<void> | void)[] = []
after(async () => { for (const close of closers.reverse()) await close() })

/**
 * Phone access with **both** listeners on OS-assigned ports.
 *
 * The tunnel port defaults to 41731, which is the shipping app's public door: these tests failed on
 * any machine where DSH Desktop itself was running public access, which is exactly the machine a
 * release is prepared on. Port 0 binds an ephemeral port; the tests read the live one from status().
 */
const FREE_PORT_SETTINGS = {
  ...DEFAULT_POCKET_SETTINGS,
  enabled: true,
  port: 0,
  tunnel: { ...DEFAULT_POCKET_SETTINGS.tunnel, port: 0 },
}

/** An upstream that answers anything with a marker; the gateway's job is the interesting part. */
async function startUpstream(): Promise<number> {
  const server: Server = createServer((_request, response) => { response.end('dsh') })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  closers.push(() => new Promise<void>(resolve => {
    server.close(() => { resolve() })
    server.closeAllConnections()
  }))
  return port
}

interface Fixture {
  readonly service: PocketService
  readonly dir: string
  setCandidates(addresses: readonly string[]): void
}

async function startService(): Promise<Fixture> {
  const upstream = await startUpstream()
  const dir = mkdtempSync(join(tmpdir(), 'pocket-service-'))
  // Real loopback addresses: the gateway must be able to bind what the fixture advertises.
  let addresses: readonly string[] = ['127.0.0.1']
  // Sequential passwords, so "rotating" really produces a different value.
  let serial = 0
  const service = createPocketService({
    bridgeDir: dir,
    upstream: () => ({ host: '127.0.0.1', port: upstream }),
    dshCookie: () => 'dsh-auth=shell-cookie',
    log: () => {},
    candidates: () => addresses.map(address => ({ address, name: 'test', virtual: false })),
    generate: () => `Gen${String(++serial).padStart(5, '0')}`,
  })
  closers.push(() => service.dispose())
  return {
    service,
    dir,
    setCandidates: (next: readonly string[]) => { addresses = next },
  }
}

/** A port nothing is listening on, for the tests that need a concrete one. */
async function freePort(): Promise<number> {
  const server: Server = createServer()
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  return port
}

interface Reply { readonly status: number; readonly body: string; readonly setCookie?: string }

/** Call the gateway as a phone would, optionally carrying a session. */
function call(service: PocketService, path = '/', options: { readonly method?: string; readonly cookie?: string; readonly body?: string; readonly host?: string } = {}): Promise<Reply> {
  const status = service.status()
  assert.ok(status.url !== undefined, '网关没有在跑')
  const target = new URL(status.url)
  const port = Number(target.port)
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: target.hostname,
      port,
      method: options.method ?? 'GET',
      path,
      headers: {
        host: options.host ?? `127.0.0.1:${String(port)}`,
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
        ...(options.body === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
      },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk as Buffer))
      const setCookie = response.headers['set-cookie']?.[0]
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          ...(setCookie === undefined ? {} : { setCookie }),
        })
      })
    })
    request.on('error', reject)
    if (options.body !== undefined) request.write(options.body)
    request.end()
  })
}

async function signIn(service: PocketService, password = service.status().password): Promise<string> {
  const reply = await call(service, '/__pocket/login', { method: 'POST', body: `password=${password}` })
  assert.equal(reply.status, 303, '登录失败')
  const match = /dsh_pocket=([^;]+)/u.exec(reply.setCookie ?? '')
  assert.ok(match !== null, '没有拿到会话 cookie')
  return `dsh_pocket=${match[1] ?? ''}`
}

test('the feature is off until it is switched on, but a password already exists', async () => {
  const { service } = await startService()
  const status = service.status()
  assert.equal(status.enabled, false)
  assert.equal(status.running, false)
  assert.equal(status.port, DEFAULT_POCKET_PORT)
  assert.equal(status.password.length, 8)
})

test('switching it on serves the phone, still behind the password', async () => {
  const { service } = await startService()
  const status = await service.apply(FREE_PORT_SETTINGS)
  assert.equal(status.running, true)
  assert.equal(status.address, '127.0.0.1')
  assert.match(String(status.url), /^http:\/\/127\.0\.0\.1:\d+\/$/u)

  assert.equal((await call(service)).status, 401, '没有会话时必须被挡住')
  const cookie = await signIn(service)
  assert.equal((await call(service, '/api/x', { cookie })).status, 200)
})

test('saving the settings again does not disturb the phone', async () => {
  const { service } = await startService()
  const first = await service.apply(FREE_PORT_SETTINGS)
  const cookie = await signIn(service)
  const second = await service.apply(FREE_PORT_SETTINGS)
  // Same port means no restart: the settings window saves the whole document on every change, and
  // a restart per save would drop a phone that is in the middle of a streamed answer.
  assert.equal(second.url, first.url)
  assert.equal((await call(service, '/api/x', { cookie })).status, 200, '会话不该因为一次保存而失效')
})

test('changing the port moves the listener', async () => {
  const { service } = await startService()
  await service.apply(FREE_PORT_SETTINGS)
  const port = await freePort()
  const moved = await service.apply({ ...DEFAULT_POCKET_SETTINGS, enabled: true, port })
  assert.equal(moved.port, port)
  assert.equal(Number(new URL(String(moved.url)).port), port)
})

test('turning it off signs the phone out, so turning it back on needs the password again', async () => {
  const { service } = await startService()
  await service.apply(FREE_PORT_SETTINGS)
  const cookie = await signIn(service)
  assert.equal((await call(service, '/', { cookie })).status, 200)

  const off = await service.apply({ ...DEFAULT_POCKET_SETTINGS, enabled: false, port: 0 })
  assert.equal(off.running, false)
  await service.apply(FREE_PORT_SETTINGS)
  assert.equal((await call(service, '/', { cookie })).status, 401, '关掉再打开不该恢复旧会话')
})

test('rotating the password invalidates both the old password and the old session', async () => {
  const { service } = await startService()
  await service.apply(FREE_PORT_SETTINGS)
  const cookie = await signIn(service)
  const before = service.status().password

  const rotated = service.rotatePassword()
  assert.notEqual(rotated.password, before, '刷新必须产生一个新密码')
  assert.equal((await call(service, '/', { cookie })).status, 401)

  const oldPassword = await call(service, '/__pocket/login', { method: 'POST', body: `password=${before}` })
  assert.equal(oldPassword.status, 401, '换代后旧密码不该还能用')
  assert.equal((await call(service, '/', { cookie: await signIn(service) })).status, 200)
})

test('a custom password is validated before it replaces anything', async () => {
  const { service } = await startService()
  await service.apply(FREE_PORT_SETTINGS)
  const original = service.status().password

  const rejected = service.setPassword('short')
  assert.equal(rejected.ok, false)
  assert.match(String(rejected.ok === false ? rejected.reason : ''), /长度/u)
  assert.equal(service.status().password, original, '被拒的密码不能改动当前密码')

  const accepted = service.setPassword('Custom1234')
  assert.equal(accepted.ok, true)
  assert.equal(service.status().password, 'Custom1234')
  const cookie = await signIn(service, 'Custom1234')
  assert.equal((await call(service, '/', { cookie })).status, 200)
})

test('without a LAN address it explains itself instead of pretending to run', async () => {
  const { service, setCandidates } = await startService()
  setCandidates([])
  const status = await service.apply(FREE_PORT_SETTINGS)
  assert.equal(status.enabled, true)
  assert.equal(status.running, false)
  assert.match(String(status.error), /局域网地址/u)

  // Joining a network later is the common fix, and the next save must pick it up by itself.
  setCandidates(['127.0.0.2'])
  const recovered = await service.apply(FREE_PORT_SETTINGS)
  assert.equal(recovered.running, true)
  assert.equal(recovered.address, '127.0.0.2')
  assert.equal(recovered.error, undefined)
})

test('the address can be pinned, and unpinned again', async () => {
  const { service, setCandidates } = await startService()
  setCandidates(['127.0.0.1', '127.0.0.2'])
  await service.apply(FREE_PORT_SETTINGS)
  assert.equal(service.status().address, '127.0.0.1')

  const pinned = await service.select('127.0.0.2')
  assert.equal(pinned.address, '127.0.0.2')
  assert.equal(pinned.selected, '127.0.0.2')

  const automatic = await service.select('')
  assert.equal(automatic.address, '127.0.0.1')
  assert.equal(automatic.selected, undefined)
})

test('a request aimed at another name is refused by the service too, not only by the proxy', async () => {
  const { service } = await startService()
  await service.apply(FREE_PORT_SETTINGS)
  const cookie = await signIn(service)
  const refused = await call(service, '/', { cookie, host: 'evil.example' })
  assert.equal(refused.status, 403)
})

test('disposing stops the listener', async () => {
  const { service } = await startService()
  await service.apply(FREE_PORT_SETTINGS)
  const url = String(service.status().url)
  await service.dispose()
  assert.equal(service.status().running, false)
  const port = Number(new URL(url).port)
  await assert.rejects(
    new Promise((resolve, reject) => {
      const probe = httpRequest({ host: '127.0.0.1', port, path: '/' }, () => { resolve(undefined) })
      probe.on('error', reject)
      probe.end()
    }),
    '端口应该已经释放',
  )
})

// --- the public door -------------------------------------------------------------------------

/** A tunnel that reports success without touching the network; the module has its own tests. */
function fakeTunnel(url = 'https://random-words-here.trycloudflare.com/'): PocketTunnel {
  let current: PocketTunnelStatus = { running: false, mode: 'quick' }
  return {
    async start(request: { readonly mode: 'quick' | 'named'; readonly token?: string; readonly domain?: string }) {
      current = { running: true, mode: request.mode, url: request.mode === 'named' ? `https://${request.domain ?? ''}/` : url }
      return current
    },
    async stop() {
      current = { running: false, mode: current.mode }
    },
    status: () => current,
  }
}

async function startPublicService(options: { readonly enabled?: boolean; readonly accepted?: boolean; readonly customPassword?: string } = {}): Promise<Fixture> {
  const upstream = await startUpstream()
  const dir = mkdtempSync(join(tmpdir(), 'pocket-public-'))
  if (options.accepted === true) {
    writeFileSync(join(dir, 'pocket.json'), `${JSON.stringify({
      version: 1,
      lan: { password: 'Gen00001' },
      tunnel: { mode: 'quick', accepted: true },
      ...(options.customPassword === undefined ? {} : { public: { password: options.customPassword, custom: true } }),
    }, null, 2)}\n`, 'utf8')
  }
  let addresses: readonly string[] = ['127.0.0.1']
  let serial = 0
  const service = createPocketService({
    bridgeDir: dir,
    upstream: () => ({ host: '127.0.0.1', port: upstream }),
    dshCookie: () => 'dsh-auth=shell-cookie',
    log: () => {},
    tunnelBinary: 'C:/fake/cloudflared.exe',
    createTunnel: () => fakeTunnel(),
    candidates: () => addresses.map(address => ({ address, name: 'test', virtual: false })),
    generate: () => `Gen${String(++serial).padStart(5, '0')}`,
  })
  closers.push(() => service.dispose())
  return { service, dir, setCandidates: (next: readonly string[]) => { addresses = next } }
}

/** Call the public listener directly (as the tunnel would). */
function callPublic(service: PocketService, path = '/', options: { readonly method?: string; readonly cookie?: string; readonly body?: string } = {}): Promise<Reply> {
  const port = service.status().publicAccess.port
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      method: options.method ?? 'GET',
      path,
      headers: {
        host: `127.0.0.1:${String(port)}`,
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
        ...(options.body === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
      },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk as Buffer))
      const setCookie = response.headers['set-cookie']?.[0]
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
        ...(setCookie === undefined ? {} : { setCookie }),
      }))
    })
    request.on('error', reject)
    if (options.body !== undefined) request.write(options.body)
    request.end()
  })
}

test('public access refuses to start without the disclaimer', async () => {
  const { service } = await startPublicService()
  const status = await service.startTunnel({ acceptedDisclaimer: false })
  assert.equal(status.publicAccess.running, false)
  assert.match(String(status.publicAccess.error), /免责声明/u)
})

test('the public listener is loopback only and asks for the public password', async () => {
  const { service } = await startPublicService()
  await service.apply(FREE_PORT_SETTINGS)
  const status = await service.startTunnel({ acceptedDisclaimer: true })
  assert.equal(status.publicAccess.running, true)
  assert.match(String(status.publicAccess.url), /trycloudflare\.com/u)
  assert.notEqual(status.publicAccess.password, status.password, '公网密码与局域网密码必须是两个')

  const page = await callPublic(service, '/__pocket/login')
  assert.equal(page.status, 200)
  assert.match(page.body, /公网访问/u, '公网门上必须说清这是公网访问')

  // The public password opens it; the LAN password does not.
  const wrongDoor = await callPublic(service, '/__pocket/login', { method: 'POST', body: `password=${service.status().password}` })
  assert.equal(wrongDoor.status, 401)
  const opened = await callPublic(service, '/__pocket/login', { method: 'POST', body: `password=${service.status().publicAccess.password}` })
  assert.equal(opened.status, 303)
  const cookie = /dsh_pocket=([^;]+)/u.exec(String(opened.setCookie ?? ''))?.[1]
  assert.ok(cookie !== undefined)
  assert.equal((await callPublic(service, '/api/x', { cookie: `dsh_pocket=${cookie ?? ''}` })).status, 200)
})

test('a LAN session does not open the public door', async () => {
  const { service } = await startPublicService()
  await service.apply(FREE_PORT_SETTINGS)
  await service.startTunnel({ acceptedDisclaimer: true })
  const lanCookie = await signIn(service)
  assert.equal((await call(service, '/', { cookie: lanCookie })).status, 200, '局域网门应该认这个会话')
  assert.equal((await callPublic(service, '/', { cookie: lanCookie })).status, 401, '公网门不该认局域网会话')
})

test('each quick tunnel gets a fresh public password unless the user fixed one', async () => {
  const { service } = await startPublicService()
  await service.apply(FREE_PORT_SETTINGS)
  const first = (await service.startTunnel({ acceptedDisclaimer: true })).publicAccess.password
  const second = (await service.startTunnel({ acceptedDisclaimer: true })).publicAccess.password
  assert.notEqual(first, second, '快速隧道每次开都应该换密码')

  const fixed = service.setPublicPassword('Custom1234')
  assert.equal(fixed.ok, true)
  const third = (await service.startTunnel({ acceptedDisclaimer: true })).publicAccess.password
  assert.equal(third, 'Custom1234', '用户固定过的密码不该被轮换')
})

test('the tunnel is stopped and forgotten when public access is turned off', async () => {
  const fixture = await startPublicService({ accepted: true })
  const { service } = fixture
  await service.apply(FREE_PORT_SETTINGS)
  await service.startTunnel({ acceptedDisclaimer: true })
  const stopped = await service.stopTunnel()
  assert.equal(stopped.publicAccess.running, false)

  // Forgotten on disk, so the next boot cannot reopen a door the user closed.
  const state = JSON.parse(readFileSync(join(fixture.dir, 'pocket.json'), 'utf8')) as { tunnel?: unknown }
  assert.equal(state.tunnel, undefined)
})
