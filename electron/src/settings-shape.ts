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

  return { ok: true, document: { ...document, service, proxy, updates }, changed }
}
