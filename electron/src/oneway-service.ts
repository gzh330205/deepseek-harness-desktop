/**
 * ONE-WAY usage, owned by the shell's main process.
 *
 * This is the host half of the retired `dsh-oneway-usage-monitor` plugin, ported out of DSH and into
 * the shell. The plugin had to serve its data over loopback HTTP routes because its UI lived inside
 * the DSH page; the shell window talks to the main process over IPC instead, so what is worth keeping
 * is exactly the part that knows the gateway: the cookie jar, the HTML parsers, the WeCom QR login,
 * and the failure rules below.
 *
 * Three properties are contractual:
 *
 * 1. **The page never catches.** `snapshot()` reports "not signed in", "session expired" and "the
 *    page changed shape" through `error`/`needsLogin` rather than rejecting: a rejected IPC call
 *    leaves the window with nothing to render, which is worse than the same words with an empty
 *    dashboard. Only explicit user actions (starting a login) reject, and they reject with text
 *    meant to be displayed verbatim.
 * 2. **Pure Node, no `electron` import.** The parsers and the login state machine are covered by
 *    `node --test` in `oneway-service.test.ts`; the main process is just one more caller.
 * 3. **The parsers are the fragile part.** Every regex below is copied from the plugin *with* the
 *    note that explains why it looks the way it does. They match server-rendered Tailwind markup
 *    from one specific gateway version, so the first failure after a site redesign is not a reason
 *    to delete them — it is a reason to read why each one is shaped that way.
 */

/* ------------------------------------------------------------------ */
/* Constants                                                          */
/* ------------------------------------------------------------------ */

/**
 * What the settings document's `usage` section defaults to.
 *
 * Exported rather than inlined so the settings UI, the settings file defaults and this service
 * cannot disagree about them.
 */
export const USAGE_DEFAULTS = {
  baseUrl: 'https://oneway.eportyun.com',
  refreshSeconds: 120,
} as const

// OneWay gateway SSO, as observed on the gateway's own /login page. These are the gateway's
// identities, not ours: the SSO entry belongs to oauth.eportyun.com and the QR/poll endpoints
// belong to the WeCom login origin, which is why the login flow juggles two cookie jars' worth of
// hosts before it can capture the gateway session.
const SSO_ENTRY = 'https://oauth.eportyun.com/sso/login'
const SSO_CLIENT_ID = '2ff94fad-0c13-4788-a137-ca32d7080537'
const WECOM_LOGIN_ORIGIN = 'https://login.work.weixin.qq.com'
const WECOM_QR = `${WECOM_LOGIN_ORIGIN}/wwlogin/sso/qrcode`
const WECOM_POLL = `${WECOM_LOGIN_ORIGIN}/wwlogin/monoApi/sso/login/getWebQrCodeStatus`

/** A desktop browser identity: the gateway's SSR pages are chosen by user-agent. */
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** A gateway that has not answered in this long is treated as unreachable, not as still working. */
const REQUEST_TIMEOUT_MS = 20_000
/** A QR code is reused for this long, then the next `startLogin` issues a fresh one. */
const LOGIN_TTL_MS = 10 * 60 * 1000
/** The SSO handshake is a redirect dance; this bounds a loop rather than a slow network. */
const MAX_REDIRECTS = 10
/** Log pages cost a full dashboard parse, and a page of logs is requested on every tab switch. */
const LOGS_CACHE_TTL_MS = 15_000
/** The gateway's log table never shows more than this many rows, and ignores larger requests. */
const MAX_PAGE_SIZE = 50
/**
 * The WeCom QR image is ~2 KB. The window keeps the base64 form in memory and in the DOM, so refuse
 * anything near a megabyte — that is not a login code, and it would only bloat the window.
 */
const WECOM_QR_MAX_BYTES = 1024 * 1024

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

/** The five periods the gateway dashboard reports a number for. */
export type UsageStatKey = 'h5' | 'today' | 'week' | 'month' | 'year'

/**
 * One row of the dashboard's stat cards.
 *
 * Keys are absent when the gateway did not render them (a plan without a monthly quota), and
 * nullable because a rendered value can be an em dash or "不限" (unlimited), both of which mean
 * "there is no number here" — not zero.
 */
export type UsageStats = { readonly [key in UsageStatKey]?: number | null }

/** One row of the per-channel quota table. */
export interface UsageChannel {
  readonly channel: string
  readonly h5: number | null
  readonly h5Limit: number | null
  readonly today: number | null
  readonly week: number | null
  readonly weekLimit: number | null
  readonly month: number | null
  readonly year: number | null
}

/** One model group under a channel. */
export interface UsageModel {
  readonly channel: string
  readonly count: number
  readonly models: readonly string[]
}

/**
 * One point of the hourly/daily chart arrays embedded in /my-usage.
 *
 * The shape belongs to the gateway page: unknown fields are preserved so the window can draw
 * whatever the site starts reporting without another parse change.
 */
export interface UsageChartPoint {
  readonly hour?: string
  readonly date?: string
  readonly tokens?: number
  readonly requests?: number
  readonly [key: string]: unknown
}

/** What `parseUsage` produces: the normalized /my-usage document. */
export interface UsageDocument {
  readonly user: string | null
  readonly apiKey: string | null
  readonly tokens: UsageStats
  readonly requests: UsageStats
  readonly duration: UsageStats
  readonly channels: readonly UsageChannel[]
  readonly models: readonly UsageModel[]
  readonly hourly: readonly UsageChartPoint[]
  readonly daily: readonly UsageChartPoint[]
  readonly pageUrl: string
}

/** One row of /my-requests. */
export interface UsageLogRow {
  readonly id: string
  readonly time: string
  readonly model: string
  readonly key: string
  readonly channel: string
  readonly status: string
  readonly stream: string
  readonly latency: string
  readonly tokens: number | null
}

/** One page of /my-requests. */
export interface UsageLogPage {
  readonly rows: readonly UsageLogRow[]
  readonly total: number | null
  readonly page: number
  readonly pageSize: number
  readonly pages: number | null
  /**
   * Why this page is empty, when it is empty because of a failure rather than because the date
   * range has no requests. Returned instead of thrown: the window renders a table either way.
   */
  readonly error?: string
}

/** How much of a quota the current week/month represents; the window turns these into ratios. */
export interface UsageReference {
  readonly weekTokens: number
  readonly monthTokens: number
}

/**
 * Everything the usage window needs to render in one go.
 *
 * Collections are always present and empty rather than absent, so the page never has to branch
 * between "no data" and "this field is missing".
 */
export interface UsageSnapshot {
  /** Whether there is a usable dashboard document behind this snapshot. */
  readonly loggedIn: boolean
  /**
   * Why the snapshot is degraded. Set for "not signed in", an expired session, a network failure
   * and a page-structure change alike — the window shows it verbatim.
   */
  readonly error?: string
  /** True when the fix is "sign in again" (as opposed to a retry of the same request). */
  readonly needsLogin: boolean
  /** When the parsed document behind this snapshot was fetched. Absent when there is no document. */
  readonly fetchedAt?: number
  readonly user?: string
  readonly apiKey?: string
  readonly tokens: UsageStats
  readonly requests: UsageStats
  readonly duration: UsageStats
  readonly channels: readonly UsageChannel[]
  readonly models: readonly UsageModel[]
  readonly hourly: readonly UsageChartPoint[]
  readonly daily: readonly UsageChartPoint[]
  readonly reference: UsageReference
  /** The base URL and refresh interval currently in effect, for the settings form. */
  readonly settings: { readonly baseUrl: string; readonly refreshSeconds: number }
}

/** A QR login just started; `key` identifies it for {@link UsageService.pollLogin}. */
export interface UsageLoginStart {
  readonly key: string
  /**
   * `data:image/png;base64,…` — the WeCom login QR image itself, put straight into an `<img>`.
   *
   * This is the endpoint's own PNG, not a QR code drawn around its URL: a phone must scan the login
   * code in one pass, and wrapping the URL made it open a second QR code on the phone.
   */
  readonly qrDataUrl: string
  /** Epoch ms after which the QR code must be reissued. */
  readonly expiresAt: number
}

/** Where a QR login currently stands. */
export type UsageLoginState = 'waiting' | 'scanned' | 'expired' | 'confirmed' | 'error'

export interface UsageLoginPoll {
  readonly state: UsageLoginState
  /** Present for `error`, and for `expired` to explain why the window must ask for a new code. */
  readonly message?: string
}

/**
 * Filters accepted by {@link UsageService.requests}, mirroring the gateway's own query names.
 *
 * `undefined` is allowed explicitly (hence `| undefined`) because the IPC layer forwards request
 * fields as they arrive, which is `undefined` for an omitted one; with `exactOptionalPropertyTypes`
 * the caller could otherwise not pass such an object at all.
 */
export interface UsageLogQuery {
  readonly startDate?: string | undefined
  readonly endDate?: string | undefined
  readonly page?: number | undefined
  readonly pageSize?: number | undefined
}

/**
 * The shell's persisted usage settings plus the session secret.
 *
 * `sessionCookie` is a serialized cookie jar because the SSO handshake leaves several cookies
 * across two hosts; the shell keeps it in its own state file (it is a credential, so it does not
 * belong in the settings document).
 */
export interface UsageConfig {
  readonly baseUrl: string
  readonly refreshSeconds: number
  readonly sessionCookie: string
}

/** The persistence face the shell implements; this service only ever reads and patches it. */
export interface UsageScope {
  get(): UsageConfig
  /**
   * Merge only the listed keys — replacing the whole document would drop the other settings.
   *
   * Returning `void` is accepted because the shell's store writes its state file synchronously; a
   * store that has to await something may return a promise instead, and this service awaits either.
   */
  update(patch: Partial<UsageConfig>): void | Promise<void>
}

export interface UsageServiceOptions {
  readonly scope: UsageScope
  /** Injected by tests; the shell uses the Node 24 global. */
  readonly fetchImpl?: typeof fetch
  /** Injected by tests so cache TTLs, cookie expiry and QR expiry can be moved without sleeping. */
  readonly now?: () => number
  readonly log?: (line: string) => void
}

export interface UsageService {
  /**
   * The current dashboard, refreshing first when the cached copy is older than
   * `refreshSeconds` (or when `force` is set). Never rejects.
   */
  snapshot(options?: { readonly force?: boolean }): Promise<UsageSnapshot>
  /** Start (or reuse) a WeCom QR login. Rejects with a displayable message on failure. */
  startLogin(options?: { readonly refresh?: boolean }): Promise<UsageLoginStart>
  /** Advance the login started with `key`. Never rejects. */
  pollLogin(key: string): Promise<UsageLoginPoll>
  /** Forget the in-flight login (window closed, user cancelled). */
  cancelLogin(): void
  /** Drop the session and return the resulting (signed-out) snapshot. */
  logout(): Promise<UsageSnapshot>
  /** One page of request logs. Failures come back as an empty page carrying `error`. */
  requests(query?: UsageLogQuery): Promise<UsageLogPage>
  /** Release the in-flight login; requests already in flight are left to time out on their own. */
  dispose(): void
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.trim() === '' ? '未知错误。' : message
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function randomId(): string {
  return Math.floor(Math.random() * 1e9).toString()
}

/**
 * Decode a string taken from the page's NUXT JSON body.
 *
 * The serialized page escapes `/` as `\u002F` (a JSON parser would turn it back into `/`). The
 * plugin never ran the text through `JSON.parse`, so this is the one escape that has to be undone
 * by hand — and it matters: the SSO validates `state` character by character.
 */
function decodeNuxtString(value: string): string {
  return value.replace(/\\u002F/gu, '/')
}

/** Tailwind-rendered labels come HTML-escaped; the parsers compare and display plain text. */
function unescapeHtml(text: string): string {
  return text
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&nbsp;/gu, ' ')
}

/**
 * Parse a displayed magnitude like "76.70M", "103.1K", "3,411", "49.3分钟", or "不限".
 *
 * The page abbreviates large numbers, so every value that reaches the UI has to be expanded again.
 * Non-numeric placeholders ("不限", "—") become `null` rather than `0`: zero would draw a full
 * quota that the user actually has no limit on.
 */
export function parseMagnitude(text: string | null | undefined): number | null {
  if (text === undefined || text === null) return null
  const raw = unescapeHtml(String(text)).trim()
  if (raw === '' || raw === '不限' || raw === '—' || raw === '-') return null
  const match = /^([\d,.]+)\s*([MK万亿])?/u.exec(raw)
  if (match === null) return null
  const digits = (match[1] ?? '').replace(/,/gu, '')
  let value = Number(digits)
  if (Number.isNaN(value)) return null
  const unit = match[2]
  if (unit === 'M') value *= 1e6
  else if (unit === 'K') value *= 1e3
  else if (unit === '万') value *= 1e4
  else if (unit === '亿') value *= 1e8
  return value
}

/**
 * `Set-Cookie` headers from a response.
 *
 * `getSetCookie()` is the only way to see more than one cookie: `get('set-cookie')` joins them with
 * ", " and a cookie value may itself contain that sequence. The fallback exists for injected fetch
 * doubles that only implement the older `Headers` surface.
 */
function setCookieHeaders(headers: Headers): string[] {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] }
  if (typeof withGetter.getSetCookie === 'function') return withGetter.getSetCookie()
  const joined = headers.get('set-cookie')
  return joined === null || joined === '' ? [] : [joined]
}

function dateParam(value: string | undefined): string | undefined {
  return value !== undefined && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : undefined
}

function normaliseBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/u, '')
  return trimmed === '' ? USAGE_DEFAULTS.baseUrl : trimmed
}

function normaliseRefreshSeconds(value: number): number {
  if (!Number.isFinite(value)) return USAGE_DEFAULTS.refreshSeconds
  return Math.min(3600, Math.max(30, Math.trunc(value)))
}

function normalisePage(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1
  return Math.max(1, Math.trunc(value))
}

function normalisePageSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 10
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(value)))
}

/** An auth failure as opposed to a network or parse failure: the fix is a new login, not a retry. */
export class AuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

/* ------------------------------------------------------------------ */
/* Cookie jar                                                          */
/* ------------------------------------------------------------------ */

/** A persisted cookie. `expires === 0` means a session cookie (no expiry attribute was sent). */
export interface CookieRecord {
  readonly name: string
  readonly value: string
  readonly domain: string
  readonly path: string
  readonly expires: number
}

export interface CookieInput {
  readonly name: string
  readonly value: string
  readonly domain?: string
  readonly path?: string
  readonly expires?: number
}

/**
 * The cookie jar the login flow accumulates and later replays against the gateway.
 *
 * It is a deliberately small implementation: only the attributes the SSO chain actually uses are
 * honored (domain, path, expiry), and cookies are keyed by domain+path+name so that two hosts'
 * same-named cookies cannot overwrite each other. `now` is injected so expiry is testable without
 * waiting for wall-clock time.
 */
export class CookieJar {
  readonly cookies = new Map<string, CookieRecord>()
  readonly #now: () => number

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  /** Rebuild a jar from {@link CookieJar.serialize}; a corrupted value yields an empty jar. */
  static restore(serialized: string, now: () => number = Date.now): CookieJar {
    const jar = new CookieJar(now)
    try {
      const list: unknown = JSON.parse(serialized)
      if (!Array.isArray(list)) return jar
      for (const item of list) {
        if (!isRecord(item)) continue
        const { name, value } = item
        if (typeof name !== 'string' || typeof value !== 'string') continue
        jar.set({
          name,
          value,
          ...(typeof item['domain'] === 'string' ? { domain: item['domain'] } : {}),
          ...(typeof item['path'] === 'string' ? { path: item['path'] } : {}),
          ...(typeof item['expires'] === 'number' ? { expires: item['expires'] } : {}),
        })
      }
    } catch {
      // A corrupted settings value must not stop the service from starting: an empty jar just means
      // "sign in again", which is recoverable, unlike refusing to construct.
    }
    return jar
  }

  set(input: CookieInput): void {
    const name = input.name
    if (name === '') return
    const domain = input.domain ?? ''
    const path = input.path ?? '/'
    this.cookies.set(`${domain}|${path}|${name}`, {
      name,
      value: input.value,
      domain,
      path,
      expires: input.expires ?? 0,
    })
  }

  /**
   * Absorb the `Set-Cookie` headers of one hop.
   *
   * Two gateway quirks are handled here on purpose:
   * - `__Secure-` / `__Host-` prefixes are stripped. The prefix is only legal over HTTPS and only
   *   restricts where the cookie may be set; the gateway reads the bare name back, so keeping the
   *   prefix would send a cookie it does not recognize.
   * - a `Domain=` that does not belong to the responding host is replaced by that host. This is
   *   technically a rejection in a real cookie store, but the SSO chain sets domain cookies on
   *   redirect responses whose host is the redirect source, and dropping them strands the login.
   */
  addFromResponse(requestUrl: string, headers: readonly string[]): void {
    let url: URL
    try {
      url = new URL(requestUrl)
    } catch {
      return
    }
    for (const header of headers) {
      const parts = header.split(';')
      const pair = parts[0] ?? ''
      const separator = pair.indexOf('=')
      if (separator <= 0) continue
      const name = pair.slice(0, separator).trim().replace(/^__(?:Secure|Host)-/u, '')
      const value = pair.slice(separator + 1).trim()
      if (name === '') continue
      let domain = ''
      let path = '/'
      let expires = 0
      for (const part of parts.slice(1)) {
        const [key = '', ...rest] = part.trim().split('=')
        const attribute = rest.join('=')
        switch (key.toLowerCase()) {
          case 'domain': {
            domain = attribute.toLowerCase()
            break
          }
          case 'path': {
            path = attribute === '' ? '/' : attribute
            break
          }
          case 'expires': {
            expires = Date.parse(attribute) || 0
            break
          }
          case 'max-age': {
            expires = this.#now() + (Number(attribute) || 0) * 1000
            break
          }
          default:
            break
        }
      }
      if (domain === '') domain = url.hostname
      if (!domain.startsWith('.') && domain !== url.hostname) domain = url.hostname
      this.set({ name, value, domain, path, expires })
    }
  }

  /**
   * The `Cookie:` header value for a request, or `''` when nothing applies.
   *
   * Domain matching is the "host-only or subdomain" rule (a leading dot means the suffix must
   * match); path matching is the prefix rule from RFC 6265, which the gateway relies on for its
   * `/my-usage` vs `/my-requests` session cookies.
   */
  headerFor(requestUrl: string): string {
    let url: URL
    try {
      url = new URL(requestUrl)
    } catch {
      return ''
    }
    const hostname = url.hostname.toLowerCase()
    const requestPath = url.pathname === '' ? '/' : url.pathname
    const now = this.#now()
    const picked: string[] = []
    for (const cookie of this.cookies.values()) {
      if (cookie.expires > 0 && cookie.expires < now) continue
      const domain = cookie.domain.toLowerCase()
      const hostMatches = domain.startsWith('.')
        ? hostname.endsWith(domain) || hostname === domain.slice(1)
        : hostname === domain
      if (!hostMatches) continue
      const path = cookie.path === '' ? '/' : cookie.path
      if (!requestPath.startsWith(path)) continue
      picked.push(`${cookie.name}=${cookie.value}`)
    }
    return picked.join('; ')
  }

  hasFor(requestUrl: string): boolean {
    return this.headerFor(requestUrl) !== ''
  }

  serialize(): string {
    return JSON.stringify([...this.cookies.values()])
  }
}

/* ------------------------------------------------------------------ */
/* HTML parsing                                                        */
/* ------------------------------------------------------------------ */

// The dashboard is server-rendered Tailwind markup. Each regex below pins the smallest amount of
// class structure that identifies one logical block, because the page has no data attributes and
// the class names are the only stable hook it offers. They are intentionally strict: a silent
// mis-parse would show wrong quota numbers, while a failed match shows "页面结构变化" instead.
//
// Stat section: an <h3> label followed by the grid of label/value pairs. `[\s\S]*?` stops at the
// first `</div></div>`, which is the end of the section wrapper once the cells (only <p> elements)
// have been consumed.
const STAT_SECTION_RE = /<h3 class="mb-2 text-xs font-semibold text-slate-500">([^<]+)<\/h3><div class="grid[^"]*">([\s\S]*?)<\/div><\/div>/gu
// One label/value pair inside a stat section. The value is `[^<]*` (not `[^<]+`) because the page
// renders an empty cell for an unlimited plan.
const STAT_CELL_RE = /<p class="text-xs text-slate-400">([^<]+)<\/p><p class="text-lg font-semibold text-slate-700">([^<]*)<\/p>/gu
// The per-channel quota table is located by its own heading; `\/` is the literal slash in
// "按渠道用量 / 限额", and `\s*` tolerates the whitespace the template adds around it.
const CHANNEL_TABLE_RE = /<h3 class="text-xs font-semibold text-slate-500 mb-2">按渠道用量\s*\/\s*限额<\/h3>[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/u
// Eight <td> cells exactly: the live table has eight columns, and requiring all of them is what
// keeps header rows and nested tables out of the result.
const CHANNEL_ROW_RE = /<tr>(<td[^>]*>[^<]*<\/td>){8}<\/tr>/gu
// One model group card; the trailing `</div></div>` closes the inner list and the card itself.
const MODEL_BLOCK_RE = /<div class="rounded-lg border border-slate-200 px-4 py-3">([\s\S]*?)<\/div><\/div>/gu
// One log row: nine cells in a fixed order (time, model, key, channel, status, stream, latency,
// tokens, detail link). The link's `/my-requests/<id>` tail is the row id; `[^>]*` skips its other
// attributes, which the page adds inconsistently.
const LOG_ROW_RE = /<tr><td class="font-mono[^"]*">([^<]*)<\/td><td class="font-medium">([^<]*)<\/td><td class="text-slate-500">([^<]*)<\/td><td class="text-slate-500">([^<]*)<\/td><td><span class="[^"]*">([^<]*)<\/span><\/td><td class="text-slate-500">([^<]*)<\/td><td class="text-right[^"]*">([^<]*)<\/td><td class="text-right[^"]*">([^<]*)<\/td><td><a href="\/my-requests\/(\d+)[^"]*"[^>]*>/gu

const STAT_LABELS: Record<string, UsageStatKey> = {
  '近 5 小时': 'h5',
  今日: 'today',
  本周: 'week',
  本月: 'month',
  本年: 'year',
}

const SECTION_TARGETS: Record<string, 'tokens' | 'requests' | 'duration'> = {
  'Token 用量': 'tokens',
  请求次数: 'requests',
  使用时长: 'duration',
}

type MutableStats = { [key in UsageStatKey]?: number | null }

/**
 * Read one chart array out of the inline script that feeds it.
 *
 * `/my-usage` does not expose the chart data as JSON: it embeds `var data = [...];` in a script
 * tagged with the chart's id. The marker id is therefore the only way to tell the hourly array from
 * the daily one, and the lazy `[\s\S]*?` walks past everything before it (the script tag itself may
 * carry other attributes).
 */
function extractJsonArray(html: string, marker: string): UsageChartPoint[] {
  const match = new RegExp(`id="${marker}"[\\s\\S]*?var data = (\\[[\\s\\S]*?\\]);`, 'u').exec(html)
  if (match === null) return []
  try {
    const parsed: unknown = JSON.parse(match[1] ?? '')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is UsageChartPoint => typeof item === 'object' && item !== null && !Array.isArray(item))
  } catch {
    // A truncated or escaped inline script is a page-structure problem, not a crash: the window
    // simply has no trend data to draw.
    return []
  }
}

/**
 * Parse /my-usage into the normalized document the window renders.
 *
 * @param html - Server-rendered dashboard page.
 * @param baseUrl - Gateway base URL, used for the page link.
 */
export function parseUsage(html: string, baseUrl: string): UsageDocument {
  const document: {
    user: string | null
    apiKey: string | null
    tokens: MutableStats
    requests: MutableStats
    duration: MutableStats
    channels: UsageChannel[]
    models: UsageModel[]
    hourly: UsageChartPoint[]
    daily: UsageChartPoint[]
  } = {
    user: null,
    apiKey: null,
    tokens: {},
    requests: {},
    duration: {},
    channels: [],
    models: [],
    hourly: [],
    daily: [],
  }

  // "姓名：<value>" is the only place the dashboard prints the signed-in user; its presence is also
  // what the service uses as the "this is really the dashboard, not the login page" check.
  const nameMatch = /姓名：([^<]+)</u.exec(html)
  if (nameMatch !== null) document.user = unescapeHtml(nameMatch[1] ?? '').trim() || null

  // The API key sits in the only <code> element styled as a chip; `break-all` is part of the class
  // list because the key is too long to fit and the template wraps it.
  const keyMatch = /<code class="px-2 py-1 rounded bg-slate-100 text-slate-700 font-mono break-all">([^<]+)<\/code>/u.exec(html)
  if (keyMatch !== null) document.apiKey = unescapeHtml(keyMatch[1] ?? '').trim() || null

  for (const section of html.matchAll(STAT_SECTION_RE)) {
    const label = unescapeHtml(section[1] ?? '').trim()
    const target = SECTION_TARGETS[label]
    if (target === undefined) continue
    const values: MutableStats = {}
    for (const cell of (section[2] ?? '').matchAll(STAT_CELL_RE)) {
      const key = STAT_LABELS[unescapeHtml(cell[1] ?? '').trim()]
      if (key !== undefined) values[key] = parseMagnitude(cell[2] ?? '')
    }
    if (target === 'tokens') document.tokens = values
    else if (target === 'requests') document.requests = values
    else document.duration = values
  }

  const tableMatch = CHANNEL_TABLE_RE.exec(html)
  if (tableMatch !== null) {
    for (const row of (tableMatch[1] ?? '').matchAll(CHANNEL_ROW_RE)) {
      const cells = [...(row[0] ?? '').matchAll(/<td[^>]*>([^<]*)<\/td>/gu)].map(cell => unescapeHtml(cell[1] ?? '').trim())
      if (cells.length !== 8) continue
      const [channel = '', h5 = '', h5Limit = '', today = '', week = '', weekLimit = '', month = '', year = ''] = cells
      document.channels.push({
        channel,
        h5: parseMagnitude(h5),
        h5Limit: parseMagnitude(h5Limit),
        today: parseMagnitude(today),
        week: parseMagnitude(week),
        weekLimit: parseMagnitude(weekLimit),
        month: parseMagnitude(month),
        year: parseMagnitude(year),
      })
    }
  }

  for (const block of html.matchAll(MODEL_BLOCK_RE)) {
    const body = block[1] ?? ''
    const channelName = /text-sm font-semibold text-slate-700">([^<]+)<\/span>/u.exec(body)
    if (channelName === null) continue
    const models = [...body.matchAll(/class="text-xs px-2 py-0\.5 rounded bg-blue-50 text-blue-600"[^>]*>([^<]+)<\/span>/gu)]
      .map(item => unescapeHtml(item[1] ?? '').trim())
    document.models.push({
      // The channel heading is prefixed with a link glyph the template adds; it is decoration, not
      // part of the channel name, and comparing channels across sections would break on it.
      channel: unescapeHtml(channelName[1] ?? '').replace(/^🔗\s*/u, '').trim(),
      count: models.length,
      models,
    })
  }

  document.hourly = extractJsonArray(html, 'myHourlyChart')
  document.daily = extractJsonArray(html, 'myTrendChart')

  return { ...document, pageUrl: `${normaliseBaseUrl(baseUrl)}/my-usage` }
}

/**
 * Parse /my-requests into one page of log rows.
 *
 * @param html - Server-rendered log page.
 * @param baseUrl - Gateway base URL (kept for parity with `parseUsage`; the rows carry no URL).
 * @param page - Page number that was requested.
 * @param pageSize - Page size that was requested.
 */
export function parseLogs(html: string, baseUrl: string, page: number, pageSize: number): UsageLogPage {
  void baseUrl
  const rows: UsageLogRow[] = []
  for (const match of html.matchAll(LOG_ROW_RE)) {
    rows.push({
      id: match[9] ?? '',
      time: unescapeHtml(match[1] ?? '').trim(),
      model: unescapeHtml(match[2] ?? '').trim(),
      key: unescapeHtml(match[3] ?? '').trim(),
      channel: unescapeHtml(match[4] ?? '').trim(),
      status: unescapeHtml(match[5] ?? '').trim(),
      stream: unescapeHtml(match[6] ?? '').trim(),
      latency: unescapeHtml(match[7] ?? '').trim(),
      tokens: parseMagnitude(match[8] ?? ''),
    })
  }
  // "共 1,234 条" — the only total the page states. Absent means paging is unknown, not zero.
  const totalMatch = /共\s*([\d,]+)\s*条/u.exec(html)
  const total = totalMatch === null ? null : Number((totalMatch[1] ?? '').replace(/,/gu, ''))
  const safeTotal = total !== null && Number.isNaN(total) ? null : total
  const pages = safeTotal === null || pageSize <= 0 ? null : Math.max(1, Math.ceil(safeTotal / pageSize))
  return { rows, total: safeTotal, page, pageSize, pages }
}

/* ------------------------------------------------------------------ */
/* The service                                                         */
/* ------------------------------------------------------------------ */

interface CacheEntry {
  readonly data: UsageDocument
  readonly at: number
}

interface LogsCacheEntry {
  readonly key: string
  readonly at: number
  readonly page: UsageLogPage
}

interface LoginFlow {
  readonly webKey: string
  /** The URL-decoded `state` the SSO expects back on the callback. */
  readonly state: string
  readonly redirectUri: string
  /** The WeCom page URL, reused as the poll request's `referer`. */
  readonly wecomUrl: string
  readonly startedAt: number
  /** The WeCom poll endpoint wants the last status it reported; 0/1 correspond to waiting/scanning. */
  lastStatus: number
  /**
   * The login QR image, fetched from the WeCom qrcode endpoint while the flow is created.
   *
   * It is stored rather than fetched per `startLogin` call: reopening the window must show the same
   * code the phone may already be scanning.
   */
  readonly qrDataUrl: string
  /** Cookies picked up before the callback (SSO entry + WeCom page); carried into the handshake. */
  readonly jar: CookieJar
}

/**
 * Build the ONE-WAY usage service.
 *
 * @param options - Persistence scope plus injectable fetch/clock/log for tests.
 */
export function createUsageService(options: UsageServiceOptions): UsageService {
  const scope = options.scope
  const now = options.now ?? Date.now
  const fetchImpl = options.fetchImpl ?? fetch
  const log = options.log ?? ((): void => {})

  let cache: CacheEntry | null = null
  let lastError: string | null = null
  let lastErrorNeedsLogin = false
  let refreshing: Promise<UsageSnapshot> | null = null
  let logCache: LogsCacheEntry | null = null
  let flow: LoginFlow | null = null

  // The jar is rebuilt only when the persisted value changes: that keeps the in-memory jar the
  // login flow just filled without parsing it back on every request, while still picking up a
  // session written by an earlier run.
  let jar = new CookieJar(now)
  let jarSource = ''

  const configOf = (): UsageConfig => {
    const raw = scope.get()
    return {
      baseUrl: normaliseBaseUrl(raw.baseUrl ?? ''),
      refreshSeconds: normaliseRefreshSeconds(raw.refreshSeconds),
      sessionCookie: raw.sessionCookie ?? '',
    }
  }

  const jarFor = (config: UsageConfig): CookieJar => {
    if (config.sessionCookie !== jarSource) {
      jar = CookieJar.restore(config.sessionCookie, now)
      jarSource = config.sessionCookie
    }
    return jar
  }

  const cookieHeader = (value: string): Record<string, string> => (value === '' ? {} : { cookie: value })

  /**
   * GET a gateway page.
   *
   * A dead session shows up in four different shapes depending on which gateway build answers:
   * 401/403, a redirect to `/login`, or the login page itself with status 200. All four are treated
   * as an {@link AuthError} so the window can say "sign in again" instead of "refresh failed".
   */
  const fetchHtml = async (path: string, config: UsageConfig): Promise<{ html: string; url: string }> => {
    const url = `${config.baseUrl}${path}`
    const response = await fetchImpl(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'user-agent': USER_AGENT, ...cookieHeader(jarFor(config).headerFor(url)) },
    })
    const finalUrl = response.url === '' ? url : response.url
    const html = await response.text()
    if (response.status === 401 || response.status === 403 || /\/login(?:\?|$)/u.test(finalUrl) || html.includes('<title>登录 -')) {
      throw new AuthError('未登录或会话已过期，请重新扫码登录。')
    }
    return { html, url: finalUrl }
  }

  const buildSnapshot = (): UsageSnapshot => {
    const config = configOf()
    const data = cache?.data ?? null
    const tokens = data?.tokens ?? {}
    return {
      loggedIn: data !== null,
      needsLogin: data === null && lastErrorNeedsLogin,
      ...(lastError === null ? {} : { error: lastError }),
      ...(cache === null ? {} : { fetchedAt: cache.at }),
      ...(data === null || data.user === null ? {} : { user: data.user }),
      ...(data === null || data.apiKey === null ? {} : { apiKey: data.apiKey }),
      tokens,
      requests: data?.requests ?? {},
      duration: data?.duration ?? {},
      channels: data?.channels ?? [],
      models: data?.models ?? [],
      hourly: data?.hourly ?? [],
      daily: data?.daily ?? [],
      // The window builds its quota rings against this week's usage; a week with no recorded tokens
      // (a fresh quota period, or a plan that only reports monthly) falls back to the month.
      reference: { weekTokens: tokens.week ?? 0, monthTokens: tokens.month ?? 0 },
      settings: { baseUrl: config.baseUrl, refreshSeconds: config.refreshSeconds },
    }
  }

  /**
   * Fetch and parse the dashboard, recording the outcome instead of throwing it.
   *
   * The cached document survives a network failure (the numbers it holds were true when fetched and
   * are more useful than an empty panel), but an auth failure clears it: keeping data that belongs
   * to a session the gateway has already rejected would show a stale dashboard behind a login
   * prompt.
   */
  const refreshNow = async (): Promise<UsageSnapshot> => {
    const config = configOf()
    if (config.sessionCookie.trim() === '') {
      cache = null
      lastError = '尚未登录。'
      lastErrorNeedsLogin = true
      return buildSnapshot()
    }
    try {
      const { html } = await fetchHtml('/my-usage', config)
      const data = parseUsage(html, config.baseUrl)
      if (data.user === null) throw new Error('网关页面结构变化，未能解析用户信息。')
      cache = { data, at: now() }
      lastError = null
      lastErrorNeedsLogin = false
    } catch (error) {
      lastError = messageOf(error)
      lastErrorNeedsLogin = error instanceof AuthError
      if (error instanceof AuthError) cache = null
      log(`oneway: 用量刷新失败：${lastError}`)
    }
    return buildSnapshot()
  }

  const snapshot = async (callOptions: { readonly force?: boolean } = {}): Promise<UsageSnapshot> => {
    const config = configOf()
    if (config.sessionCookie.trim() === '') {
      cache = null
      lastError = '尚未登录。'
      lastErrorNeedsLogin = true
      return buildSnapshot()
    }
    const freshEnough = cache !== null && now() - cache.at < config.refreshSeconds * 1000
    if (callOptions.force !== true && freshEnough) return buildSnapshot()
    // One refetch at a time: the window's periodic poll and a user-triggered refresh would otherwise
    // hit the gateway twice for the same document.
    const running = refreshing
    if (running !== null) return running
    const started = refreshNow()
    refreshing = started
    try {
      return await started
    } finally {
      if (refreshing === started) refreshing = null
    }
  }

  /* ------------------------- login flow ------------------------- */

  const loginStartOf = (current: LoginFlow): UsageLoginStart => ({
    key: current.webKey,
    qrDataUrl: current.qrDataUrl,
    expiresAt: current.startedAt + LOGIN_TTL_MS,
  })

  const extractRedirectUri = (html: string): string => {
    const match = /"redirect_uri":"([^"]*)"/u.exec(html)
    // The observed value on the gateway's page; only used when the page does not serialize one.
    return match === null ? 'https://oauth.eportyun.com/sso/wecom/callback' : decodeNuxtString(match[1] ?? '')
  }

  const startLogin = async (startOptions: { readonly refresh?: boolean } = {}): Promise<UsageLoginStart> => {
    // Reuse the QR already on screen unless the caller explicitly asks for a new one (it expired,
    // or the user pressed "刷新二维码"). Reissuing on every window open would kill a scan in
    // progress on the phone.
    const existing = flow
    if (startOptions.refresh !== true && existing !== null && now() - existing.startedAt < LOGIN_TTL_MS) {
      return loginStartOf(existing)
    }
    flow = null

    const flowJar = new CookieJar(now)
    const entry = `${SSO_ENTRY}?client_id=${SSO_CLIENT_ID}&scope=snsapi_base`
    let entryResponse: Response
    try {
      entryResponse = await fetchImpl(entry, {
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { 'user-agent': USER_AGENT },
      })
    } catch (error) {
      throw new Error(`无法发起企业微信登录：${messageOf(error)}`)
    }
    flowJar.addFromResponse(entry, setCookieHeaders(entryResponse.headers))
    const location = entryResponse.headers.get('location')
    if (location === null || location === '') throw new Error('无法发起企业微信登录：SSO 未返回跳转地址。')
    const wecomUrl = new URL(location, entry).toString()

    let pageResponse: Response
    try {
      pageResponse = await fetchImpl(wecomUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { 'user-agent': USER_AGENT },
      })
    } catch (error) {
      throw new Error(`无法加载企业微信扫码页：${messageOf(error)}`)
    }
    flowJar.addFromResponse(wecomUrl, setCookieHeaders(pageResponse.headers))
    const html = await pageResponse.text()
    // The page's own JSON carries the QR key; `[a-f0-9]+` is what the template emits, and a looser
    // class would happily match an unrelated `web_key` string in a script tag.
    const keyMatch = /"web_key":"([a-f0-9]+)"/u.exec(html)
    if (keyMatch === null) throw new Error('无法解析企业微信扫码页（web_key 缺失）。')
    const webKey = keyMatch[1] ?? ''

    // The QR image is the login code itself: GETting the qrcode endpoint with the page's `web_key`
    // answers with the PNG that 企业微信 scans and posts back. Drawing this URL as a QR code (what
    // the plugin used to do) made the phone open a page that showed *another* QR code, so every
    // login needed two scans. Fetch it here, once per flow, and hand the window the image bytes.
    const qrUrl = `${WECOM_QR}?key=${webKey}`
    let qrResponse: Response
    try {
      qrResponse = await fetchImpl(qrUrl, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { 'user-agent': USER_AGENT },
      })
    } catch (error) {
      throw new Error(`无法获取企业微信登录二维码：${messageOf(error)}`)
    }
    if (qrResponse.status !== 200) {
      throw new Error(`无法获取企业微信登录二维码（HTTP ${String(qrResponse.status)}）。`)
    }
    const contentType = (qrResponse.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
    if (!contentType.startsWith('image/')) {
      throw new Error(`无法获取企业微信登录二维码（返回类型不是图片：${contentType === '' ? '未知' : contentType}）。`)
    }
    let qrBytes: ArrayBuffer
    try {
      qrBytes = await qrResponse.arrayBuffer()
    } catch (error) {
      throw new Error(`无法读取企业微信登录二维码：${messageOf(error)}`)
    }
    if (qrBytes.byteLength === 0) throw new Error('无法获取企业微信登录二维码（响应为空）。')
    if (qrBytes.byteLength >= WECOM_QR_MAX_BYTES) throw new Error('无法获取企业微信登录二维码（图片过大）。')
    const qrDataUrl = `data:${contentType};base64,${Buffer.from(qrBytes).toString('base64')}`

    // The browser that completes this flow round-trips the *decoded* state: the page serializes
    // spaces as "+" (a JS URL artifact) and the callback is built with encodeURIComponent, which
    // turns them into %20. Replaying the raw state from the Location header makes the SSO reject the
    // callback, and the NUXT body's \u002F escapes must be decoded the same way a JSON parser would
    // or the SSO 500s. Getting this exactly right is what makes the scan succeed.
    let state = ''
    const stateMatch = /"state":"([^"]*)"/u.exec(html)
    if (stateMatch !== null) {
      state = decodeNuxtString(stateMatch[1] ?? '')
    } else {
      const fromUrl = /[?&]state=([^&]+)/u.exec(location)
      if (fromUrl !== null) {
        const raw = fromUrl[1] ?? ''
        try {
          state = decodeURIComponent(raw.replace(/\+/gu, '%2B'))
        } catch {
          state = raw
        }
      }
    }

    const created: LoginFlow = {
      webKey,
      state,
      redirectUri: extractRedirectUri(html),
      wecomUrl,
      startedAt: now(),
      lastStatus: 0,
      qrDataUrl,
      jar: flowJar,
    }
    flow = created
    return loginStartOf(created)
  }

  const completeLogin = async (current: LoginFlow, authCode: string): Promise<void> => {
    const callback = new URL(current.redirectUri)
    callback.searchParams.set('code', authCode)
    callback.searchParams.set('state', current.state)
    const nextJar = new CookieJar(now)
    for (const cookie of current.jar.cookies.values()) nextJar.set(cookie)

    // Walk the SSO handshake by hand: the session cookie is set somewhere in this chain, and the
    // browser's automatic redirect following would hide the intermediate Set-Cookie headers.
    let target = callback.toString()
    let lastStatus = 0
    for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
      const response = await fetchImpl(target, {
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { 'user-agent': USER_AGENT, ...cookieHeader(nextJar.headerFor(target)) },
      })
      nextJar.addFromResponse(target, setCookieHeaders(response.headers))
      lastStatus = response.status
      const location = response.headers.get('location')
      if (location !== null && REDIRECT_STATUSES.has(response.status)) {
        target = new URL(location, target).toString()
        continue
      }
      // Drain the body so the connection can be reused; nothing reads it.
      await response.arrayBuffer()
      break
    }

    const config = configOf()
    // Some gateway builds only set the session cookie on the first authenticated page after the
    // handshake, so one probe of the dashboard is worth doing before declaring failure.
    if (!nextJar.hasFor(config.baseUrl)) {
      try {
        const probe = await fetchImpl(`${config.baseUrl}/my-usage`, {
          redirect: 'manual',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: { 'user-agent': USER_AGENT, ...cookieHeader(nextJar.headerFor(config.baseUrl)) },
        })
        nextJar.addFromResponse(probe.url === '' ? `${config.baseUrl}/my-usage` : probe.url, setCookieHeaders(probe.headers))
        await probe.arrayBuffer()
      } catch (error) {
        log(`oneway: 登录探测失败：${messageOf(error)}`)
      }
    }
    if (!nextJar.hasFor(config.baseUrl)) {
      throw new Error(
        `登录链路未取得网关会话 Cookie（终点：${target}，HTTP ${String(lastStatus)}）。如网关登录页有验证码或需手动确认，请改用浏览器登录后复制 Cookie。`,
      )
    }

    const serialized = nextJar.serialize()
    // Install the jar before persisting it: the verification fetch below must use it, and `jarFor`
    // rebuilds from the scope whenever the two disagree.
    jar = nextJar
    jarSource = serialized
    try {
      await scope.update({ sessionCookie: serialized })
    } catch (error) {
      jar = new CookieJar(now)
      jarSource = ''
      throw new Error(`无法保存登录状态：${messageOf(error)}`)
    }

    const verified = await refreshNow()
    if (!verified.loggedIn) {
      // A session the gateway refuses to serve is worse than none: it would keep every later call
      // looking "logged in" while showing nothing.
      jar = new CookieJar(now)
      jarSource = ''
      try {
        await scope.update({ sessionCookie: '' })
      } catch (error) {
        log(`oneway: 回滚登录状态失败：${messageOf(error)}`)
      }
      throw new Error(`登录成功但校验失败：${verified.error ?? '网关未返回用户信息。'}`)
    }
  }

  const pollLogin = async (key: string): Promise<UsageLoginPoll> => {
    try {
      const current = flow
      if (current === null || key !== current.webKey) {
        return { state: 'expired', message: '二维码已失效，请重新获取。' }
      }
      if (now() - current.startedAt > LOGIN_TTL_MS) {
        flow = null
        return { state: 'expired', message: '二维码已过期，请重新获取。' }
      }

      const body = `webKey=${encodeURIComponent(current.webKey)}&lastStatus=${String(current.lastStatus)}&openDataSid=`
      const response = await fetchImpl(`${WECOM_POLL}?lang=zh_CN&ajax=1&f=json&random=${randomId()}`, {
        method: 'POST',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': USER_AGENT,
          referer: current.wecomUrl,
          origin: WECOM_LOGIN_ORIGIN,
        },
        body,
      })
      const payload: unknown = await response.json().catch(() => ({}))
      const data = isRecord(payload) && isRecord(payload['data']) ? payload['data'] : {}
      const status = typeof data['status'] === 'string' ? data['status'] : null
      if (status === null) {
        return { state: 'error', message: `扫码状态接口异常：${JSON.stringify(payload).slice(0, 120)}` }
      }

      switch (status) {
        case 'QRCODE_SCAN_NEVER': {
          current.lastStatus = 0
          return { state: 'waiting' }
        }
        case 'QRCODE_SCAN_ING': {
          current.lastStatus = 1
          return { state: 'scanned' }
        }
        case 'QRCODE_SCAN_FAIL':
        case 'QRCODE_SCAN_ERR': {
          return { state: 'error', message: '扫码失败，请刷新二维码重试。' }
        }
        case 'QRCODE_SCAN_PC_BIND': {
          return { state: 'error', message: '请在 PC 端绑定后重试。' }
        }
        case 'QRCODE_SCAN_SUCC': {
          const authCode = data['auth_code'] ?? data['code'] ?? data['authCode']
          if (typeof authCode !== 'string' || authCode === '') {
            return {
              state: 'error',
              message: `扫码成功但未取得授权码（响应：${JSON.stringify(data).slice(0, 200)}），请重试。`,
            }
          }
          try {
            await completeLogin(current, authCode)
            flow = null
            return { state: 'confirmed' }
          } catch (error) {
            return { state: 'error', message: messageOf(error) }
          }
        }
        default: {
          return { state: 'error', message: `未知扫码状态：${status}` }
        }
      }
    } catch (error) {
      // The window polls once a second or so; a network blip must not break the modal it lives in.
      return { state: 'error', message: `查询扫码状态失败：${messageOf(error)}` }
    }
  }

  const logout = async (): Promise<UsageSnapshot> => {
    jar = new CookieJar(now)
    jarSource = ''
    cache = null
    logCache = null
    lastError = null
    lastErrorNeedsLogin = false
    flow = null
    try {
      await scope.update({ sessionCookie: '' })
    } catch (error) {
      // Forgetting the cookie in memory already signs this run out; failing to erase the file is
      // reported but not turned into a rejected call the window would have to catch.
      log(`oneway: 清除登录状态失败：${messageOf(error)}`)
    }
    return snapshot()
  }

  const requests = async (query: UsageLogQuery = {}): Promise<UsageLogPage> => {
    const config = configOf()
    const page = normalisePage(query.page)
    const pageSize = normalisePageSize(query.pageSize)
    const params = new URLSearchParams()
    const startDate = dateParam(query.startDate)
    const endDate = dateParam(query.endDate)
    if (startDate !== undefined) params.set('startDate', startDate)
    if (endDate !== undefined) params.set('endDate', endDate)
    params.set('page', String(page))
    params.set('pageSize', String(pageSize))
    const queryString = params.toString()

    const cached = logCache
    if (cached !== null && cached.key === queryString && now() - cached.at < LOGS_CACHE_TTL_MS) return cached.page

    try {
      const { html } = await fetchHtml(`/my-requests?${queryString}`, config)
      const parsed = parseLogs(html, config.baseUrl, page, pageSize)
      logCache = { key: queryString, at: now(), page: parsed }
      return parsed
    } catch (error) {
      const message = messageOf(error)
      if (error instanceof AuthError) {
        // The log tab discovered the dead session first; the usage tab must agree immediately.
        cache = null
        lastError = message
        lastErrorNeedsLogin = true
      }
      log(`oneway: 日志读取失败：${message}`)
      return { rows: [], total: null, page, pageSize, pages: null, error: message }
    }
  }

  return {
    snapshot,
    startLogin,
    pollLogin,
    cancelLogin() {
      flow = null
    },
    logout,
    requests,
    dispose() {
      // Nothing to cancel: every request carries its own AbortSignal timeout. Dropping the flow is
      // enough to make a later poll from a closing window report `expired`.
      flow = null
    },
  }
}
