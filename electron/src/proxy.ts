/**
 * Spike S2: the official shell's loading model, reduced to what a third-party shell
 * can actually do.
 *
 * The official desktop loads `dsh-app://app/` because it runs the private
 * `@deepseek-ai/dsh-desktop-host`, which injects boot data over IPC. That package is
 * not published, so this module instead reverse-proxies `dsh-app://app/*` onto the
 * loopback `dsh web` host: the page origin becomes the shell's own scheme, the
 * authentication cookie stays in the main process, and the token never reaches the
 * page. Everything after `protocol.handle` mirrors `src/web-document.ts` upstream.
 */

import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { protocol } from 'electron'

import { SCHEME } from './constants.ts'

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

/**
 * Response headers not relayed to the renderer. `set-cookie` would hand the host's
 * authentication cookie to the page's cookie jar, which the shell owns instead; the
 * rest describe the Node `fetch` connection rather than the resource.
 */
const WITHHELD_RESPONSE_HEADERS = [
  'set-cookie', 'content-encoding', 'content-length',
  'transfer-encoding', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade',
  'proxy-authenticate', 'proxy-authorization',
]

/** Plugin bundles carry a per-launch revision; caching them only accumulates garbage. */
const PLUGIN_BUNDLE_PATH = /^\/plugins\//u

/**
 * Must run before `app.whenReady()`: privileges cannot be granted afterwards.
 */
export function registerSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      codeCache: true,
    },
  }])
}

/** Serve an application-owned static file, refusing anything outside `root`. */
async function serveShellDocument(request: Request, root: string): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 })
  const url = new URL(request.url)
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return new Response(null, { status: 400 })
  }
  const directory = resolve(root)
  const target = resolve(directory, `.${pathname === '/' ? '/index.html' : pathname}`)
  if (!target.startsWith(directory + sep)) return new Response(null, { status: 403 })
  let body: Buffer
  try {
    body = await readFile(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Response(null, { status: 404 })
    throw error
  }
  return new Response(request.method === 'HEAD' ? null : new Uint8Array(body), {
    headers: { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' },
  })
}

/** Forward one authenticated request to the loopback host, preserving streaming. */
export async function forwardWebRequest(
  request: Request,
  host: string,
  cookie: string,
  allowedOrigin: string,
): Promise<Response> {
  const source = new URL(request.url)
  const origin = request.headers.get('origin')
  if (origin !== null && origin !== allowedOrigin) return new Response(null, { status: 403 })
  const target = new URL(host)
  target.pathname = source.pathname
  target.search = source.search
  const headers = new Headers(request.headers)
  for (const name of ['host', 'origin', 'cookie', 'sec-fetch-site']) headers.delete(name)
  headers.set('cookie', cookie)
  const response = await fetch(target, {
    method: request.method,
    headers,
    body: request.body,
    signal: request.signal,
    redirect: 'manual',
    // Required by Node's fetch when streaming a request body.
    duplex: 'half',
  } as RequestInit)
  const outgoing = new Headers(response.headers)
  for (const name of WITHHELD_RESPONSE_HEADERS) outgoing.delete(name)
  if (PLUGIN_BUNDLE_PATH.test(source.pathname)) outgoing.set('cache-control', 'no-store')
  return new Response(response.body, { status: response.status, headers: outgoing })
}

export interface ProxyHandlerOptions {
  /** Loopback origin of the managed host, once it is ready. */
  readonly host: () => string | undefined
  /** `name=value` authentication cookie held by the main process. */
  readonly cookie: () => string | undefined
  /** Directory holding shell-owned documents (`dsh-app://shell/`). */
  readonly shellRoot: string
  /** Document host used by proxy mode: `app` or `127.0.0.1:<port>`. */
  readonly documentHost: string
  /** Observation hook used by the smoke run to prove which requests were proxied. */
  readonly onRequest?: (info: { readonly path: string; readonly status: number }) => void
}

export function installProxyHandler(options: ProxyHandlerOptions): void {
  const allowedOrigin = `${SCHEME}://${options.documentHost}`
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url)
    if (url.hostname === 'shell') return serveShellDocument(request, options.shellRoot)
    if (url.host !== options.documentHost) {
      options.onRequest?.({ path: url.pathname, status: 404 })
      return new Response(null, { status: 404 })
    }
    const host = options.host()
    const cookie = options.cookie()
    if (host === undefined || cookie === undefined) {
      options.onRequest?.({ path: url.pathname, status: 503 })
      return new Response(null, { status: 503 })
    }
    const response = await forwardWebRequest(request, host, cookie, allowedOrigin)
    options.onRequest?.({ path: url.pathname, status: response.status })
    return response
  })
}
