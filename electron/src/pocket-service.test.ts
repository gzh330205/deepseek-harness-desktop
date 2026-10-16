import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { DEFAULT_POCKET_PORT, createPocketService, type PocketService } from './pocket-service.ts'

const closers: (() => Promise<void> | void)[] = []
after(async () => { for (const close of closers.reverse()) await close() })

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
    upstream: { host: '127.0.0.1', port: upstream },
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

interface Reply { readonly status: number; readonly setCookie?: string }

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
      response.resume()
      const setCookie = response.headers['set-cookie']?.[0]
      response.on('end', () => { resolve({ status: response.statusCode ?? 0, ...(setCookie === undefined ? {} : { setCookie }) }) })
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
  const status = await service.apply({ enabled: true, port: 0 })
  assert.equal(status.running, true)
  assert.equal(status.address, '127.0.0.1')
  assert.match(String(status.url), /^http:\/\/127\.0\.0\.1:\d+\/$/u)

  assert.equal((await call(service)).status, 401, '没有会话时必须被挡住')
  const cookie = await signIn(service)
  assert.equal((await call(service, '/api/x', { cookie })).status, 200)
})

test('saving the settings again does not disturb the phone', async () => {
  const { service } = await startService()
  const first = await service.apply({ enabled: true, port: 0 })
  const cookie = await signIn(service)
  const second = await service.apply({ enabled: true, port: 0 })
  // Same port means no restart: the settings window saves the whole document on every change, and
  // a restart per save would drop a phone that is in the middle of a streamed answer.
  assert.equal(second.url, first.url)
  assert.equal((await call(service, '/api/x', { cookie })).status, 200, '会话不该因为一次保存而失效')
})

test('changing the port moves the listener', async () => {
  const { service } = await startService()
  await service.apply({ enabled: true, port: 0 })
  const port = await freePort()
  const moved = await service.apply({ enabled: true, port })
  assert.equal(moved.port, port)
  assert.equal(Number(new URL(String(moved.url)).port), port)
})

test('turning it off signs the phone out, so turning it back on needs the password again', async () => {
  const { service } = await startService()
  await service.apply({ enabled: true, port: 0 })
  const cookie = await signIn(service)
  assert.equal((await call(service, '/', { cookie })).status, 200)

  const off = await service.apply({ enabled: false, port: 0 })
  assert.equal(off.running, false)
  await service.apply({ enabled: true, port: 0 })
  assert.equal((await call(service, '/', { cookie })).status, 401, '关掉再打开不该恢复旧会话')
})

test('rotating the password invalidates both the old password and the old session', async () => {
  const { service } = await startService()
  await service.apply({ enabled: true, port: 0 })
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
  await service.apply({ enabled: true, port: 0 })
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
  const status = await service.apply({ enabled: true, port: 0 })
  assert.equal(status.enabled, true)
  assert.equal(status.running, false)
  assert.match(String(status.error), /局域网地址/u)

  // Joining a network later is the common fix, and the next save must pick it up by itself.
  setCandidates(['127.0.0.2'])
  const recovered = await service.apply({ enabled: true, port: 0 })
  assert.equal(recovered.running, true)
  assert.equal(recovered.address, '127.0.0.2')
  assert.equal(recovered.error, undefined)
})

test('the address can be pinned, and unpinned again', async () => {
  const { service, setCandidates } = await startService()
  setCandidates(['127.0.0.1', '127.0.0.2'])
  await service.apply({ enabled: true, port: 0 })
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
  await service.apply({ enabled: true, port: 0 })
  const cookie = await signIn(service)
  const refused = await call(service, '/', { cookie, host: 'evil.example' })
  assert.equal(refused.status, 403)
})

test('disposing stops the listener', async () => {
  const { service } = await startService()
  await service.apply({ enabled: true, port: 0 })
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
