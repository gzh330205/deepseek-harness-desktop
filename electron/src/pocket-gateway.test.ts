import assert from 'node:assert/strict'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'
import { after, test } from 'node:test'

import { createPocketRateLimiter, createPocketSessions } from './pocket-auth.ts'
import { POCKET_COOKIE, createPocketGateway, type PocketGateway } from './pocket-gateway.ts'

/** What the stub upstream saw, so the rewrite rules can be asserted rather than assumed. */
interface Seen {
  readonly url: string | undefined
  readonly method: string | undefined
  readonly host: string | undefined
  readonly origin: string | undefined
  readonly cookie: string | undefined
  readonly body: string | undefined
}

const upstreamSeen: Seen[] = []
const closers: (() => Promise<void> | void)[] = []
after(async () => {
  for (const close of closers.reverse()) await close()
})

/** An upstream that records what it received and echoes a marker, plus a WebSocket echo. */
async function startUpstream(): Promise<{ port: number; upgraded: Set<Duplex> }> {
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk as Buffer))
    request.on('end', () => {
      upstreamSeen.push({
        url: request.url,
        method: request.method,
        host: request.headers.host,
        origin: request.headers.origin,
        cookie: request.headers.cookie,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      response.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        // Must never reach the phone: this is the loopback credential.
        'set-cookie': 'dsh-auth=secret-loopback-cookie; Path=/; HttpOnly',
      })
      response.end(`upstream:${request.url ?? ''}`)
    })
  })
  /** Tunnels the gateway has not released yet — what the assertions look at. */
  const upgraded = new Set<Duplex>()
  /** Every upgraded socket, so teardown can destroy what is still half-open. */
  const sockets = new Set<Duplex>()
  server.on('upgrade', (_request, socket) => {
    sockets.add(socket)
    upgraded.add(socket)
    const released = (): void => { upgraded.delete(socket) }
    // An upgraded socket is half-open, so the gateway letting go shows up as `end` first
    // (its `destroy()` is a FIN); a stub that only watched `close` would look alive forever.
    socket.on('end', () => { released(); socket.destroy() })
    socket.on('close', () => { released(); sockets.delete(socket) })
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.on('data', chunk => { socket.write(chunk) })
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  closers.push(() => new Promise<void>(resolve => {
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    upgraded.clear()
    server.close(() => { resolve() })
    server.closeAllConnections()
  }))
  return { port, upgraded }
}

interface GatewayFixture {
  readonly gateway: PocketGateway
  readonly password: string
  readonly upstreamPort: number
  /** Tunnels the stub upstream currently has open, to catch a gateway that leaks them. */
  readonly upstreamTunnels: Set<Duplex>
  readonly setPassword?: (value: string) => void
}

async function startGateway(overrides: { readonly host?: string; readonly password?: string; readonly clock?: { value: number } } = {}): Promise<GatewayFixture> {
  const upstream = await startUpstream()
  let password = overrides.password ?? 'Test1234'
  const clock = overrides.clock
  const gateway = await createPocketGateway({
    scope: 'lan',
    upstream: { host: '127.0.0.1', port: upstream.port },
    listenAddress: '127.0.0.1',
    port: 0,
    allowedHosts: [overrides.host ?? '127.0.0.1'],
    dshCookie: () => 'dsh-auth=cookie-from-shell',
    password: () => password,
    sessions: createPocketSessions(),
    limiter: createPocketRateLimiter(clock === undefined ? {} : { now: () => clock.value }),
    log: () => {},
  })
  closers.push(() => gateway.close())
  return {
    gateway,
    password,
    upstreamPort: upstream.port,
    upstreamTunnels: upstream.upgraded,
    setPassword: (value: string) => { password = value },
  }
}

/** Poll a condition, for the things that settle one tick after the socket closes. */
async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return check()
}

interface Reply {
  readonly status: number
  readonly headers: Record<string, string | string[] | undefined>
  readonly body: string
}

function call(gateway: PocketGateway, options: {
  readonly path?: string
  readonly method?: string
  readonly host?: string
  readonly cookie?: string
  readonly body?: string
  readonly headers?: Readonly<Record<string, string>>
} = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port: gateway.port,
      method: options.method ?? 'GET',
      path: options.path ?? '/',
      headers: {
        host: options.host ?? `127.0.0.1:${String(gateway.port)}`,
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
        ...(options.body === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
        ...options.headers,
      },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk as Buffer))
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    request.on('error', reject)
    if (options.body !== undefined) request.write(options.body)
    request.end()
  })
}

/** Log in and return the session cookie, exactly as a phone would. */
async function login(gateway: PocketGateway, password: string): Promise<string> {
  const reply = await call(gateway, { path: '/__pocket/login', method: 'POST', body: `password=${encodeURIComponent(password)}` })
  assert.equal(reply.status, 303, `登录失败：${reply.status}`)
  const setCookie = String(reply.headers['set-cookie'] ?? '')
  const match = /dsh_pocket=([^;]+)/u.exec(setCookie)
  assert.ok(match !== null, '登录应答里没有会话 cookie')
  return `${POCKET_COOKIE}=${match[1] ?? ''}`
}

test('a Host header this machine does not serve is refused, so rebinding gets nowhere', async () => {
  const { gateway } = await startGateway()
  const seenBefore = upstreamSeen.length
  const reply = await call(gateway, { host: 'evil.example' })
  assert.equal(reply.status, 403)
  assert.match(reply.body, /不是本机的访问地址/u)
  assert.equal(gateway.stats().refusedHost, 1)
  assert.equal(upstreamSeen.length, seenBefore, '被拒的请求不该打到上游')
})

test('without a session the phone is sent to the login page, not to DSH', async () => {
  const { gateway } = await startGateway()
  const reply = await call(gateway, { path: '/?x=1' })
  assert.equal(reply.status, 401)
  assert.match(reply.body, /__pocket\/login\?next=/u)
  assert.equal(gateway.stats().refusedAuth, 1)
})

test('the right password signs the phone in, and the session opens DSH', async () => {
  const { gateway, upstreamPort } = await startGateway()
  const cookie = await login(gateway, 'Test1234')
  const reply = await call(gateway, { path: '/api/state', cookie })
  assert.equal(reply.status, 200)
  assert.equal(reply.body, 'upstream:/api/state')

  const last = upstreamSeen.at(-1)
  assert.equal(last?.host, `127.0.0.1:${String(upstreamPort)}`, '上游必须看到 loopback 权威')
  assert.equal(last?.cookie, 'dsh-auth=cookie-from-shell', '上游必须收到壳换来的 DSH cookie')
})

test('the loopback cookie never travels back to the phone', async () => {
  const { gateway } = await startGateway()
  const cookie = await login(gateway, 'Test1234')
  const reply = await call(gateway, { cookie })
  assert.equal(reply.headers['set-cookie'], undefined)
  assert.equal(reply.body.includes('dsh-auth'), false)
})

test('the phone session never travels upstream either', async () => {
  const { gateway } = await startGateway()
  const cookie = await login(gateway, 'Test1234')
  await call(gateway, { cookie })
  assert.equal(String(upstreamSeen.at(-1)?.cookie).includes(POCKET_COOKIE), false)
})

test('Origin and Referer are rewritten to the loopback authority', async () => {
  const { gateway } = await startGateway()
  const cookie = await login(gateway, 'Test1234')
  await call(gateway, { path: '/api/x', cookie, headers: { origin: 'http://127.0.0.1:9999', referer: 'http://127.0.0.1:9999/api/x' } })
  assert.match(String(upstreamSeen.at(-1)?.origin), /^http:\/\/127\.0\.0\.1:\d+$/u)
  assert.match(String(upstreamSeen.at(-1)?.origin), /127\.0\.0\.1/u)
})

test('a request body is forwarded unchanged', async () => {
  const { gateway } = await startGateway()
  const cookie = await login(gateway, 'Test1234')
  await call(gateway, { path: '/api/echo', method: 'POST', cookie, body: 'hello=world&n=2' })
  assert.equal(upstreamSeen.at(-1)?.method, 'POST')
  assert.equal(upstreamSeen.at(-1)?.body, 'hello=world&n=2')
})

test('five wrong passwords lock the client out, and the lock lifts on its own', async () => {
  const clock = { value: 1_000_000 }
  const { gateway } = await startGateway({ clock })
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const reply = await call(gateway, { path: '/__pocket/login', method: 'POST', body: 'password=Wrong123' })
    assert.equal(reply.status, 401)
  }
  const locked = await call(gateway, { path: '/__pocket/login', method: 'POST', body: 'password=Test1234' })
  assert.equal(locked.status, 429)
  assert.match(locked.body, /失败次数过多/u)
  assert.ok(Number(locked.headers['retry-after']) > 0)

  clock.value += 61_000
  const cookie = await login(gateway, 'Test1234')
  assert.equal((await call(gateway, { cookie })).status, 200)
})

test('a correct password clears earlier failures', async () => {
  const { gateway } = await startGateway()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await call(gateway, { path: '/__pocket/login', method: 'POST', body: 'password=Wrong123' })
  }
  const cookie = await login(gateway, 'Test1234')
  assert.equal((await call(gateway, { cookie })).status, 200)
})

test('the login redirect only ever points back at this gateway', async () => {
  const { gateway } = await startGateway()
  const reply = await call(gateway, {
    path: `/__pocket/login?next=${encodeURIComponent('https://evil.example/steal')}`,
    method: 'POST',
    body: 'password=Test1234',
  })
  assert.equal(reply.status, 303)
  assert.equal(reply.headers.location, '/')
})

test('rotating the password signs the phone out at once', async () => {
  const upstream = await startUpstream()
  let password = 'Test1234'
  const sessions = createPocketSessions()
  const gateway = await createPocketGateway({
    scope: 'lan',
    upstream: { host: '127.0.0.1', port: upstream.port },
    listenAddress: '127.0.0.1',
    port: 0,
    allowedHosts: ['127.0.0.1'],
    dshCookie: () => 'dsh-auth=cookie-from-shell',
    password: () => password,
    sessions,
    limiter: createPocketRateLimiter(),
    log: () => {},
  })
  closers.push(() => gateway.close())
  const cookie = await login(gateway, password)
  assert.equal((await call(gateway, { cookie })).status, 200)

  password = 'Fresh5678'
  sessions.rotate()
  assert.equal((await call(gateway, { cookie })).status, 401, '换密码后旧会话必须失效')
  assert.equal((await call(gateway, { cookie: await login(gateway, password) })).status, 200)
})

test('a WebSocket upgrade is relayed for a signed-in phone and refused without one', async () => {
  const { gateway, upstreamTunnels } = await startGateway()

  const refused = await new Promise<{ status: string }>((resolve, reject) => {
    const socket = connect(gateway.port, '127.0.0.1', () => {
      socket.write(`GET /api/events.host HTTP/1.1\r\nHost: 127.0.0.1:${String(gateway.port)}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`)
    })
    let text = ''
    socket.on('data', chunk => { text += chunk.toString('utf8') })
    socket.on('error', reject)
    socket.on('close', () => { resolve({ status: text.split('\r\n')[0] ?? '' }) })
  })
  assert.match(refused.status, /401/u)

  const cookie = await login(gateway, 'Test1234')
  const echoed = await new Promise<string>((resolve, reject) => {
    const socket = connect(gateway.port, '127.0.0.1', () => {
      socket.write([
        'GET /api/events.host HTTP/1.1',
        `Host: 127.0.0.1:${String(gateway.port)}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Cookie: ${cookie}`,
        '',
        '',
      ].join('\r\n'))
    })
    let text = ''
    socket.on('data', chunk => {
      text += chunk.toString('utf8')
      if (text.includes('101 Switching Protocols') && !text.includes('ping')) {
        socket.write('ping')
      }
      if (text.includes('ping')) {
        socket.destroy()
        resolve(text)
      }
    })
    socket.on('error', reject)
    setTimeout(() => { socket.destroy(); resolve(text) }, 3_000)
  })
  assert.match(echoed, /101 Switching Protocols/u)
  assert.match(echoed, /ping/u, '握手之后必须是双向透传')

  // A phone that walks out of WiFi range must not leave a tunnel into DSH behind it.
  const started = Date.now()
  const reclaimed = await waitFor(() => upstreamTunnels.size === 0, 10_000)
  assert.equal(reclaimed, true, `手机断开后网关必须把上游隧道一起收掉（等了 ${String(Date.now() - started)}ms，stub=${String(upstreamTunnels.size)} gateway=${String(gateway.stats().tunnels)}）`)
  assert.equal(gateway.stats().tunnels, 0)
})

test('the tunnel and request counters add up', async () => {
  const { gateway } = await startGateway()
  const cookie = await login(gateway, 'Test1234')
  await call(gateway, { cookie })
  const stats = gateway.stats()
  assert.ok(stats.requests >= 2, `至少应有登录与内容两次请求，实际 ${String(stats.requests)}`)
  assert.equal(stats.upstreamErrors, 0)
  assert.equal(stats.tunnels, 0)
})

test('an unreachable upstream answers 502 instead of hanging', async () => {
  // A port nothing listens on: the phone must get an explanation, not a spinner.
  const gateway = await createPocketGateway({
    scope: 'lan',
    upstream: { host: '127.0.0.1', port: 1 },
    listenAddress: '127.0.0.1',
    port: 0,
    allowedHosts: ['127.0.0.1'],
    dshCookie: () => 'dsh-auth=cookie-from-shell',
    password: () => 'Test1234',
    sessions: createPocketSessions(),
    limiter: createPocketRateLimiter(),
    log: () => {},
  })
  closers.push(() => gateway.close())
  const cookie = await login(gateway, 'Test1234')
  const reply = await call(gateway, { cookie })
  assert.equal(reply.status, 502)
  assert.match(reply.body, /DSH 没有响应/u)
  assert.equal(gateway.stats().upstreamErrors, 1)
})

test('a session from one door does not open the other, and each has its own password', async () => {
  const upstream = await startUpstream()
  const shape = {
    upstream: { host: '127.0.0.1', port: upstream.port },
    listenAddress: '127.0.0.1',
    port: 0,
    allowedHosts: ['127.0.0.1'],
    dshCookie: () => 'dsh-auth=cookie-from-shell',
    limiter: createPocketRateLimiter(),
    log: () => {},
  }
  // Separate session stores, exactly as the service wires them: the LAN password must not be a key to
  // the internet-facing door, and the public one must not be a key to the sofa-facing door either.
  const lan = await createPocketGateway({ ...shape, scope: 'lan', password: () => 'LanPass12', sessions: createPocketSessions() })
  const publicDoor = await createPocketGateway({ ...shape, scope: 'public', password: () => 'PubPass12', sessions: createPocketSessions() })
  closers.push(() => lan.close())
  closers.push(() => publicDoor.close())

  const lanCookie = await login(lan, 'LanPass12')
  assert.equal((await call(lan, { cookie: lanCookie })).status, 200)
  assert.equal((await call(publicDoor, { cookie: lanCookie })).status, 401, '局域网会话不能开公网的门')

  // The page people actually type into names the door: "手机访问" on the sofa, "公网访问" from the
  // internet, so a user who reached the wrong one can tell.
  const publicLogin = await call(publicDoor, { path: '/__pocket/login' })
  assert.equal(publicLogin.status, 200)
  assert.match(publicLogin.body, /公网访问/u)
  const lanLogin = await call(lan, { path: '/__pocket/login' })
  assert.match(lanLogin.body, /手机访问/u)

  const publicCookie = await login(publicDoor, 'PubPass12')
  assert.equal((await call(publicDoor, { cookie: publicCookie })).status, 200)
  assert.equal((await call(lan, { cookie: publicCookie })).status, 401, '公网会话也不能开局域网的门')

  // The LAN password is not accepted on the public door, and vice versa.
  const wrongDoor = await call(publicDoor, {
    path: '/__pocket/login',
    method: 'POST',
    body: 'password=LanPass12',
  })
  assert.equal(wrongDoor.status, 401)
})
