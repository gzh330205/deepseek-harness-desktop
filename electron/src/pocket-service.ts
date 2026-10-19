/**
 * The phone gateway's lifecycle, owned by the shell's main process.
 *
 * Three rules shape this module, and each one is a bug that would otherwise reach the user:
 *
 * 1. **Applying preferences must be idempotent.** The settings window saves the whole document at
 *    once, so every unrelated save calls `apply()` again. Restarting the listener unconditionally
 *    would drop the phone's connection whenever the user changed, say, the close behaviour — so a
 *    restart happens only when the port actually changed, and a failed start is retried (that is
 *    how a laptop that joins WiFi later recovers without the user touching anything).
 * 2. **Passwords are applied without a restart.** The gateway reads the password through a
 *    callback, so rotating it kills open sessions immediately and needs no new socket.
 * 3. **Switching the feature off signs the phone out.** Otherwise re-enabling it would quietly
 *    restore a session the user believed they had closed.
 */

import { join } from 'node:path'

import { createPocketRateLimiter, createPocketSessions, generatePocketPassword, validatePocketPassword } from './pocket-auth.ts'
import { createPocketGateway, type PocketGateway, type PocketGatewayStats } from './pocket-gateway.ts'
import { createPocketTunnel, type PocketTunnel, type PocketTunnelMode } from './pocket-tunnel.ts'
import { listLanCandidates, type LanCandidate } from './pocket-net.ts'
import { POCKET_STATE_FILENAME, readPocketState, writePocketState, writePocketTunnelRecord, type PocketState, type PocketTunnelRecord } from './pocket-state.ts'
import { DEFAULT_POCKET_SETTINGS, DEFAULT_POCKET_PORT, type PocketSettings } from './settings-shape.ts'

/** Phone access preferences, shared with the settings document's shape. */
export type PocketPreferences = PocketSettings

// Re-exported: the default port is part of this module's contract for callers that only build the
// service (and for the settings page, which shows it as the placeholder).
export { DEFAULT_POCKET_PORT }

/** The public side, as the settings page renders it. */
export interface PocketPublicStatus {
  /** What the user asked for (the settings document). */
  readonly enabled: boolean
  /** Whether the tunnel is up. */
  readonly running: boolean
  readonly mode: PocketTunnelMode
  readonly domain: string
  /** The bound port of the loopback listener the tunnel forwards to. */
  readonly port: number
  readonly url?: string
  readonly password: string
  /** Whether the password is fixed by the user (so it does not rotate on every start). */
  readonly customPassword: boolean
  /** Named tunnels need a token before they can start. */
  readonly hasToken: boolean
  /** Whether the bundled binary was found at all. */
  readonly available: boolean
  readonly error?: string
}

export interface PocketStatus {
  /** What the user asked for. */
  readonly enabled: boolean
  /** Whether a listener is actually up. */
  readonly running: boolean
  /** The configured port; not the bound one when a caller asked for 0. */
  readonly port: number
  readonly password: string
  readonly candidates: readonly LanCandidate[]
  readonly url?: string
  readonly address?: string
  /** Address the user pinned in the settings dropdown, when automatic selection was wrong. */
  readonly selected?: string
  /** Why it is not running, when the user asked for it to be. */
  readonly error?: string
  readonly stats?: PocketGatewayStats
  /** Public access state; always present so the page never has to guess. */
  readonly publicAccess: PocketPublicStatus
}

export type PocketPasswordResult =
  | { readonly ok: true; readonly status: PocketStatus }
  | { readonly ok: false; readonly reason: string }

export interface PocketServiceOptions {
  /** Directory holding the shell's own state (`bridgeDir()`). */
  readonly bridgeDir: string
  /**
   * DSH's loopback address; never anything else.
   *
   * A function because the port is only known once the host has started — and the settings window
   * can create this service before that happens.
   */
  readonly upstream: () => { readonly host: string; readonly port: number }
  /** The `name=value` DSH cookie the shell keeps for itself, read fresh per request. */
  readonly dshCookie: () => string | undefined
  readonly log: (line: string) => void
  /**
   * The bundled cloudflared.
   *
   * Absent means public access is unavailable here (the caller could not resolve the binary), which is
   * reported instead of attempted.
   */
  readonly tunnelBinary?: string
  /** Tunnel factory; injected by tests so the service's own logic is what gets exercised. */
  readonly createTunnel?: (options: Parameters<typeof createPocketTunnel>[0]) => PocketTunnel
  /** Address candidates; injected for tests. */
  readonly candidates?: () => readonly LanCandidate[]
  /** Password source; injected for tests. */
  readonly generate?: () => string
}

export interface PocketService {
  status(): PocketStatus
  /** Bring the listener in line with the preferences; safe to call on every settings save. */
  apply(preferences: PocketPreferences): Promise<PocketStatus>
  /** Pin one of the candidate addresses, or `''` to go back to the automatic choice. */
  select(address: string): Promise<PocketStatus>
  rotatePassword(): PocketStatus
  setPassword(value: string): PocketPasswordResult
  /**
   * Open public access.
   *
   * @param options - `acceptedDisclaimer` must be true: it is the only thing that makes the records
   *   say "the user agreed to this", which is also what a later restart is allowed to restore.
   */
  startTunnel(options: { readonly acceptedDisclaimer: boolean }): Promise<PocketStatus>
  /**
   * Close public access and withdraw the acknowledgement, so a restart cannot reopen it.
   *
   * What it took to connect (mode, hostname, Tunnel Token) is kept: closing the door is not
   * forgetting the key, and asking for the token again on every close would be its own bug.
   */
  stopTunnel(): Promise<PocketStatus>
  /** Restart a tunnel a previous run had open and the user had accepted. */
  restoreTunnel(): Promise<PocketStatus>
  rotatePublicPassword(): PocketStatus
  setPublicPassword(value: string): PocketPasswordResult
  /**
   * Store the named-tunnel token; it never enters the settings document.
   *
   * A blank value means "leave it as it is", which is what the page's placeholder promises — a user
   * who reopens the window must not have to go back to Cloudflare for the same credential.
   */
  setTunnelToken(value: string): PocketStatus
  dispose(): Promise<void>
}

export function createPocketService(options: PocketServiceOptions): PocketService {
  const statePath = join(options.bridgeDir, POCKET_STATE_FILENAME)
  const generate = options.generate ?? generatePocketPassword
  const initial = readPocketState(statePath, generate)
  if (initial.generated) options.log('pocket: 已生成手机访问密码（在「设置 → 手机访问」里查看）')
  let state: PocketState = initial.state

  const sessions = createPocketSessions()
  // One limiter for the whole process: stopping and starting the listener must not hand an
  // attacker a fresh set of attempts.
  const limiter = createPocketRateLimiter()
  const candidatesOf = options.candidates ?? ((): readonly LanCandidate[] => listLanCandidates())

  let gateway: PocketGateway | undefined
  let preferences: PocketPreferences = DEFAULT_POCKET_SETTINGS
  let lastError: string | undefined

  const persist = (next: PocketState): void => {
    state = next
    try {
      writePocketState(statePath, state)
    } catch (error) {
      // The password in memory still works for this run; losing the file only means a new one next
      // time, which is a far smaller problem than refusing to run.
      options.log(`pocket: 状态文件写入失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const stop = async (signOut: boolean): Promise<void> => {
    const running = gateway
    gateway = undefined
    if (running !== undefined) {
      try {
        await running.close()
      } catch (error) {
        options.log(`pocket: 停止网关时出错：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // A session must not survive the switch being turned off and on again.
    if (signOut) sessions.rotate()
  }

  const start = async (): Promise<void> => {
    const list = candidatesOf()
    const pinned = state.address
    const wanted = pinned !== undefined && list.some(candidate => candidate.address === pinned)
      ? pinned
      : list[0]?.address
    if (wanted === undefined) {
      lastError = '没有找到可用的局域网地址：请确认电脑已连上 WiFi 或网线'
      options.log(`pocket: ${lastError}`)
      return
    }
    gateway = await createPocketGateway({
      scope: 'lan',
      upstream: options.upstream(),
      listenAddress: wanted,
      port: preferences.port,
      // Every address of this machine is allowed, not just the bound one: a laptop that switches
      // networks should keep working without the user noticing.
      allowedHosts: [wanted, ...list.map(candidate => candidate.address)],
      dshCookie: options.dshCookie,
      password: () => state.lan.password,
      sessions,
      limiter,
      log: options.log,
    })
    lastError = undefined
  }

  const restart = async (): Promise<void> => {
    await stop(false)
    try {
      await start()
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      await stop(false)
      options.log(`pocket: 启动失败：${lastError}`)
    }
  }

  // --- the public door ----------------------------------------------------------------------
  //
  // A second listener on loopback, plus the tunnel that publishes it. Separate sessions and a
  // separate failure lock: a session earned on the LAN must not open the internet-facing door, and
  // one attacker guessing on the internet must not lock the owner out of the sofa.
  let publicGateway: PocketGateway | undefined
  let tunnel: PocketTunnel | undefined
  let tunnelError: string | undefined
  const publicSessions = createPocketSessions()
  const publicLimiter = createPocketRateLimiter()

  const persistTunnel = (record: PocketTunnelRecord | undefined): void => {
    try {
      writePocketTunnelRecord(statePath, record)
    } catch (error) {
      options.log(`pocket: 隧道状态写入失败：${error instanceof Error ? error.message : String(error)}`)
    }
    if (record === undefined) {
      const { tunnel: _forgotten, ...rest } = state
      state = rest
    } else {
      state = { ...state, tunnel: record }
    }
  }

  /**
   * Withdraw "the user agreed to this", keeping everything else the record knows.
   *
   * A restart only restores a tunnel whose acknowledgement is still `true`, so this is what makes a
   * user-requested close (or a failed start) stick. The token, the mode and the hostname stay on
   * disk: forgetting the whole record would also throw away a credential the user would have to copy
   * out of Cloudflare again.
   */
  const revokeTunnelAcceptance = (): void => {
    const record = state.tunnel
    if (record === undefined || record.accepted !== true) return
    // `mode` follows the settings, because that is what the next attempt would use; the token and
    // the hostname are whatever was stored, because those are the parts that are expensive to lose.
    persistTunnel({ ...record, mode: preferences.tunnel.mode, accepted: false })
  }

  const publicPassword = (): string => {
    const existing = state.public
    if (existing !== undefined) return existing.password
    const password = generate()
    persist({ ...state, public: { password, custom: false } })
    return password
  }

  const tunnelStatus = () => tunnel?.status() ?? { running: false, mode: preferences.tunnel.mode } as const

  const publicStatus = (): PocketPublicStatus => ({
    enabled: preferences.tunnel.enabled,
    running: tunnelStatus().running === true && publicGateway !== undefined,
    mode: preferences.tunnel.mode,
    domain: preferences.tunnel.domain,
    // The bound port, not the configured one: a configured 0 means the system chose, and the tunnel
    // has to forward to what was actually bound.
    port: publicGateway?.port ?? preferences.tunnel.port,
    password: publicPassword(),
    customPassword: state.public?.custom === true,
    hasToken: (state.tunnel?.token ?? '') !== '',
    available: options.tunnelBinary !== undefined,
    ...(tunnelStatus().url === undefined ? {} : { url: tunnelStatus().url }),
    ...(tunnelError === undefined ? {} : { error: tunnelError }),
  })

  const stopPublic = async (revokeAcceptance: boolean): Promise<void> => {
    if (tunnel !== undefined) {
      await tunnel.stop()
      tunnel = undefined
    }
    if (publicGateway !== undefined) {
      await publicGateway.close()
      publicGateway = undefined
    }
    // Everyone signed in through the public door is signed out.
    publicSessions.rotate()
    tunnelError = undefined
    // Stopping the listener is not the same as forgetting how to start it again: only the
    // acknowledgement is withdrawn, never the token.
    if (revokeAcceptance) revokeTunnelAcceptance()
  }

  /**
   * Open the public door.
   *
   * @param accepted - Whether this start carries the disclaimer acknowledgement.
   * @param keepAcceptanceOnFailure - Keep `accepted` when the tunnel does not come up. A *restore* at
   *   startup uses this: a transient network/proxy failure at boot must not silently disable the
   *   "reopen what was open" promise, while a user-requested start still withdraws it on failure so
   *   a broken configuration is not retried behind their back.
   */
  const startPublic = async (accepted: boolean, keepAcceptanceOnFailure = false): Promise<void> => {
    tunnelError = undefined
    if (options.tunnelBinary === undefined) {
      tunnelError = '找不到随包的隧道程序（cloudflared），公网访问不可用'
      return
    }
    const mode = preferences.tunnel.mode
    const domain = preferences.tunnel.domain
    const token = state.tunnel?.token ?? ''
    if (mode === 'named' && (token === '' || domain === '')) {
      tunnelError = '命名隧道需要先填好公网域名与 Tunnel Token'
      return
    }
    // A quick tunnel gets a new random hostname on every start, so its password rotates with it: an
    // address somebody saw yesterday is worth nothing today. A named tunnel is fixed, so its password
    // is only rotated when the user asks.
    if (state.public?.custom !== true && mode === 'quick') {
      persist({ ...state, public: { password: generate(), custom: false } })
    }
    try {
      publicGateway = await createPocketGateway({
        scope: 'public',
        upstream: options.upstream(),
        // Loopback only: the tunnel is the only thing that may reach this door, which is what makes
        // "arrived here" mean "came from the internet" without trusting a single header.
        listenAddress: '127.0.0.1',
        port: preferences.tunnel.port,
        allowedHosts: ['127.0.0.1', 'localhost'],
        dshCookie: options.dshCookie,
        password: publicPassword,
        sessions: publicSessions,
        limiter: publicLimiter,
        log: options.log,
      })
    } catch (error) {
      tunnelError = `公网监听器启动失败：${error instanceof Error ? error.message : String(error)}`
      options.log(`pocket: ${tunnelError}`)
      return
    }

    const makeTunnel = options.createTunnel ?? createPocketTunnel
    tunnel = makeTunnel({
      binary: options.tunnelBinary,
      originPort: publicGateway.port,
      log: options.log,
    })
    const started = await tunnel.start(mode === 'named' ? { mode, token, domain } : { mode: 'quick' })
    if (!started.running) {
      const message = started.error ?? '公网隧道没有起来'
      // A failed start still means "not open": withdraw the acknowledgement so a restart does not
      // silently retry, but keep the token so the next attempt does not need it typed again.
      // A failed *restore* keeps the acknowledgement instead (see `startPublic`): the user left it
      // open, and one bad boot should not stop the next one from trying.
      // `stopPublic` clears the error on the way out, so the reason is put back afterwards — "没开成"
      // without a reason is the one state the page cannot explain.
      await stopPublic(!keepAcceptanceOnFailure)
      tunnelError = message
      return
    }
    persistTunnel({
      mode,
      accepted,
      ...(domain === '' ? {} : { domain }),
      ...(token === '' ? {} : { token }),
    })
  }

  const status = (): PocketStatus => ({
    enabled: preferences.enabled,
    running: gateway !== undefined,
    port: preferences.port,
    password: state.lan.password,
    candidates: candidatesOf(),
    ...(gateway === undefined ? {} : { url: gateway.url, address: gateway.address, stats: gateway.stats() }),
    ...(state.address === undefined ? {} : { selected: state.address }),
    ...(lastError === undefined ? {} : { error: lastError }),
    publicAccess: publicStatus(),
  })

  return {
    status,
    async apply(next) {
      const portChanged = next.port !== preferences.port
      // The tunnel half is not applied here on purpose: starting public access needs the disclaimer,
      // so it goes through `startTunnel`. `apply` only ever brings the LAN listener in line, because
      // it runs on every settings save.
      preferences = { ...preferences, enabled: next.enabled, port: next.port, tunnel: next.tunnel }
      if (!next.enabled) {
        if (gateway !== undefined) await stop(true)
        return status()
      }
      // A retry when nothing is running is deliberate: the usual reason is "no LAN address yet",
      // and the next settings save after joining a network should fix it by itself.
      if (gateway === undefined) await restart()
      else if (portChanged) await restart()
      return status()
    },
    async select(address) {
      persist(address === '' ? { version: state.version, lan: state.lan } : { ...state, address })
      if (preferences.enabled) await restart()
      return status()
    },
    rotatePassword() {
      persist({ ...state, lan: { password: generate() } })
      sessions.rotate()
      return status()
    },
    setPassword(value) {
      const reason = validatePocketPassword(value)
      if (reason !== undefined) return { ok: false, reason }
      persist({ ...state, lan: { password: value } })
      sessions.rotate()
      return { ok: true, status: status() }
    },
    async startTunnel({ acceptedDisclaimer }) {
      if (!acceptedDisclaimer) {
        // Refused, not silently allowed: the acknowledgement is the whole reason the switch is not a
        // single mis-tap away from exposing this machine to the internet.
        tunnelError = '开启公网访问前需要先确认免责声明'
        return status()
      }
      await stopPublic(false)
      await startPublic(true)
      return status()
    },
    async stopTunnel() {
      await stopPublic(true)
      return status()
    },
    async restoreTunnel() {
      if (!preferences.tunnel.enabled) return status()
      if (state.tunnel?.accepted !== true) return status()
      if (tunnelStatus().running) return status()
      await startPublic(true, true)
      return status()
    },
    rotatePublicPassword() {
      persist({ ...state, public: { password: generate(), custom: false } })
      publicSessions.rotate()
      return status()
    },
    setPublicPassword(value) {
      const reason = validatePocketPassword(value)
      if (reason !== undefined) return { ok: false, reason }
      persist({ ...state, public: { password: value, custom: true } })
      publicSessions.rotate()
      return { ok: true, status: status() }
    },
    setTunnelToken(value) {
      const token = value.trim()
      // Blank means "leave it": the page's placeholder promises exactly that, and a user who opens
      // the window again must not have to fetch the same credential from Cloudflare.
      const effective = token === '' ? (state.tunnel?.token ?? '') : token
      persistTunnel({
        mode: preferences.tunnel.mode,
        accepted: state.tunnel?.accepted === true,
        ...(preferences.tunnel.domain === '' ? {} : { domain: preferences.tunnel.domain }),
        ...(effective === '' ? {} : { token: effective }),
      })
      return status()
    },
    async dispose() {
      await stop(false)
      // Quitting is not the user closing public access. Keep the record (the acknowledgement
      // included), so the next start can restore the tunnel they had open.
      await stopPublic(false)
    },
  }
}
