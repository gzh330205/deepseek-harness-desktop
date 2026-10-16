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
import { listLanCandidates, type LanCandidate } from './pocket-net.ts'
import { POCKET_STATE_FILENAME, readPocketState, writePocketState, type PocketState } from './pocket-state.ts'
import { DEFAULT_POCKET_PORT, type PocketSettings } from './settings-shape.ts'

/** Phone access preferences, shared with the settings document's shape. */
export type PocketPreferences = PocketSettings

// Re-exported: the default port is part of this module's contract for callers that only build the
// service (and for the settings page, which shows it as the placeholder).
export { DEFAULT_POCKET_PORT }

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
  let preferences: PocketPreferences = { enabled: false, port: DEFAULT_POCKET_PORT }
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

  const status = (): PocketStatus => ({
    enabled: preferences.enabled,
    running: gateway !== undefined,
    port: preferences.port,
    password: state.lan.password,
    candidates: candidatesOf(),
    ...(gateway === undefined ? {} : { url: gateway.url, address: gateway.address, stats: gateway.stats() }),
    ...(state.address === undefined ? {} : { selected: state.address }),
    ...(lastError === undefined ? {} : { error: lastError }),
  })

  return {
    status,
    async apply(next) {
      const portChanged = next.port !== preferences.port
      preferences = { enabled: next.enabled, port: next.port }
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
    async dispose() {
      await stop(true)
    },
  }
}
