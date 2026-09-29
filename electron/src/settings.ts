/**
 * Shell settings, read from the same `shell-settings.json` the Tauri shell writes.
 *
 * Only the fields the Electron shell needs for P0 are interpreted; unknown fields
 * are preserved so a later version can pick them up without a migration step.
 */

import { readFileSync, writeFileSync } from 'node:fs'

import { SHELL_SETTINGS_FILENAME } from './constants.ts'
import { withServicePort } from './settings-shape.ts'
import { bridgeDir } from './paths.ts'
import { join } from 'node:path'

export interface ManagedProxy {
  readonly enabled: boolean
  readonly httpProxy: string
  readonly httpsProxy: string
  readonly noProxy: string
}

export interface UpdatePreferences {
  readonly checkDesktopOnStart: boolean
  /** Reserved: the Electron shell has no separate DSH update check yet. */
  readonly checkDshOnStart: boolean
}

export interface ShellSettings {
  readonly servicePort?: number
  /** `minimizeToTray` hides the window; `exit` quits. Matches the panel plugin's schema. */
  readonly closeBehavior: 'minimizeToTray' | 'exit'
  readonly proxy: ManagedProxy
  readonly updates: UpdatePreferences
}

export const EMPTY_PROXY: ManagedProxy = { enabled: false, httpProxy: '', httpsProxy: '', noProxy: '' }
export const DEFAULT_UPDATE_PREFERENCES: UpdatePreferences = { checkDesktopOnStart: true, checkDshOnStart: true }

/** Environment variables a managed proxy owns; cleared when the switch is off. */
export const MANAGED_PROXY_ENV = [
  'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy', 'ALL_PROXY', 'all_proxy',
] as const

/**
 * Read settings, tolerating every failure: a broken file must not block startup.
 */
export function readShellSettings(): ShellSettings {
  const path = join(bridgeDir(), SHELL_SETTINGS_FILENAME)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { closeBehavior: 'minimizeToTray', proxy: EMPTY_PROXY, updates: DEFAULT_UPDATE_PREFERENCES }
  }
  if (typeof raw !== 'object' || raw === null) {
    return { closeBehavior: 'minimizeToTray', proxy: EMPTY_PROXY, updates: DEFAULT_UPDATE_PREFERENCES }
  }
  const record = raw as Record<string, unknown>
  const service = typeof record.service === 'object' && record.service !== null ? record.service as Record<string, unknown> : {}
  const proxyRecord = typeof record.proxy === 'object' && record.proxy !== null ? record.proxy as Record<string, unknown> : {}
  const updatesRecord = typeof record.updates === 'object' && record.updates !== null ? record.updates as Record<string, unknown> : {}
  const port = typeof service.port === 'number' ? service.port : undefined
  // `tray` was the pre-P2 spelling in this shell; the panel plugin writes
  // `minimizeToTray` and both must keep working.
  const closeBehavior = record.closeBehavior === 'minimizeToTray' || record.closeBehavior === 'tray'
    ? 'minimizeToTray'
    : 'exit'
  return {
    ...(port === undefined ? {} : { servicePort: port }),
    closeBehavior,
    proxy: {
      enabled: proxyRecord.enabled === true,
      httpProxy: typeof proxyRecord.httpProxy === 'string' ? proxyRecord.httpProxy : '',
      httpsProxy: typeof proxyRecord.httpsProxy === 'string' ? proxyRecord.httpsProxy : '',
      noProxy: typeof proxyRecord.noProxy === 'string' ? proxyRecord.noProxy : '',
    },
    updates: {
      checkDesktopOnStart: updatesRecord.checkDesktopOnStart !== false,
      checkDshOnStart: updatesRecord.checkDshOnStart !== false,
    },
  }
}

// Re-exported so callers keep a single import site for the settings document.
export { withServicePort }

/**
 * Materialise the channel's default port into the settings file when it has none.
 *
 * The DSH panel's client half defaults a missing `service.port` to **41729**
 * (`client.js`: `settings.service?.port ?? 41729`) — the release port. So the moment a
 * debug-channel user saved anything on that page, the file gained `service.port: 41729`
 * and the debug app started taking the port the shipping desktop app uses.
 *
 * Writing the channel's own default means the panel's fallback can never fire, and the
 * loader and the settings UI always agree on the port.
 *
 * @param defaultPort - The channel's default port.
 * @returns Whether the file was written.
 */
export function ensureServicePort(defaultPort: number): boolean {
  const path = join(bridgeDir(), SHELL_SETTINGS_FILENAME)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // No settings file yet: the panel writes a full default set on first save, and until
    // then the loader's channel default applies anyway.
    return false
  }
  const updated = withServicePort(raw, defaultPort)
  if (updated === undefined) return false
  try {
    // Revision is deliberately untouched: no user-visible value changed, so a panel draft
    // must not be invalidated by this.
    writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * Proxy environment for the managed child. Disabled means every managed variable is
 * cleared, so a switch-off cannot silently inherit the parent's proxy.
 */
export function proxyEnvironment(proxy: ManagedProxy): NodeJS.ProcessEnv {
  if (!proxy.enabled) {
    const cleared: NodeJS.ProcessEnv = {}
    for (const key of MANAGED_PROXY_ENV) cleared[key] = undefined
    return cleared
  }
  return {
    HTTP_PROXY: proxy.httpProxy,
    http_proxy: proxy.httpProxy,
    HTTPS_PROXY: proxy.httpsProxy,
    https_proxy: proxy.httpsProxy,
    NO_PROXY: proxy.noProxy,
    no_proxy: proxy.noProxy,
  }
}

/** Human-readable description for logs; never includes credentials beyond the origin. */
export function describeProxy(proxy: ManagedProxy): string {
  if (!proxy.enabled) return '未启用'
  return `${proxy.httpsProxy === '' ? proxy.httpProxy : proxy.httpsProxy}${proxy.noProxy === '' ? '' : `（no_proxy=${proxy.noProxy}）`}`
}
