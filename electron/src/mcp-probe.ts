/**
 * Real availability checks for MCP servers, run from the shell's main process.
 *
 * The MCP window used to show only configuration; "is this server actually usable" needs a real MCP
 * handshake. The official SDK (`@modelcontextprotocol/sdk`, a devDependency that esbuild bundles
 * into `dist/main.js`) is imported **dynamically** on first check, so opening the shell pays nothing
 * for it.
 *
 * Every outcome is a value ({@link McpProbeResult}); this module never rejects, because the caller is
 * an IPC handler whose rejection would surface as an unexplained failure in the window.
 */

import { createRequire } from 'node:module'

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

import type { McpServer } from './dsh-config.ts'

/** One completed check. `ok:false` carries a readable `error` instead of throwing. */
export interface McpProbeResult {
  readonly ok: boolean
  readonly transport: 'stdio' | 'streamable-http'
  /** Number of tools the server listed (absent on failure). */
  readonly toolCount?: number
  /** First {@link MAX_TOOL_NAMES} tool names, in the order the server returned them. */
  readonly toolNames?: readonly string[]
  /** Readable, already truncated reason for a failure. */
  readonly error?: string
  readonly durationMs: number
  readonly checkedAt: number
}

/** A check that has not answered in this long is reported as a timeout and shut down. */
export const DEFAULT_MCP_PROBE_TIMEOUT_MS = 20_000
/** Longer errors (stack traces, server stderr) are cut here; the window shows one line anyway. */
const MAX_ERROR_CHARS = 2000
/** A server may expose hundreds of tools; the window only names a few. */
const MAX_TOOL_NAMES = 50
/** Identity sent in the MCP `initialize` handshake. */
const CLIENT_INFO = { name: 'dsh-desktop-mcp-check', version: '1.0.0' } as const

/**
 * esbuild bundles this file into an ESM `dist/main.js`, and its ESM output turns a bundled CommonJS
 * module's `require('node:child_process')` into a shim that throws
 * `Dynamic require of "child_process" is not supported` unless a global `require` exists. The MCP
 * SDK's stdio transport imports `cross-spawn` (CJS), so without this every stdio check would fail
 * with that message. (build.mjs documents the same class of failure for `yaml`, which it keeps
 * external; this module cannot change the build config, so it gives the shim a real require.)
 *
 * Installed once, lazily, immediately before the SDK is loaded — never at shell startup.
 */
let esmRequireReady = false
function installEsmRequire(): void {
  if (esmRequireReady) return
  esmRequireReady = true
  const holder = globalThis as typeof globalThis & { require?: NodeRequire }
  if (typeof holder.require === 'function') return
  try {
    holder.require = createRequire(import.meta.url)
  } catch {
    // A runtime without import.meta (not ours) keeps the plain failure; the probe stays a value.
  }
}

/**
 * The environment a stdio MCP server inherits from the check.
 *
 * DSH scrubs credentials and its own `DSH_*` variables before handing an environment to an MCP
 * server. The shell must do the same: a probe that passed its parent process's secrets to the child
 * would "work" for the wrong reason, and could leak them into a third-party server's logs. The
 * server's configured `env` is merged on top — that is the user's explicit intent and wins.
 */
export function probeEnvironment(configured?: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (name.startsWith('DSH_')) continue
    if (/KEY|PASSWORD|SECRET|TOKEN/iu.test(name)) continue
    env[name] = value
  }
  if (configured !== undefined) {
    for (const [name, value] of Object.entries(configured)) env[name] = value
  }
  return env
}

/** A readable one-paragraph reason; keeps the `fetch failed` cause, which is where the real error is. */
function reasonOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const parts = [error.message.trim()]
  if (error.cause instanceof Error) {
    const cause = error.cause.message.trim()
    if (cause !== '' && !parts.join(' ').includes(cause)) parts.push(cause)
  } else if (typeof error.cause === 'string' && error.cause.trim() !== '') {
    parts.push(error.cause.trim())
  }
  const code = (error as { readonly code?: unknown }).code
  if (typeof code === 'string' && code !== '' && !parts.join(' ').includes(code)) parts.push(code)
  const text = parts.filter((part) => part !== '').join('：')
  return text === '' ? '未知错误。' : text
}

function truncate(text: string): string {
  return text.length <= MAX_ERROR_CHARS ? text : `${text.slice(0, MAX_ERROR_CHARS)}…`
}

/** The timeout message names the budget, so an injected short timeout in tests reads correctly. */
function timeoutMessage(timeoutMs: number): string {
  if (timeoutMs % 1000 === 0) return `检查超时（${String(timeoutMs / 1000)} 秒）`
  return `检查超时（${String(timeoutMs)} 毫秒）`
}

function httpUrlOf(value: string | undefined): URL {
  if (value === undefined || value.trim() === '') throw new Error('streamable-http 服务没有配置 URL。')
  try {
    return new URL(value)
  } catch {
    throw new Error(`URL 不合法：${value}`)
  }
}

/**
 * Connect to one MCP server and list its tools.
 *
 * @param server - The configured server row (the same shape the config store lists).
 * @param options.timeoutMs - Budget for the whole handshake; defaults to 20 s.
 * @returns A result value — never a rejection.
 */
export async function probeMcpServer(server: McpServer, options: { readonly timeoutMs?: number } = {}): Promise<McpProbeResult> {
  const timeoutMs = options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.trunc(options.timeoutMs)
    : DEFAULT_MCP_PROBE_TIMEOUT_MS
  const transport = server.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
  const startedAt = Date.now()
  let stderrTail = ''
  let clientClose: (() => Promise<void>) | undefined
  let transportClose: (() => Promise<void>) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false

  const result = (ok: boolean, extras: { readonly toolCount?: number; readonly toolNames?: readonly string[]; readonly error?: string } = {}): McpProbeResult => ({
    ok,
    transport,
    durationMs: Date.now() - startedAt,
    checkedAt: Date.now(),
    ...extras,
  })

  /** One line per stdio chunk, keeping only the tail — that is what explains a failed startup. */
  const collectStderr = (chunk: unknown): void => {
    const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    stderrTail = (stderrTail + text).slice(-MAX_ERROR_CHARS)
  }

  const handshake = async (): Promise<{ toolCount: number; toolNames: string[] }> => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const client = new Client(CLIENT_INFO, { capabilities: {} })
    clientClose = async () => { await client.close() }

    let transportInstance: Transport
    if (transport === 'stdio') {
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
      const stdio = new StdioClientTransport({
        command: server.command ?? '',
        ...(server.args === undefined ? {} : { args: [...server.args] }),
        // The SDK would otherwise pass its own default environment; use DSH's scrubbing rules.
        env: probeEnvironment(server.env),
        ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
        // A failed startup usually explains itself on stderr; keep the tail for the error line.
        stderr: 'pipe',
      })
      stdio.stderr?.on('data', collectStderr)
      stdio.stderr?.on('error', () => {})
      transportInstance = stdio
      transportClose = async () => { await stdio.close() }
    } else {
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
      const http = new StreamableHTTPClientTransport(httpUrlOf(server.url), {
        requestInit: { headers: { ...(server.headers ?? {}) } },
      })
      // The SDK's own declaration of `StreamableHTTPClientTransport.sessionId` is `string` while
      // `Transport` says `string | undefined`; under `exactOptionalPropertyTypes` those two cannot be
      // compared, though the class is the transport the client expects. The cast is the SDK's typing.
      transportInstance = http as unknown as Transport
      transportClose = async () => { await http.close() }
    }

    await client.connect(transportInstance)
    const listed = await client.listTools()
    const names = listed.tools
      .map((tool) => (typeof tool.name === 'string' ? tool.name : ''))
      .filter((name) => name !== '')
    return { toolCount: listed.tools.length, toolNames: names.slice(0, MAX_TOOL_NAMES) }
  }

  // Must happen before the dynamic SDK import: the bundled `cross-spawn` needs a real `require`.
  installEsmRequire()
  // The losing side of the race must never become an unhandled rejection: the handshake may still
  // be pending when the deadline wins, and it will reject once the transports are closed.
  const started = handshake()
  started.catch(() => {})
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      reject(new Error('probe timeout'))
    }, timeoutMs)
  })

  try {
    const outcome = await Promise.race([started, deadline])
    return result(true, { toolCount: outcome.toolCount, toolNames: outcome.toolNames })
  } catch (error) {
    const reason = timedOut ? timeoutMessage(timeoutMs) : reasonOf(error)
    const stderr = stderrTail.trim()
    return result(false, { error: truncate(stderr === '' ? reason : `${reason}\n${stderr}`) })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    // Close both even on success: the page only needed the tool list, and a leftover child process
    // (or an HTTP session) would outlive the check. `client.close()` also closes its transport, so
    // both are attempted concurrently and each failure is ignored.
    const closes: Promise<unknown>[] = []
    if (clientClose !== undefined) closes.push(clientClose().catch(() => undefined))
    if (transportClose !== undefined) closes.push(transportClose().catch(() => undefined))
    await Promise.allSettled(closes)
  }
}
