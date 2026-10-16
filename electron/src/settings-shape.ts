/**
 * Pure transformations of the shell settings document.
 *
 * Separate from `settings.ts` because that module reads `bridgeDir()` from Electron's
 * `app`, and the rules here are the ones worth testing: a default is added only when the
 * user has not chosen a value.
 */

/**
 * Add the channel's default port when the settings have no explicit one.
 *
 * The DSH panel's client half defaults a missing `service.port` to **41729**
 * (`client.js`: `settings.service?.port ?? 41729`) — the release port. So the moment a
 * debug-channel user saved anything on that page, the file gained `service.port: 41729`
 * and the debug app started taking the port the shipping desktop app uses. Writing the
 * channel's own default means the panel's fallback can never fire.
 *
 * @param raw - Parsed settings file contents.
 * @param defaultPort - The channel's default port.
 * @returns The updated record, or `undefined` when nothing needs writing.
 */
export function withServicePort(raw: unknown, defaultPort: number): Record<string, unknown> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const service = typeof record.service === 'object' && record.service !== null
    ? { ...record.service as Record<string, unknown> }
    : {}
  if (typeof service.port === 'number') return undefined
  service.port = defaultPort
  return { ...record, service }
}

/** What the shell's own settings page submits. Every field is optional: absent means "leave it". */
export interface SettingsInput {
  readonly servicePort?: number
  readonly closeBehavior?: 'minimizeToTray' | 'exit'
  readonly proxyEnabled?: boolean
  readonly httpProxy?: string
  readonly httpsProxy?: string
  readonly noProxy?: string
  readonly checkDesktopOnStart?: boolean
  readonly checkDshOnStart?: boolean
  /** Whether the shell offers its self-hosted sidebar browser (and the agent's browser tools). */
  readonly browserEnabled?: boolean
  /** Phone access over the local network: off until the user turns it on. */
  readonly pocketEnabled?: boolean
  readonly pocketPort?: number
  /** Public access through a Cloudflare tunnel; only ever turned on after the disclaimer. */
  readonly pocketTunnelEnabled?: boolean
  readonly pocketTunnelPort?: number
  readonly pocketTunnelMode?: 'quick' | 'named'
  /** The user's own hostname; required for a named tunnel. */
  readonly pocketTunnelDomain?: string
}

/** The public side of phone access, as stored in `shell-settings.json`. */
export interface PocketTunnelSettings {
  readonly enabled: boolean
  readonly port: number
  readonly mode: 'quick' | 'named'
  readonly domain: string
}

/** Phone access settings, as stored in `shell-settings.json`. */
export interface PocketSettings {
  readonly enabled: boolean
  readonly port: number
  readonly tunnel: PocketTunnelSettings
}

/**
 * Port the phone gateway listens on.
 *
 * Deliberately not 41729: that is DSH's own port, and the gateway is a second listener in front of
 * it. Both being configurable is exactly why the collision is validated below instead of trusted.
 */
export const DEFAULT_POCKET_PORT = 41730

/**
 * Port the public listener binds on loopback for the tunnel to reach.
 *
 * Deliberately its own listener rather than a second hostname on the LAN one: arriving on this port
 * means "came through the internet", which is what decides the password, and no header can pretend
 * otherwise.
 */
export const DEFAULT_POCKET_TUNNEL_PORT = 41731

export const DEFAULT_POCKET_SETTINGS: PocketSettings = {
  enabled: false,
  port: DEFAULT_POCKET_PORT,
  tunnel: { enabled: false, port: DEFAULT_POCKET_TUNNEL_PORT, mode: 'quick', domain: '' },
}

export type MergeSettingsResult =
  | { readonly ok: true; readonly document: Record<string, unknown>; readonly changed: readonly string[] }
  | { readonly ok: false; readonly reason: string }

/** Lowest port a user may pick: below this is the privileged range. */
export const MIN_SETTINGS_PORT = 1024
export const MAX_SETTINGS_PORT = 65535

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value as Record<string, unknown> } : {}

const readNumber = (record: Record<string, unknown>, key: string): number | undefined =>
  typeof record[key] === 'number' ? record[key] as number : undefined

const readString = (record: Record<string, unknown>, key: string): string =>
  typeof record[key] === 'string' ? record[key] as string : ''

const readBoolean = (record: Record<string, unknown>, key: string, fallback: boolean): boolean =>
  typeof record[key] === 'boolean' ? record[key] as boolean : fallback

/**
 * Merge a settings-page submission into the document, preserving everything else.
 *
 * The document is shared with the Tauri shell's panel plugin, so unknown keys must survive a
 * round trip: this writes a merged document rather than a freshly built one. Validation lives
 * here so the shell's page and the DSH panel cannot drift apart.
 *
 * @param raw - Parsed `shell-settings.json`, or anything else if it was unreadable.
 * @param input - Fields the page submitted.
 * @param defaultPort - The channel's default port, used when neither side specifies one.
 */
export function mergeSettingsInput(raw: unknown, input: SettingsInput, defaultPort: number): MergeSettingsResult {
  const document = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? { ...raw as Record<string, unknown> }
    : {}

  const service = asRecord(document.service)
  const proxy = asRecord(document.proxy)
  const updates = asRecord(document.updates)
  const browser = asRecord(document.browser)
  const changed: string[] = []

  const nextPort = input.servicePort ?? readNumber(service, 'port') ?? defaultPort
  if (!Number.isInteger(nextPort) || nextPort < MIN_SETTINGS_PORT || nextPort > MAX_SETTINGS_PORT) {
    return { ok: false, reason: `端口必须是 ${String(MIN_SETTINGS_PORT)}–${String(MAX_SETTINGS_PORT)} 之间的整数` }
  }
  if (service.port !== nextPort) {
    service.port = nextPort
    changed.push('service.port')
  }

  if (input.closeBehavior !== undefined) {
    if (input.closeBehavior !== 'minimizeToTray' && input.closeBehavior !== 'exit') {
      return { ok: false, reason: `关闭行为不受支持：${String(input.closeBehavior)}` }
    }
    if (document.closeBehavior !== input.closeBehavior) {
      document.closeBehavior = input.closeBehavior
      changed.push('closeBehavior')
    }
  }

  if (input.proxyEnabled !== undefined && proxy.enabled !== input.proxyEnabled) {
    proxy.enabled = input.proxyEnabled
    changed.push('proxy.enabled')
  }
  // The URLs are kept when the switch is off, so turning it back on restores what was typed.
  for (const [field, submitted] of [
    ['httpProxy', input.httpProxy],
    ['httpsProxy', input.httpsProxy],
    ['noProxy', input.noProxy],
  ] as const) {
    if (submitted === undefined) continue
    const value = submitted.trim()
    if (readString(proxy, field) !== value) {
      proxy[field] = value
      changed.push(`proxy.${field}`)
    }
  }

  for (const [field, submitted] of [
    ['checkDesktopOnStart', input.checkDesktopOnStart],
    ['checkDshOnStart', input.checkDshOnStart],
  ] as const) {
    if (submitted === undefined) continue
    if (readBoolean(updates, field, true) !== submitted) {
      updates[field] = submitted
      changed.push(`updates.${field}`)
    }
  }

  if (input.browserEnabled !== undefined && readBoolean(browser, 'enabled', true) !== input.browserEnabled) {
    browser.enabled = input.browserEnabled
    changed.push('browser.enabled')
  }

  const pocket = asRecord(document.pocket)
  const tunnel = asRecord(pocket.tunnel)
  if (input.pocketTunnelPort !== undefined) {
    const port = input.pocketTunnelPort
    if (!Number.isInteger(port) || port < MIN_SETTINGS_PORT || port > MAX_SETTINGS_PORT) {
      return { ok: false, reason: `公网隧道端口必须是 ${String(MIN_SETTINGS_PORT)}–${String(MAX_SETTINGS_PORT)} 之间的整数` }
    }
    // Three listeners cannot share one port, and the failure would surface as a bind error in the
    // log while the settings page looked fine.
    if (port === nextPort) return { ok: false, reason: '公网隧道端口不能与 DSH 服务端口相同' }
    if (port === readNumber(pocket, 'port')) return { ok: false, reason: '公网隧道端口不能与手机访问端口相同' }
    if (readNumber(tunnel, 'port') !== port) {
      tunnel.port = port
      changed.push('pocket.tunnel.port')
    }
  }
  if (input.pocketTunnelMode !== undefined) {
    if (input.pocketTunnelMode !== 'quick' && input.pocketTunnelMode !== 'named') {
      return { ok: false, reason: `不支持的隧道模式：${String(input.pocketTunnelMode)}` }
    }
    if (readString(tunnel, 'mode') !== input.pocketTunnelMode || tunnel.mode === undefined) {
      tunnel.mode = input.pocketTunnelMode
      changed.push('pocket.tunnel.mode')
    }
  }
  if (input.pocketTunnelDomain !== undefined) {
    const domain = input.pocketTunnelDomain.trim()
    // A named tunnel is a hostname the user owns; refusing nonsense here is cheaper than a tunnel
    // that registers and then has nowhere to answer.
    if (domain !== '' && !/^[a-z0-9.-]+(?:\/[a-z0-9.-]*)?$/iu.test(domain)) {
      return { ok: false, reason: '公网域名只能包含字母、数字、点和连字符' }
    }
    if (readString(tunnel, 'domain') !== domain) {
      tunnel.domain = domain
      changed.push('pocket.tunnel.domain')
    }
  }
  if (input.pocketTunnelEnabled !== undefined && readBoolean(tunnel, 'enabled', false) !== input.pocketTunnelEnabled) {
    tunnel.enabled = input.pocketTunnelEnabled
    changed.push('pocket.tunnel.enabled')
  }
  if (input.pocketPort !== undefined) {
    const port = input.pocketPort
    if (!Number.isInteger(port) || port < MIN_SETTINGS_PORT || port > MAX_SETTINGS_PORT) {
      return { ok: false, reason: `手机访问端口必须是 ${String(MIN_SETTINGS_PORT)}–${String(MAX_SETTINGS_PORT)} 之间的整数` }
    }
    // Two listeners cannot share a port, and the failure would otherwise surface as a bind error
    // buried in the log while the settings page looked fine.
    if (port === nextPort) return { ok: false, reason: '手机访问端口不能与 DSH 服务端口相同' }
    if (readNumber(pocket, 'port') !== port) {
      pocket.port = port
      changed.push('pocket.port')
    }
  }
  if (input.pocketEnabled !== undefined && readBoolean(pocket, 'enabled', false) !== input.pocketEnabled) {
    pocket.enabled = input.pocketEnabled
    changed.push('pocket.enabled')
  }

  if (Object.keys(tunnel).length > 0) pocket.tunnel = tunnel
  const sections = { service, proxy, updates, browser }
  return {
    ok: true,
    // An empty section is left out entirely: a file that never had phone access should not gain a
    // stray `"pocket": {}` just because the page submitted the form.
    document: Object.keys(pocket).length === 0 ? { ...document, ...sections } : { ...document, ...sections, pocket },
    changed,
  }
}
