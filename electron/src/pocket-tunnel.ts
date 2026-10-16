/**
 * The public side of phone access: running `cloudflared` and knowing where it published us.
 *
 * The binary is bundled (see `cloudflared-pin.json` and `scripts/prepare-cloudflared.mjs`), so this
 * module never downloads or locates anything on the network — it starts a process, reads the URL the
 * tunnel announced, and can stop it again.
 *
 * Two shapes of tunnel, and they behave differently enough to be worth naming:
 *
 * - **quick** (`tunnel --url …`): Cloudflare hands out a random `*.trycloudflare.com` hostname that
 *   changes on every start — a rotating address for free, and nothing to configure.
 * - **named** (`tunnel run --token …`): the user's own hostname, fixed across restarts, which is why
 *   the password stops rotating in that mode (a fixed address plus a fresh password every start would
 *   be worse than either alone).
 *
 * The child process must never outlive the shell: an orphaned `cloudflared` is an open door to this
 * machine that nobody is watching, so `stop()` kills the process **tree** and the caller disposes it
 * on quit.
 */

import { spawn, type ChildProcess } from 'node:child_process'

export type PocketTunnelMode = 'quick' | 'named'

export interface PocketTunnelRequest {
  readonly mode: PocketTunnelMode
  /** Required for `named`: the Cloudflare Tunnel token. */
  readonly token?: string
  /** Required for `named`: the hostname the tunnel answers on. */
  readonly domain?: string
}

export interface PocketTunnelStatus {
  readonly running: boolean
  readonly mode: PocketTunnelMode
  /** The public address, once the tunnel has announced one. */
  readonly url?: string
  /** Why it is not running, in words the settings page can show. */
  readonly error?: string
}

/** What the module needs to start a binary; the default is the bundled cloudflared. */
export interface PocketTunnelCommand {
  readonly file: string
  readonly args: readonly string[]
  /** Extra environment; the named tunnel's token travels here, never on the command line. */
  readonly env?: Readonly<Record<string, string>>
}

export interface PocketTunnelOptions {
  /** Absolute path of the bundled cloudflared. */
  readonly binary: string
  /** The loopback listener the tunnel forwards to (the public-scope gateway). */
  readonly originPort: number
  readonly log: (line: string) => void
  /** How long to wait for the tunnel to announce its address. */
  readonly readyTimeoutMs?: number
  /** Test seam: build the command instead of running cloudflared itself. */
  readonly command?: (request: PocketTunnelRequest) => PocketTunnelCommand
  readonly spawnProcess?: typeof spawn
}

export interface PocketTunnel {
  start(request: PocketTunnelRequest): Promise<PocketTunnelStatus>
  stop(): Promise<void>
  status(): PocketTunnelStatus
}

/** Quick tunnels publish a random hostname; this is the only line of output that carries it. */
const QUICK_URL = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/iu

/** A named tunnel is ready when Cloudflare says a connection registered. */
const REGISTERED = /Registered tunnel connection|Connection [0-9a-f-]+ registered/iu

/**
 * Find the public address in whatever cloudflared printed.
 *
 * @param text - Accumulated stdout/stderr.
 * @returns The URL, or undefined while there is nothing to find.
 */
export function parseTunnelUrl(text: string): string | undefined {
  const match = QUICK_URL.exec(text)
  return match === null ? undefined : match[0]
}

/**
 * The command line for one tunnel.
 *
 * Exported because the token's travel route is worth asserting: it goes through the environment, and
 * a command line is visible to every other process on the machine.
 *
 * @param options - Binary and the loopback origin.
 * @param request - Which tunnel to open.
 * @returns File, arguments and extra environment.
 */
export function tunnelCommand(
  options: { readonly binary: string; readonly originPort: number },
  request: PocketTunnelRequest,
): PocketTunnelCommand {
  if (request.mode === 'named') {
    return { file: options.binary, args: ['tunnel', 'run'], env: { TUNNEL_TOKEN: request.token ?? '' } }
  }
  // `--no-autoupdate`: this binary is pinned and verified by the build, and a tunnel that replaces
  // itself under the user's feet would break the pin silently.
  return {
    file: options.binary,
    args: ['tunnel', '--url', `http://127.0.0.1:${String(options.originPort)}`, '--no-autoupdate'],
  }
}

/**
 * Start and stop one tunnel.
 *
 * @param options - Binary, origin port, logging and the test seam.
 * @returns The tunnel handle.
 */
export function createPocketTunnel(options: PocketTunnelOptions): PocketTunnel {
  const readyTimeoutMs = options.readyTimeoutMs ?? 45_000
  const spawnProcess = options.spawnProcess ?? spawn
  let child: ChildProcess | undefined
  let current: PocketTunnelStatus = { running: false, mode: 'quick' }

  const commandFor = (request: PocketTunnelRequest): PocketTunnelCommand =>
    options.command?.(request) ?? tunnelCommand({ binary: options.binary, originPort: options.originPort }, request)

  const stopChild = async (): Promise<void> => {
    const running = child
    child = undefined
    if (running === undefined || running.pid === undefined) return
    await new Promise<void>(resolve => {
      const done = (): void => { resolve() }
      running.once('exit', done)
      if (process.platform === 'win32') {
        // The tree: cloudflared spawns helper processes, and killing only the parent leaves the
        // tunnel's data plane alive.
        spawn('taskkill', ['/pid', String(running.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
          .once('exit', () => { setTimeout(done, 200) })
          .once('error', () => { done() })
        return
      }
      running.kill('SIGTERM')
      setTimeout(() => { running.kill('SIGKILL'); done() }, 2_000)
    })
  }

  return {
    async start(request) {
      await stopChild()
      const command = commandFor(request)
      options.log(`pocket: 正在启动公网隧道（${request.mode === 'named' ? '命名隧道' : '快速隧道'}）`)
      const started = spawnProcess(command.file, [...command.args], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: command.env === undefined ? process.env : { ...process.env, ...command.env },
      })
      child = started
      current = { running: false, mode: request.mode }

      const url = await new Promise<string | undefined>((resolve) => {
        let text = ''
        let settled = false
        const finish = (value: string | undefined): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(value)
        }
        // A timeout is a failure, full stop: reporting success because *something* was printed is how
        // a tunnel that never registered looks healthy until the user tries it from outside.
        const timer = setTimeout(() => { finish(undefined) }, readyTimeoutMs)
        const onData = (chunk: Buffer): void => {
          // cloudflared's output is read for the announcement and then dropped: it can echo the
          // Tunnel Token back at us on a bad token, and the shell log is written to disk.
          text += chunk.toString('utf8')
          if (request.mode === 'quick') {
            const found = parseTunnelUrl(text)
            if (found !== undefined) finish(found)
            return
          }
          if (REGISTERED.test(text)) finish('named')
        }
        started.stdout?.on('data', onData)
        started.stderr?.on('data', onData)
        started.once('error', error => {
          options.log(`pocket: cloudflared 启动失败：${error.message}`)
          finish(undefined)
        })
        started.once('exit', code => {
          options.log(`pocket: cloudflared 退出（code ${String(code ?? 0)}）`)
          finish(undefined)
        })
      })

      if (url === undefined) {
        await stopChild()
        current = {
          running: false,
          mode: request.mode,
          error: request.mode === 'quick'
            ? '隧道没有在预期时间内就绪（检查网络，或本机的代理/VPN 是否拦了隧道）'
            : '命名隧道没有连上（检查 Tunnel Token 与域名，或本机代理/VPN）',
        }
        options.log(`pocket: ${current.error}`)
        return current
      }

      current = {
        running: true,
        mode: request.mode,
        url: url === 'named' ? `https://${request.domain ?? ''}/` : url,
      }
      options.log(`pocket: 公网隧道已就绪 ${current.url ?? ''}`)
      return current
    },
    async stop() {
      await stopChild()
      current = { running: false, mode: current.mode }
      options.log('pocket: 公网隧道已停止')
    },
    status() {
      return current
    },
  }
}
