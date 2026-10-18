/**
 * Persistent state for the shell's token-usage window (ONE-WAY).
 *
 * The DSH plugin kept the gateway session cookie in a profile-patch setting marked
 * `role('secret')`. The shell owns the window now, so it keeps the same state next to its other
 * local files (`oneway.json` in the bridge directory): the cookie, the gateway address and the
 * refresh interval. Nothing here is sent to DSH or to any third party — only to
 * `https://oneway.eportyun.com` when the window asks for a snapshot.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  DEFAULT_ONEWAY_BASE_URL,
  DEFAULT_USAGE_REFRESH_SECONDS,
  MAX_USAGE_REFRESH_SECONDS,
  MIN_USAGE_REFRESH_SECONDS,
} from './constants.ts'

/** What the usage service needs from the shell: the persisted config, and updates to it. */
export interface UsageConfig {
  readonly baseUrl: string
  readonly refreshSeconds: number
  /** Serialized cookie jar written by the QR login flow. Host-only secret. */
  readonly sessionCookie: string
}

export interface UsageSettings {
  readonly baseUrl: string
  readonly refreshSeconds: number
}

export interface UsageSaveResult {
  readonly ok: boolean
  readonly reason?: string
  readonly settings?: UsageSettings
}

export interface UsageStore {
  get(): UsageConfig
  /** Merge a patch into the persisted config; the file is rewritten atomically. */
  update(patch: Partial<UsageConfig>): void
  settings(): UsageSettings
  /** Validate and persist the two user-editable values. */
  saveSettings(input: { readonly baseUrl?: unknown; readonly refreshSeconds?: unknown }): UsageSaveResult
}

const DEFAULTS: UsageConfig = {
  baseUrl: DEFAULT_ONEWAY_BASE_URL,
  refreshSeconds: DEFAULT_USAGE_REFRESH_SECONDS,
  sessionCookie: '',
}

/** Normalize a user-typed gateway address; undefined when it cannot be a base URL. */
export function normalizeBaseUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().replace(/\/+$/u, '')
  if (trimmed === '') return undefined
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    if (url.pathname !== '/' && url.pathname !== '') return undefined
    return trimmed
  } catch {
    return undefined
  }
}

/** Clamp the refresh interval into the range the gateway can bear. */
export function clampRefreshSeconds(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.round(Math.min(MAX_USAGE_REFRESH_SECONDS, Math.max(MIN_USAGE_REFRESH_SECONDS, value)))
}

/**
 * Read and write `oneway.json`.
 *
 * @param path - Absolute path of the state file.
 * @param log - Shell log sink; a corrupt file is reported and replaced with defaults, never fatal.
 */
export function createUsageStore(path: string, log: (line: string) => void = () => {}): UsageStore {
  let current: UsageConfig = DEFAULTS
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    current = {
      baseUrl: normalizeBaseUrl(raw.baseUrl) ?? DEFAULTS.baseUrl,
      refreshSeconds: clampRefreshSeconds(raw.refreshSeconds) ?? DEFAULTS.refreshSeconds,
      sessionCookie: typeof raw.sessionCookie === 'string' ? raw.sessionCookie : '',
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log(`用量：状态文件读取失败，已用默认值（${String(error)}）`)
  }

  const persist = (next: UsageConfig): void => {
    current = next
    const temporary = `${path}.tmp-${String(process.pid)}`
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, path)
    } catch (error) {
      log(`用量：状态写入失败（${String(error)}）`)
    }
  }

  return {
    get: () => current,
    update: (patch) => {
      persist({
        baseUrl: normalizeBaseUrl(patch.baseUrl ?? current.baseUrl) ?? current.baseUrl,
        refreshSeconds: clampRefreshSeconds(patch.refreshSeconds ?? current.refreshSeconds) ?? current.refreshSeconds,
        sessionCookie: typeof patch.sessionCookie === 'string' ? patch.sessionCookie : current.sessionCookie,
      })
    },
    settings: () => ({ baseUrl: current.baseUrl, refreshSeconds: current.refreshSeconds }),
    saveSettings: (input) => {
      // Reject, do not silently clamp: a typed "5 seconds" must tell the user the allowed range
      // instead of being written as 30 and looking ignored. `update()` still clamps internally for
      // hand-edited files.
      if (input.baseUrl !== undefined && normalizeBaseUrl(input.baseUrl) === undefined) {
        return { ok: false, reason: '网关地址必须是 http(s) 根地址（不带路径）。' }
      }
      if (input.refreshSeconds !== undefined) {
        const value = input.refreshSeconds
        const seconds = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : Number.NaN
        if (!Number.isFinite(seconds) || seconds < MIN_USAGE_REFRESH_SECONDS || seconds > MAX_USAGE_REFRESH_SECONDS) {
          return { ok: false, reason: `刷新间隔必须是 ${String(MIN_USAGE_REFRESH_SECONDS)}–${String(MAX_USAGE_REFRESH_SECONDS)} 秒之间的数字。` }
        }
      }
      const settings: UsageSettings = {
        baseUrl: normalizeBaseUrl(input.baseUrl) ?? current.baseUrl,
        refreshSeconds: clampRefreshSeconds(input.refreshSeconds) ?? current.refreshSeconds,
      }
      persist({ ...current, ...settings })
      return { ok: true, settings }
    },
  }
}
