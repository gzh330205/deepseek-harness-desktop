/**
 * The agent bridge: a loopback server that exposes the shell's browser tools.
 *
 * Two surfaces consume it, and both are the *same* implementation behind the same guards:
 *
 * - **MCP** (`/mcp/<secret>`): the documented, versioned protocol path. DSH's base runtime
 *   ships `@deepseek-ai/dsh-mcp-client`, so one `insert` row in the `--patch` overlay is
 *   enough — nothing binds to DSH internals.
 * - **Direct call** (`/call/<secret>`): used by the `dsh-desktop-shell` host plugin, which
 *   registers the very same catalog as *native* DSH tools (thin proxies). Native tools get
 *   DSH's presentation and policy hooks; the catalog itself is written once, to
 *   `browser-tools.json`, and the shell decides which surface is active
 *   (see `browser-tool-surface.ts`).
 *
 * The plugin also reports what it managed to register (`/registered/<secret>`), so the shell can
 * fall back to MCP automatically on the next launch if a DSH upgrade changed the registry.
 *
 * Threat model: the routes are reachable by any local process, and the DSH page itself could
 * `fetch` this port. Therefore:
 *   - loopback only, ephemeral port;
 *   - a 256-bit random capability path per route, which is what reaches the overlay/env;
 *   - a 256-bit bearer token, compared in constant time;
 *   - requests carrying an `Origin` header are refused (a page-driven fetch always has one,
 *     a real MCP client or the plugin never does);
 *   - POST only; everything else is 404/405.
 *
 * The tools themselves are stateless: each request builds a fresh MCP server bound to the
 * same handler, which is what a JSON-response streamable-http transport wants.
 */

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import type { BrowserToolDefinition, BrowserToolResult } from './browser-tools.ts'

export interface AgentBridgeOptions {
  /** MCP server name; tool names reach the model as `mcp__<serverName>__<tool>`. */
  readonly serverName: string
  readonly tools: readonly BrowserToolDefinition[]
  /** Executes one tool call. Errors must come back as `isError` results, not throws. */
  /**
   * One tool call. sessionId is the DSH conversation that asked (the plugin reads it from
   * xec.agent.session), so browser tabs can be scoped per conversation.
   */
  readonly call: (name: string, args: unknown, signal: AbortSignal, sessionId: string) => Promise<BrowserToolResult>
  /** Optional log hook for connection-level diagnostics. */
  readonly log?: (line: string) => void
  /**
   * Called when the host plugin reports which tools it managed to register natively. The shell
   * persists this, so a DSH upgrade that breaks native registration degrades to MCP on the next
   * launch instead of silently losing the tools.
   */
  readonly onRegistered?: (report: BridgeRegistrationReport) => void
}

/** What the plugin says about its native registration attempt. */
export interface BridgeRegistrationReport {
  readonly ok: boolean
  readonly count: number
  readonly error?: string
}

export interface AgentBridge {
  /** Full MCP endpoint, including the capability path. Never log this. */
  readonly url: string
  /**
   * Direct tool-call endpoint for the host plugin. Same guards, same catalog, one hop shorter
   * than MCP (no handshake). Never log this.
   */
  readonly callUrl: string
  /**
   * Where the plugin reports which tools it managed to register natively, so the shell can fall
   * back to MCP on the next launch instead of losing the tools. Never log this.
   */
  readonly registeredUrl: string
  /** Bearer token all endpoints require. Never log this. */
  readonly token: string
  /** The catalog this bridge publishes, for the shell to write into `browser-tools.json`. */
  readonly tools: readonly BrowserToolDefinition[]
  close(): Promise<void>
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function bearer(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header
  if (typeof value !== 'string') return ''
  const match = /^Bearer (.+)$/u.exec(value.trim())
  return match?.[1] ?? ''
}

/** Read a small JSON body; `undefined` when it is absent, oversized or not JSON. */
async function readJsonBody(request: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > limit) return undefined
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * Start the bridge. Resolves once it is listening, so the caller can put the URL into the
 * overlay before DSH boots.
 */
export async function startAgentBridge(options: AgentBridgeOptions): Promise<AgentBridge> {
  const route = `/mcp/${randomBytes(32).toString('hex')}`
  const callRoute = `/call/${randomBytes(32).toString('hex')}`
  const registeredRoute = `/registered/${randomBytes(32).toString('hex')}`
  const token = randomBytes(32).toString('hex')
  const log = options.log ?? ((): void => {})

  const http: HttpServer = createServer((request: IncomingMessage, response: ServerResponse) => {
    void handle(request, response)
  })

  /** Guards shared by every route: POST, no Origin, correct bearer. */
  function guard(request: IncomingMessage, response: ServerResponse): boolean {
    if (request.method !== 'POST') {
      response.writeHead(405).end()
      return false
    }
    // A browser-initiated request always carries Origin; an MCP client or the plugin does not.
    if (request.headers.origin !== undefined) {
      response.writeHead(403).end()
      return false
    }
    if (!safeEqual(bearer(request.headers.authorization), token)) {
      log('agent bridge: 拒绝了一次凭据不正确的请求')
      response.writeHead(401).end()
      return false
    }
    return true
  }

  function sendJson(response: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload)
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(body)
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? '').split('?')[0] ?? ''

    // The plugin's direct tool calls: exactly the dispatcher MCP uses, minus the handshake.
    if (path === callRoute) {
      if (!guard(request, response)) return
      const body = await readJsonBody(request)
      if (body === undefined || typeof body !== 'object' || body === null) {
        sendJson(response, 400, { error: 'bad request body' })
        return
      }
      const invocation = body as { name?: unknown; args?: unknown; sessionId?: unknown }
      if (typeof invocation.name !== 'string' || invocation.name === '') {
        sendJson(response, 400, { error: 'missing tool name' })
        return
      }
      const controller = new AbortController()
      response.on('close', () => {
        if (!response.writableEnded) controller.abort()
      })
      try {
        const sessionId = typeof invocation.sessionId === 'string' ? invocation.sessionId : ''
        const result = await options.call(invocation.name, invocation.args ?? {}, controller.signal, sessionId)
        sendJson(response, 200, result.isError === true ? { content: result.content, isError: true } : { content: result.content })
      } catch (error) {
        log(`agent bridge: 直接调用失败 ${error instanceof Error ? error.message : String(error)}`)
        sendJson(response, 200, { content: [{ type: 'text', text: `工具执行失败：${error instanceof Error ? error.message : String(error)}` }], isError: true })
      }
      return
    }

    // The plugin's native-registration report (drives the automatic MCP fallback).
    if (path === registeredRoute) {
      if (!guard(request, response)) return
      const body = await readJsonBody(request)
      if (body === undefined || typeof body !== 'object' || body === null) {
        sendJson(response, 400, { error: 'bad request body' })
        return
      }
      const raw = body as { ok?: unknown; count?: unknown; error?: unknown }
      const count = typeof raw.count === 'number' && Number.isFinite(raw.count) ? raw.count : 0
      const report: BridgeRegistrationReport = raw.ok === true
        ? { ok: true, count }
        : { ok: false, count, error: typeof raw.error === 'string' ? raw.error.slice(0, 300) : '未知原因' }
      try {
        options.onRegistered?.(report)
      } catch (error) {
        log(`agent bridge: 注册回报处理失败 ${error instanceof Error ? error.message : String(error)}`)
      }
      sendJson(response, 200, { ok: true })
      return
    }

    if (path !== route) {
      response.writeHead(404).end()
      return
    }
    if (!guard(request, response)) return

    const controller = new AbortController()
    const server = new Server(
      { name: options.serverName, version: '1.0.0' },
      { capabilities: { tools: {} } },
    )
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: options.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      })),
    }))
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      // MCP callers have no conversation id on the wire; the plugin's direct path carries it.
    const result = await options.call(request.params.name, request.params.arguments ?? {}, controller.signal, '')
      // The SDK's CallToolResult accepts extra keys, but `isError` must be omitted (not
      // undefined) when the call succeeded.
      return result.isError === true
        ? { content: [...result.content], isError: true }
        : { content: [...result.content] }
    })

    // Stateless: omitting `sessionIdGenerator` is what the SDK's stateless mode means, and
    // each request gets its own transport (reusing one would collide message ids).
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true })
    response.on('close', () => {
      if (!response.writableEnded) controller.abort()
      void server.close().catch(() => {})
    })
    try {
      // `Transport.onclose` is optional and the SDK types it as `(() => void) | undefined`,
      // which this repository's `exactOptionalPropertyTypes` refuses to match. The runtime
      // shape is exactly the documented one, so the cast is local to this call.
      await server.connect(transport as unknown as Parameters<typeof server.connect>[0])
      await transport.handleRequest(request, response)
    } catch (error) {
      log(`agent bridge: 请求处理失败 ${error instanceof Error ? error.message : String(error)}`)
      if (!response.headersSent) response.writeHead(500).end()
      else response.end()
      await server.close().catch(() => {})
    }
  }

  http.requestTimeout = 120_000
  http.headersTimeout = 10_000

  const port = await new Promise<number>((resolve, reject) => {
    http.once('error', reject)
    http.listen(0, '127.0.0.1', () => {
      const address = http.address()
      if (address === null || typeof address === 'string') {
        http.close()
        reject(new Error('agent bridge: 无法绑定 loopback 端口'))
        return
      }
      resolve(address.port)
    })
  })
  // Keeps the process alive only through the app itself.
  http.unref()

  return {
    url: `http://127.0.0.1:${String(port)}${route}`,
    callUrl: `http://127.0.0.1:${String(port)}${callRoute}`,
    registeredUrl: `http://127.0.0.1:${String(port)}${registeredRoute}`,
    token,
    tools: options.tools,
    close: async (): Promise<void> => {
      await new Promise<void>((resolve) => { http.close(() => { resolve() }) })
    },
  }
}
