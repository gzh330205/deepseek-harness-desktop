/**
 * The managed `dsh web` child process.
 *
 * Differences from the Tauri shell:
 * - the child is `process.execPath` in Electron Node mode, so no system Node and no
 *   `cmd.exe` shim are involved;
 * - readiness still comes from the one-time authentication URL on stdout, but the
 *   URL is delivered as a structured `ready` event rather than a polling loop over
 *   shared state.
 *
 * The Tauri shell's ordering rule is preserved: redaction applies to the log buffer
 * only. Navigation always uses the untouched URL.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { delimiter, dirname } from 'node:path'

import {
  DSH_BRIDGE_DIR_ENV,
  DSH_HOME_ENV,
  DSH_PNPM_ENTRY_ENV,
  HOST_EXIT_TIMEOUT_MS,
  LOOPBACK,
  STARTUP_TIMEOUT_MS,
  type LoadMode,
} from './constants.ts'
import { bareUrl, parseDshWebAuthUrl, redactAuthToken } from './dsh-output.ts'
import { nodeModeEnvironment } from './dsh-runner.ts'
import { writeOverlay, type AgentMcpEndpoint, type OverlayOptions } from './desktop-files.ts'

/** The overlay's tool-surface switches, passed straight through from main.ts. */
type ToolSurfaceOptions = OverlayOptions
import { bridgeDir, harnessHome } from './paths.ts'
import { proxyEnvironment, type ManagedProxy } from './settings.ts'

export interface HostReady {
  /** Unmodified one-time authentication URL, including the token. */
  readonly authUrl: string
  /** The same address without the token: what the page should end up on. */
  readonly bareUrl: string
  readonly port: number
}

export interface HostOptions {
  readonly entry: string
  readonly version: string
  readonly port: number
  readonly appVersion: string
  readonly loadMode: LoadMode
  readonly proxy: ManagedProxy
  readonly noOpen: boolean
  /** Profile the shell owns; its plugins and lockfile are separate from the CLI's. */
  readonly profileName: string
  /** Directory holding the bundled `pnpm`/`node` shims, prepended to PATH when present. */
  readonly runtimeBinDir?: string
  /**
   * pnpm's JavaScript entry, handed to the `pnpm.cmd` shim through the environment.
   *
   * The runtime is packed into the app ASAR, so a shim cannot find pnpm by a relative path: the
   * shim is a real file (`app.asar.unpacked/dsh/bin`), while pnpm's JS is inside the archive. The
   * shell resolves the entry once and passes it down.
   */
  readonly pnpmEntry?: string
  /** Browser-tool MCP endpoint the overlay should point DSH's MCP client at. */
  readonly agentMcp?: AgentMcpEndpoint
  /** How the tool catalog is published this launch: native tools, or the MCP row. */
  readonly toolSurface?: ToolSurfaceOptions
  readonly onLog: (stream: 'stdout' | 'stderr', line: string) => void
}

export class DshHostProcess {
  private child: ChildProcess | undefined
  private stopped = false
  private readonly logBuffer: string[] = []
  private overlayPathValue = ''
  private panelInjected = false

  constructor(private readonly options: HostOptions) {}

  get overlayPath(): string { return this.overlayPathValue }
  get injectedPanel(): boolean { return this.panelInjected }
  get recentLogs(): readonly string[] { return this.logBuffer }

  /**
   * Spawn the child once and resolve when dsh prints its authentication URL.
   */
  async start(): Promise<HostReady> {
    const overlay = writeOverlay(this.options.appVersion, this.options.agentMcp, this.options.toolSurface ?? {})
    this.overlayPathValue = overlay.path
    this.panelInjected = overlay.panelInjected
    mkdirSync(dirname(overlay.path), { recursive: true })

    // `--patch` is a launcher-level option and must precede the web app's own
    // arguments; after `--host` commander passes it through and reports
    // `unknown option '--patch'` (verified in the Tauri P0). `--profile` is the same kind
    // of option, and `dsh web` is just the shipped `web` profile — booting our own
    // profile is what keeps plugin installs out of the CLI's reach.
    const args = [
      this.options.entry,
      '--profile', this.options.profileName,
      '--patch', overlay.path,
      '--host', LOOPBACK,
      '--port', String(this.options.port),
      ...this.options.noOpen ? ['--no-open'] : [],
    ]

    this.push('stdout', `启动 dsh --profile ${this.options.profileName} --patch <overlay> --host ${LOOPBACK} --port ${String(this.options.port)}${this.options.noOpen ? ' --no-open' : ''}`)
    if (!overlay.panelInjected) {
      this.push('stdout', '未找到桌面面板插件资源（dsh-desktop-shell），本次启动不注入面板。')
    }

    const binDir = this.options.runtimeBinDir
    const child = spawn(process.execPath, args, {
      cwd: bridgeDir(),
      env: nodeModeEnvironment({
        ...proxyEnvironment(this.options.proxy),
        [DSH_BRIDGE_DIR_ENV]: bridgeDir(),
        // A dedicated harness home keeps the shell's runtime away from the user's
        // own `~/.dsh` profile, locks, and node_modules (spike S3).
        ...harnessHome() === undefined ? {} : { DSH_HOME: harnessHome() as string },
        // Make the bundled pnpm/node shims findable: dsh resolves `pnpm` from PATH, and
        // the shims run on this same binary in Node mode.
        ...binDir === undefined ? {} : {
          PATH: `${binDir}${delimiter}${process.env.PATH ?? process.env.Path ?? ''}`,
          DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
        },
        // The shim cannot resolve pnpm by a relative path when the runtime lives in the ASAR.
        ...this.options.pnpmEntry === undefined ? {} : { [DSH_PNPM_ENTRY_ENV]: this.options.pnpmEntry },
      }),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child

    const ready = new Promise<HostReady>((resolve, reject) => {
      let settled = false
      let timer: NodeJS.Timeout
      const finish = (action: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        action()
      }
      timer = setTimeout(() => {
        finish(() => { reject(new Error(`等待 DSH Web 认证地址超时（${String(STARTUP_TIMEOUT_MS / 1000)} 秒）：当前 DSH 可能未启用浏览器会话认证。`)) })
      }, STARTUP_TIMEOUT_MS)

      const handleLine = (stream: 'stdout' | 'stderr', raw: string): void => {
        const line = raw.replace(/\r$/u, '')
        this.push(stream, redactAuthToken(line))
        const authUrl = parseDshWebAuthUrl(line)
        if (authUrl !== undefined) {
          finish(() => {
            resolve({ authUrl: authUrl.href, bareUrl: bareUrl(authUrl), port: this.options.port })
          })
        }
      }

      for (const [stream, pipe] of [['stdout', child.stdout], ['stderr', child.stderr]] as const) {
        pipe?.setEncoding('utf8')
        let pending = ''
        pipe?.on('data', (chunk: string) => {
          pending += chunk
          const lines = pending.split('\n')
          pending = lines.pop() ?? ''
          for (const line of lines) handleLine(stream, line)
        })
        pipe?.on('end', () => { if (pending !== '') handleLine(stream, pending) })
      }

      child.once('error', (error) => { finish(() => { reject(error) }) })
      child.once('close', (code) => {
        if (this.stopped) return
        finish(() => {
          const tail = this.logBuffer.slice(-6).join('\n')
          reject(new Error(`DSH 子进程退出（code ${String(code)}）${tail === '' ? '' : `：\n${tail}`}`))
        })
      })
    })

    return ready
  }

  /** Request termination and await exit, escalating to SIGKILL. */
  async stop(): Promise<void> {
    const child = this.child
    if (child === undefined) return
    this.stopped = true
    const exited = new Promise<void>((resolve) => { child.once('close', () => { resolve() }) })
    child.kill()
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolve) => { setTimeout(() => { resolve(false) }, HOST_EXIT_TIMEOUT_MS) }),
    ])
    if (!graceful) {
      child.kill('SIGKILL')
      await Promise.race([exited, new Promise<void>((resolve) => { setTimeout(resolve, 3_000) })])
    }
    this.child = undefined
  }

  private push(stream: 'stdout' | 'stderr', line: string): void {
    if (line.trim() === '') return
    this.logBuffer.push(`[${stream}] ${line}`)
    if (this.logBuffer.length > 120) this.logBuffer.shift()
    this.options.onLog(stream, line)
  }
}

/** True when the resolved entry exists; callers use it to fail before spawning. */
export function entryExists(entry: string): boolean {
  return existsSync(entry)
}
