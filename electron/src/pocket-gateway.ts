/**
 * The LAN side of phone access: a password-gated reverse proxy in front of `dsh web`.
 *
 * Why a proxy instead of binding DSH itself to the network: DSH's own browser authentication is
 * a one-time token plus a cookie, designed for a local browser that the shell launches. The
 * shell already exchanges that token for a cookie in the main process (`authenticate()` in
 * `main.ts`) so the token never reaches a page — this module reuses exactly that cookie and
 * attaches it upstream, which means **DSH itself keeps listening on loopback only** and the
 * phone authenticates against a credential that was designed to be typed on a phone.
 *
 * Two defences are worth naming, because both are easy to lose in a refactor:
 *
 * - **Host allowlist.** The listener answers only to names this machine actually serves, so a
 *   page on `evil.example` whose DNS resolves here (rebinding) is refused. The LAN password can
 *   be switched off, and this check is what keeps that from becoming a readable DSH.
 * - **Upstream cookies never travel inward.** `set-cookie` from DSH is dropped, and our session
 *   cookie is dropped before the request goes upstream. Each credential stays on its own side.
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import type { Duplex } from 'node:stream'

import { constantTimeEqual, readCookie, type PocketRateLimiter, type PocketSessions } from './pocket-auth.ts'
import { hostnameOf, isAllowedLanHost } from './pocket-net.ts'

/** Session cookie name; also the marker the login page checks. */
export const POCKET_COOKIE = 'dsh_pocket'

/** Paths the gateway answers itself instead of forwarding. */
const LOGIN_PATH = '/__pocket/login'
const LOGOUT_PATH = '/__pocket/logout'

/** Headers that describe one hop and must not be forwarded. */
const HOP_BY_HOP = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade',
] as const

export interface PocketGatewayOptions {
  /** Where DSH really listens — always loopback. */
  readonly upstream: { readonly host: string; readonly port: number }
  /** Address to bind; the address advertised to the phone. */
  readonly listenAddress: string
  readonly port: number
  /** Hostnames this listener may answer to (its own address, plus any other address of this machine). */
  readonly allowedHosts: readonly string[]
  /** The current `name=value` DSH cookie pair, or `undefined` while DSH is not running. */
  readonly dshCookie: () => string | undefined
  /** The password to check against, read fresh so a rotation takes effect immediately. */
  readonly password: () => string
  readonly sessions: PocketSessions
  readonly limiter: PocketRateLimiter
  /** Failure callback for the shell log; never receives credentials. */
  readonly log: (line: string) => void
}

export interface PocketGatewayStats {
  /** Requests answered (including refusals). */
  readonly requests: number
  /** Refused because the `Host` header named something we do not serve. */
  readonly refusedHost: number
  /** Refused because there was no valid session. */
  readonly refusedAuth: number
  /** Refused because the client was locked out. */
  readonly refusedLocked: number
  /** Times the upstream could not be reached or answered with an error. */
  readonly upstreamErrors: number
  /** WebSocket tunnels currently open. */
  readonly tunnels: number
}

export interface PocketGateway {
  readonly address: string
  readonly port: number
  readonly url: string
  stats(): PocketGatewayStats
  close(): Promise<void>
}

/** Escape text for the tiny pages this module serves itself. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, character => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] ?? character
  ))
}

/** The login page: no external resources, no script, sized for a phone. */
function loginPage(options: { readonly message?: string; readonly retryAfterSeconds?: number }): string {
  const message = options.message === undefined
    ? ''
    : `<p class="msg">${escapeHtml(options.message)}${
        options.retryAfterSeconds === undefined || options.retryAfterSeconds <= 0
          ? ''
          : `（约 ${String(options.retryAfterSeconds)} 秒后可再试）`
      }</p>`
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH Desktop 手机访问</title>
<style>
:root { color-scheme: light dark }
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
  font: 16px/1.7 system-ui, -apple-system, "Segoe UI", sans-serif; background: #0b0d10; color: #e8eaed }
form { width: min(88vw, 22rem); padding: 1.75rem; border-radius: 14px; background: #15181d;
  border: 1px solid #262b33; box-shadow: 0 12px 32px rgba(0,0,0,.45) }
h1 { margin: 0 0 .35rem; font-size: 1.15rem; letter-spacing: -.012em }
p { margin: 0 0 1rem; color: #9aa3ad; font-size: .9rem }
.msg { color: #f0b37e }
input { width: 100%; box-sizing: border-box; padding: .7rem .8rem; font-size: 1.05rem; letter-spacing: .06em;
  border-radius: 9px; border: 1px solid #333a44; background: #0f1216; color: inherit }
button { width: 100%; margin-top: .85rem; padding: .75rem; font-size: 1rem; font-weight: 600;
  border-radius: 9px; border: 0; background: #3b6ef5; color: #fff }
footer { margin-top: 1.1rem; color: #6b7480; font-size: .78rem }
</style></head>
<body><form method="post" action="${LOGIN_PATH}">
<h1>DSH Desktop 手机访问</h1>
<p>请输入电脑上「设置 → 手机访问」里显示的访问密码。</p>
${message}
<input name="password" type="password" inputmode="text" autocomplete="current-password"
  autofocus required minlength="8" maxlength="64" placeholder="访问密码">
<button type="submit">进入 DSH</button>
<footer>这是你自己的电脑。密码正确后，本次会话会一直有效，直到电脑上的 DSH 重启。</footer>
</form></body></html>`
}

/** A one-line refusal page; the reason is deliberately short and never echoes the credential. */
function refusalPage(title: string, detail: string, link?: { readonly href: string; readonly label: string }): string {
  const anchor = link === undefined
    ? ''
    : `<p style="margin-top:.9rem"><a href="${escapeHtml(link.href)}" style="color:#3b6ef5">${escapeHtml(link.label)}</a></p>`
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
  font: 16px/1.7 system-ui, -apple-system, "Segoe UI", sans-serif; background: #0b0d10; color: #e8eaed }
main { width: min(88vw, 26rem); padding: 1.6rem; border-radius: 14px; background: #15181d; border: 1px solid #262b33 }
h1 { margin: 0 0 .5rem; font-size: 1.05rem } p { margin: 0; color: #9aa3ad; font-size: .9rem }</style>
</head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>${anchor}</main></body></html>`
}

/** Read a small request body, refusing anything that looks like an attempt to exhaust memory. */
async function readBody(request: IncomingMessage, limitBytes = 8 * 1024): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > limitBytes) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Build the header set sent upstream: aimed at loopback, carrying the shell's DSH session. */
function upstreamHeaders(
  request: IncomingMessage,
  options: PocketGatewayOptions,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(request.headers)) {
    const lowered = name.toLowerCase()
    if (value === undefined) continue
    if ((HOP_BY_HOP as readonly string[]).includes(lowered)) continue
    // Never let the phone's credential reach DSH, and never let DSH's cookie reach the phone.
    if (lowered === 'cookie') continue
    if (lowered === 'set-cookie') continue
    // Host/Origin/Referer are rewritten below so DSH sees its own origin and passes its checks.
    if (lowered === 'host' || lowered === 'origin' || lowered === 'referer') continue
    headers[lowered] = value
  }
  const authority = `${options.upstream.host}:${String(options.upstream.port)}`
  headers.host = authority
  if (request.headers.origin !== undefined) headers.origin = `http://${authority}`
  if (request.headers.referer !== undefined) {
    const path = request.url ?? '/'
    headers.referer = `http://${authority}${path}`
  }
  const cookie = options.dshCookie()
  if (cookie !== undefined && cookie !== '') headers.cookie = cookie
  return { ...headers, ...extra }
}

/**
 * Start the gateway.
 *
 * @param options - Address, credentials and upstream.
 * @returns The running gateway.
 */
export async function createPocketGateway(options: PocketGatewayOptions): Promise<PocketGateway> {
  const stats = {
    requests: 0,
    refusedHost: 0,
    refusedAuth: 0,
    refusedLocked: 0,
    upstreamErrors: 0,
    tunnels: 0,
  }
  const tunnels = new Set<Duplex>()
  const authority = `${options.upstream.host}:${String(options.upstream.port)}`

  const respond = (response: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void => {
    response.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    })
    response.end(body)
  }

  const clientKey = (request: IncomingMessage): string => request.socket.remoteAddress ?? 'unknown'

  const handleLogin = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
    if (request.method === 'GET') {
      respond(response, 200, loginPage({}))
      return
    }
    if (request.method !== 'POST') {
      respond(response, 405, refusalPage('方法不被允许', '请用手机上的登录页面进入。'))
      return
    }
    const key = clientKey(request)
    const decision = options.limiter.check(key)
    if (!decision.allowed) {
      stats.refusedLocked += 1
      options.log(`pocket: 登录被锁定（${decision.reason ?? 'ip'}），来源 ${key}`)
      respond(response, 429, loginPage({
        message: decision.reason === 'global'
          ? '失败次数过多，暂时拒绝所有登录尝试'
          : '失败次数过多，请稍后再试',
        retryAfterSeconds: decision.retryAfterSeconds,
      }), { 'retry-after': String(decision.retryAfterSeconds) })
      return
    }
    let submitted = ''
    try {
      const body = await readBody(request)
      submitted = new URLSearchParams(body).get('password') ?? ''
    } catch {
      respond(response, 400, refusalPage('请求无法解析', '请返回登录页面重试。'))
      return
    }
    if (!constantTimeEqual(submitted, options.password())) {
      options.limiter.fail(key)
      stats.refusedAuth += 1
      const after = options.limiter.check(key)
      options.log(`pocket: 密码错误，来源 ${key}${after.allowed ? '' : '（已锁定）'}`)
      respond(response, 401, loginPage({
        message: '密码不正确',
        ...(after.allowed ? {} : { retryAfterSeconds: after.retryAfterSeconds }),
      }))
      return
    }
    options.limiter.succeed(key)
    const next = url.searchParams.get('next') ?? '/'
    // Only a same-site path may be redirected to; an absolute URL would turn this page into an
    // open redirect that someone could use to make the login look like it belongs elsewhere.
    const target = next.startsWith('/') && !next.startsWith('//') ? next : '/'
    options.log(`pocket: 登录成功，来源 ${key}`)
    respond(response, 303, '', {
      location: target,
      'set-cookie': `${POCKET_COOKIE}=${options.sessions.issue()}; Path=/; HttpOnly; SameSite=Strict`,
    })
  }

  const handleLogout = (response: ServerResponse): void => {
    respond(response, 303, '', {
      location: '/',
      'set-cookie': `${POCKET_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
    })
  }

  const proxy = (request: IncomingMessage, response: ServerResponse): void => {
    const headers = upstreamHeaders(request, options)
    const upstream = httpRequest({
      host: options.upstream.host,
      port: options.upstream.port,
      method: request.method,
      path: request.url ?? '/',
      headers,
    }, upstreamResponse => {
      const outgoing: Record<string, string | string[]> = {}
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (value === undefined) continue
        const lowered = name.toLowerCase()
        if ((HOP_BY_HOP as readonly string[]).includes(lowered)) continue
        // The phone holds our session, not DSH's: relaying it would hand a loopback credential
        // to the network.
        if (lowered === 'set-cookie') continue
        // `content-length` / `content-encoding` are deliberately kept: the body is piped through
        // byte for byte (Node's http client does not decompress), so they still describe it.
        outgoing[name] = value
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, outgoing)
      upstreamResponse.pipe(response)
    })
    upstream.on('error', error => {
      stats.upstreamErrors += 1
      options.log(`pocket: 上游不可达：${error.message}`)
      if (response.headersSent) {
        response.destroy()
        return
      }
      respond(response, 502, refusalPage('电脑上的 DSH 没有响应', '它可能正在重启。稍后在手机上刷新即可。'))
    })
    request.pipe(upstream)
  }

  const server: Server = createServer((request, response) => {
    stats.requests += 1
    const host = request.headers.host
    if (!isAllowedLanHost(host, options.allowedHosts)) {
      stats.refusedHost += 1
      options.log(`pocket: 拒绝非本机地址的 Host：${hostnameOf(host) ?? '(空)'}`)
      respond(response, 403, refusalPage(
        '这个地址不是本机的访问地址',
        '请用设置页里显示的局域网地址（或它生成的二维码）打开，其它域名不会得到响应。',
      ))
      return
    }

    let url: URL
    try {
      url = new URL(request.url ?? '/', `http://${host ?? 'localhost'}`)
    } catch {
      respond(response, 400, refusalPage('请求无法解析', '请返回登录页面重试。'))
      return
    }

    if (url.pathname === LOGIN_PATH) {
      void handleLogin(request, response, url)
      return
    }
    if (url.pathname === LOGOUT_PATH) {
      handleLogout(response)
      return
    }

    const session = readCookie(request.headers.cookie, POCKET_COOKIE)
    if (!options.sessions.verify(session)) {
      stats.refusedAuth += 1
      const next = encodeURIComponent(`${url.pathname}${url.search}`)
      respond(response, 401, refusalPage(
        '需要访问密码',
        '请打开登录页面输入电脑上显示的访问密码。',
        { href: `${LOGIN_PATH}?next=${next}`, label: '前往登录页面' },
      ))
      return
    }

    proxy(request, response)
  })

  // WebSocket (DSH's streaming channel) is a raw byte tunnel once the handshake is relayed, so it
  // is handled here rather than through the request handler: everything after the 101 belongs to
  // the two sockets.
  server.on('upgrade', (request, socket, head) => {
    stats.requests += 1
    const host = request.headers.host
    const refuse = (status: number, reason: string): void => {
      socket.write(`HTTP/1.1 ${String(status)} ${reason}\r\nConnection: close\r\n\r\n`)
      socket.destroy()
    }
    if (!isAllowedLanHost(host, options.allowedHosts)) {
      stats.refusedHost += 1
      refuse(403, 'Forbidden')
      return
    }
    const session = readCookie(request.headers.cookie, POCKET_COOKIE)
    if (!options.sessions.verify(session)) {
      stats.refusedAuth += 1
      refuse(401, 'Unauthorized')
      return
    }
    const headers = upstreamHeaders(request, options, { connection: 'Upgrade', upgrade: request.headers.upgrade ?? 'websocket' })
    const upstream = httpRequest({
      host: options.upstream.host,
      port: options.upstream.port,
      method: 'GET',
      path: request.url ?? '/',
      headers,
    })
    let upgraded = false
    upstream.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
      upgraded = true
      const lines = [`HTTP/1.1 ${String(upstreamResponse.statusCode ?? 101)} ${upstreamResponse.statusMessage ?? 'Switching Protocols'}`]
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (value === undefined) continue
        lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`)
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (upstreamHead.length > 0) socket.write(upstreamHead)
      if (head.length > 0) upstreamSocket.write(head)
      socket.pipe(upstreamSocket)
      upstreamSocket.pipe(socket)
      // Streaming wants the bytes out now, not after Nagle has collected enough of them. The
      // `upgrade` event hands the socket over as a `Duplex`, but at runtime it is a net.Socket.
      if (socket instanceof Socket) socket.setNoDelay(true)
      if (upstreamSocket instanceof Socket) upstreamSocket.setNoDelay(true)
      stats.tunnels += 1
      tunnels.add(socket)
      let finished = false
      const done = (): void => {
        // Idempotent on purpose: `end`, `close` and `error` all arrive for one tunnel, and the
        // counter must move exactly once.
        if (finished) return
        finished = true
        stats.tunnels = Math.max(0, stats.tunnels - 1)
        tunnels.delete(socket)
        socket.destroy()
        upstreamSocket.destroy()
      }
      // An upgraded socket stays half-open by default, so a phone that drops off WiFi sends a FIN
      // and then nothing at all: without the `end` listeners the tunnel — and the DSH session
      // behind it — would stay open until the process exits. A WebSocket never legitimately
      // half-closes, so ending either side ends the tunnel.
      socket.on('end', done)
      socket.on('close', done)
      socket.on('error', done)
      upstreamSocket.on('end', done)
      upstreamSocket.on('close', done)
      upstreamSocket.on('error', done)
    })
    upstream.on('error', () => { if (!upgraded) refuse(502, 'Bad Gateway') })
    // A refusal (expired DSH session, unknown path) arrives as a plain response: relay its status
    // instead of leaving the phone waiting for a handshake that will never come.
    upstream.on('response', upstreamResponse => {
      if (upgraded) return
      refuse(upstreamResponse.statusCode ?? 502, 'Upgrade Refused')
    })
    upstream.end()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.listenAddress, () => {
      server.off('error', reject)
      resolve()
    })
  })
  // Read the port back: a caller may pass 0 to let the system choose (tests do), and a caller that
  // passed a real port must see the same number it will advertise.
  const bound = server.address()
  const boundPort = typeof bound === 'object' && bound !== null ? bound.port : options.port
  options.log(`pocket: 局域网网关已启动 http://${options.listenAddress}:${String(boundPort)}（上游 ${authority}）`)

  return {
    address: options.listenAddress,
    port: boundPort,
    url: `http://${options.listenAddress}:${String(boundPort)}/`,
    stats: () => ({ ...stats }),
    close: async () => {
      for (const socket of tunnels) socket.destroy()
      tunnels.clear()
      const closed = new Promise<void>(resolve => { server.close(() => { resolve() }) })
      // Turning the switch off must drop the phone now, not when the last keep-alive or streaming
      // connection feels like ending. `close()` alone waits for both.
      server.closeIdleConnections()
      server.closeAllConnections()
      await closed
      options.log('pocket: 局域网网关已停止')
    },
  }
}
