/**
 * Diagnostics a user can hand over when something breaks.
 *
 * Today a failure leaves almost nothing behind: the log lives in memory and dies with the
 * process, `desktop-facts.json` is only written once the service is ready, and the settings
 * file is the one place a proxy password would leak from. This module builds a single
 * report — versions, state, redacted settings, the runtime manifest and the log tail — and
 * the shell exports it from the menu.
 *
 * Redaction is the reason this is a module with tests rather than inline code: proxy URLs
 * routinely carry `user:password@`, and a support bundle people are asked to attach must
 * never be the thing that leaks credentials.
 */

/** Everything the shell knows, injected so the shape can be tested. */
export interface SupportInput {
  readonly desktopVersion: string
  readonly channel: string
  readonly packaged: boolean
  readonly platform: string
  readonly arch: string
  readonly electron: string
  readonly node: string
  readonly v8: string
  readonly osRelease: string
  readonly userData: string
  readonly dshHome: string | null
  readonly settings: unknown
  readonly status: unknown
  readonly runtime: unknown
  readonly profile: unknown
  readonly profileInstall: unknown
  readonly window: unknown
  readonly legacyInstalls: unknown
  readonly logs: readonly string[]
}

export interface SupportBundle {
  readonly schema: number
  readonly generatedAt: string
  readonly shell: {
    readonly desktopVersion: string
    readonly channel: string
    readonly packaged: boolean
    readonly platform: string
    readonly arch: string
    readonly electron: string
    readonly node: string
    readonly v8: string
    readonly osRelease: string
  }
  readonly paths: { readonly userData: string; readonly dshHome: string | null }
  readonly settings: unknown
  readonly status: unknown
  readonly runtime: unknown
  readonly profile: unknown
  readonly profileInstall: unknown
  readonly window: unknown
  readonly legacyInstalls: unknown
  readonly logs: readonly string[]
}

/**
 * Strip credentials from a proxy URL without otherwise touching it.
 *
 * `http://user:secret@127.0.0.1:7890` becomes `http://***@127.0.0.1:7890`. Going through
 * `new URL().toString()` would also normalise the value (`…:7890` → `…:7890/`), and a
 * support bundle that rewrites the user's configuration invites the wrong conclusion, so
 * only the userinfo is replaced.
 *
 * A value with no scheme but with `@` is ambiguous: it is thrown away rather than guessed
 * at. Everything else is echoed, because a scheme-less `host:port` cannot carry userinfo.
 *
 * @param value - Proxy URL from the settings file.
 */
export function redactProxyUrl(value: unknown): unknown {
  if (typeof value !== 'string' || value === '') return value
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//iu.test(value)
  if (withScheme) return value.replace(/^([a-z][a-z\d+.-]*:\/\/)[^/@]*@/iu, '$1***@')
  return value.includes('@') ? '***' : value
}

/** Redact the credentials in every proxy field of a settings document. */
export function redactSettings(settings: unknown): unknown {
  if (typeof settings !== 'object' || settings === null) return settings
  const record = settings as Record<string, unknown>
  const proxy = record.proxy
  if (typeof proxy !== 'object' || proxy === null) return settings
  const proxyRecord = proxy as Record<string, unknown>
  return {
    ...record,
    proxy: {
      ...proxyRecord,
      httpsProxy: redactProxyUrl(proxyRecord.httpsProxy),
      httpProxy: redactProxyUrl(proxyRecord.httpProxy),
      // `noProxy` is a host list, not a URL with credentials, but it is cheap to be sure.
      noProxy: redactProxyUrl(proxyRecord.noProxy),
    },
  }
}

export function buildSupportBundle(input: SupportInput, now = new Date()): SupportBundle {
  return {
    schema: 1,
    generatedAt: now.toISOString(),
    shell: {
      desktopVersion: input.desktopVersion,
      channel: input.channel,
      packaged: input.packaged,
      platform: input.platform,
      arch: input.arch,
      electron: input.electron,
      node: input.node,
      v8: input.v8,
      osRelease: input.osRelease,
    },
    paths: { userData: input.userData, dshHome: input.dshHome },
    settings: redactSettings(input.settings),
    status: input.status,
    runtime: input.runtime,
    profile: input.profile,
    profileInstall: input.profileInstall,
    window: input.window,
    legacyInstalls: input.legacyInstalls,
    logs: input.logs,
  }
}

/** File name for an exported bundle; sortable, and safe on Windows. */
export function supportBundleFileName(now = new Date()): string {
  return `dsh-desktop-support-${now.toISOString().replace(/[:.]/gu, '-').replace(/Z$/u, '')}.json`
}
