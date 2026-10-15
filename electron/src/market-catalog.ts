/**
 * The plugin catalog behind the market window: what can be found, and what is allowed in.
 *
 * Deliberately thin. The upstream market (`dsh-market`, MIT) ships its own multi-megabyte catalog,
 * compatibility and install stack; we need only "find plugins, then install them through the path the
 * shell already proved" (`bin/node.exe` + `pnpm.cjs`, `cwd` = profile, `shell: false`). So discovery
 * is the **npm registry**, and admission is the one field every real DSH plugin declares: `dsh`
 * (`dsh.bundle.patch`, with an optional `dsh.client` half).
 *
 * Two rules keep the list honest:
 * - **Platform packages are not plugins.** `@deepseek-ai/dsh*` is the harness itself (base, web-app,
 *   headless, sdk-app …); offering them as installable plugins would let a user break their runtime.
 * - **A search hit is not a plugin.** npm's search matches loosely (a `dsh` query returns 20k rows,
 *   most unrelated), and the hit carries no `dsh` field, so every candidate is confirmed against its
 *   own packument before it is shown.
 */

/** Registry endpoints. Overridable so tests and mirrors do not touch the network. */
export const REGISTRY_ORIGIN = 'https://registry.npmjs.org'

/** Quote a package name for a registry URL: the scope separator is the only character that needs it. */
export function packumentUrl(name: string, origin: string = REGISTRY_ORIGIN): string {
  return `${origin}/${name.startsWith('@') ? name.replace('/', '%2F') : name}`
}

/** npm's search endpoint for a free-text query. */
export function searchUrl(query: string, size: number, origin: string = REGISTRY_ORIGIN): string {
  return `${origin}/-/v1/search?text=${encodeURIComponent(query)}&size=${String(size)}`
}

/** One installable plugin, as the market list shows it. */
export interface MarketPackage {
  /** Package name as published (`@scope/name` or `name`). */
  readonly name: string
  /** Version we would install. */
  readonly version: string
  /** One-line description, already trimmed to a displayable length. */
  readonly description: string
  /** ISO date of the published version, empty when the registry omits it. */
  readonly published: string
  /** Search keywords, upper-bounded (the list view only shows a few). */
  readonly keywords: readonly string[]
  /** The spec handed to pnpm — always an exact `name@version` so a fresh-release hold cannot swap it. */
  readonly spec: string
  /** True when the plugin also injects a browser-side half (`dsh.client`). */
  readonly client: boolean
}

/** Outcome of one catalog query. */
export interface MarketSearchResult {
  readonly query: string
  /** Admitted plugins, best match first. */
  readonly packages: readonly MarketPackage[]
  /** How many admitted packages were found before the result cap. */
  readonly total: number
  /** Candidates that were rejected, with the reason — surfaced in the UI, never silently dropped. */
  readonly skipped: readonly { readonly name: string; readonly reason: string }[]
}

/**
 * The harness itself, not a plugin.
 *
 * `@deepseek-ai/dsh` is the runtime we ship; `dsh-base` / `dsh-web-app` are the bundles every profile
 * already seeds. Installing any of them from the market would fight the bundled runtime.
 */
export function isPlatformPackage(name: string): boolean {
  return /^@deepseek-ai\/dsh($|-)/u.test(name)
}

/**
 * Decide whether a packument describes an installable plugin.
 *
 * A plugin declares `dsh.bundle.patch` (the patch layer it contributes). `dsh.client` is optional and
 * means the plugin also has a browser-side half. Anything without `dsh` is an ordinary npm package
 * that happened to match the search text.
 *
 * @param name - Package name, used only for the rejection reason.
 * @param manifest - The version manifest to inspect (`dist-tags.latest` of the packument).
 * @returns `undefined` when the package is a plugin, otherwise why it is not.
 */
export function rejectReason(name: string, manifest: unknown): string | undefined {
  if (isPlatformPackage(name)) return '平台自身（@deepseek-ai/dsh*），不是插件'
  if (manifest === null || typeof manifest !== 'object') return '版本清单不可读'
  const dsh = (manifest as { dsh?: unknown }).dsh
  if (dsh === null || typeof dsh !== 'object' || Array.isArray(dsh)) return '没有声明 dsh 字段，不是 DSH 插件'
  const patch = (dsh as { bundle?: { patch?: unknown } }).bundle?.patch
  if (typeof patch !== 'string' || patch === '') return '声明了 dsh 但没有 dsh.bundle.patch，无法作为插件加载'
  return undefined
}

/** Does this plugin also ship a browser-side half? */
export function hasClientHalf(manifest: unknown): boolean {
  if (manifest === null || typeof manifest !== 'object') return false
  const client = (manifest as { dsh?: { client?: unknown } }).dsh?.client
  return client !== null && typeof client === 'object' && !Array.isArray(client)
}

/** Keywords worth showing: drop the generic ones every plugin carries. */
export function displayKeywords(raw: unknown, limit = 5): readonly string[] {
  if (!Array.isArray(raw)) return []
  const generic = new Set(['dsh', 'plugin', 'dsh-plugin', 'deepseek', 'harness', 'deepseek-harness', 'marketplace'])
  return raw
    .filter((entry): entry is string => typeof entry === 'string' && entry !== '' && !generic.has(entry.toLowerCase()))
    .slice(0, limit)
}

/**
 * Build one list entry from a search hit plus its confirmed manifest.
 *
 * The spec is pinned to the exact version: pnpm's fresh-release hold would otherwise substitute an
 * older version silently, which is how a user ends up on a build they did not choose.
 *
 * @param name - Package name.
 * @param version - Version to install (the packument's `dist-tags.latest`).
 * @param hit - The search hit, for description/keywords/date.
 * @param manifest - The confirmed version manifest.
 */
export function toMarketPackage(
  name: string,
  version: string,
  hit: { readonly description?: unknown; readonly keywords?: unknown; readonly date?: unknown },
  manifest: unknown,
): MarketPackage {
  const raw = typeof hit.description === 'string' ? hit.description.trim() : ''
  return {
    name,
    version,
    description: raw.length > 160 ? `${raw.slice(0, 157)}…` : raw,
    published: typeof hit.date === 'string' ? hit.date : '',
    keywords: displayKeywords(hit.keywords),
    spec: `${name}@${version}`,
    client: hasClientHalf(manifest),
  }
}

/** What the catalog needs from the outside: a JSON GET, and the current time. */
export interface MarketCatalogOptions {
  /** Fetches and parses JSON; must throw on a non-2xx response. */
  readonly getJson: (url: string) => Promise<unknown>
  /** Registry origin, for mirrors and tests. */
  readonly origin?: string
  /** Maximum admitted packages returned. */
  readonly limit?: number
  /** How many search hits to confirm against their packument. */
  readonly candidates?: number
}

/** The three packages the registry's loose matching is most likely to put first. */
function pickLatest(packument: unknown): { version?: string; manifest?: unknown } {
  if (packument === null || typeof packument !== 'object') return {}
  const document = packument as { 'dist-tags'?: { latest?: unknown }; versions?: Record<string, unknown> }
  const latest = document['dist-tags']?.latest
  if (typeof latest !== 'string' || latest === '') return {}
  return { version: latest, manifest: document.versions?.[latest] }
}

/**
 * Search the registry and confirm every candidate, or explain why it was skipped.
 *
 * @param query - Free-text query from the search box; empty means "show popular plugins".
 * @param options - Registries, caps and the JSON transport.
 * @returns Admitted plugins plus the rejected candidates.
 */
export async function searchMarketPackages(
  query: string,
  options: MarketCatalogOptions,
): Promise<MarketSearchResult> {
  const origin = options.origin ?? REGISTRY_ORIGIN
  const text = query.trim() === '' ? 'keywords:dsh-plugin' : query.trim()
  const candidates = options.candidates ?? 25
  const limit = options.limit ?? 40

  const searched = await options.getJson(searchUrl(text, candidates, origin))
  const objects = (searched as { objects?: unknown }).objects
  const hits = Array.isArray(objects) ? objects : []

  const packages: MarketPackage[] = []
  const skipped: { name: string; reason: string }[] = []
  for (const hit of hits) {
    const entry = hit as { package?: { name?: unknown; description?: unknown; keywords?: unknown; date?: unknown } }
    const name = entry.package?.name
    if (typeof name !== 'string' || name === '') continue
    if (isPlatformPackage(name)) {
      skipped.push({ name, reason: '平台自身（@deepseek-ai/dsh*），不是插件' })
      continue
    }
    if (packages.length >= limit) break
    const packument = await options.getJson(packumentUrl(name, origin))
    const { version, manifest } = pickLatest(packument)
    if (version === undefined) {
      skipped.push({ name, reason: 'registry 没有可用的 latest 版本' })
      continue
    }
    const reason = rejectReason(name, manifest)
    if (reason !== undefined) {
      skipped.push({ name, reason })
      continue
    }
    packages.push(toMarketPackage(name, version, entry.package ?? {}, manifest))
  }
  return { query: text, packages, total: packages.length, skipped }
}
