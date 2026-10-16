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

/**
 * How many candidate packuments are fetched at once while confirming a registry page.
 *
 * The search is interactive: every confirmed candidate is one HTTP request, and doing them one at a
 * time made a normal search take seconds — and a page-filling search tens of seconds — with the
 * window's button disabled the whole time, which reads as "the search is broken". Six keeps the
 * registry happy while cutting that wait by roughly the same factor.
 */
export const CONFIRM_CONCURRENCY = 8

/** Quote a package name for a registry URL: the scope separator is the only character that needs it. */
export function packumentUrl(name: string, origin: string = REGISTRY_ORIGIN): string {
  return `${origin}/${name.startsWith('@') ? name.replace('/', '%2F') : name}`
}

/**
 * npm's search endpoint for a free-text query.
 *
 * `from` is the registry's offset: this is how the window pages deeper into the catalog instead of
 * being stuck with the first handful of hits.
 */
export function searchUrl(query: string, size: number, origin: string = REGISTRY_ORIGIN, from = 0): string {
  return `${origin}/-/v1/search?text=${encodeURIComponent(query)}&size=${String(size)}&from=${String(Math.max(0, from))}`
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
  /** How many admitted packages this page holds. */
  readonly total: number
  /** Page bookkeeping, so the window can show which page it is on and offer a next one. */
  readonly page: {
    /** Registry offset this page started from. */
    readonly from: number
    /** How many admitted entries were asked for. */
    readonly size: number
    /** True when another page may exist (the registry still had hits after this one). */
    readonly hasMore: boolean
    /** Registry hits consumed to fill this page. */
    readonly scanned: number
  }
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
 * The upstream market itself, which we must not install as a plugin.
 *
 * Two reasons, both ours: the shell already owns the market (a second UI drifts from it), and the
 * upstream market's install path is the broken one this shell exists to replace. It declares `dsh`, so
 * only an explicit rule keeps it out of the list.
 */
export function isUpstreamMarket(name: string): boolean {
  return name === 'dshmarket' || name === 'dsh-market' || name === '@deepseek-ai/dsh-market'
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
  if (isUpstreamMarket(name)) return '上游市场自己（dshmarket），壳内已有市场，装两套市场界面会互相干扰'
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
  /** How many search hits to confirm against their packument (per registry page). */
  readonly candidates?: number
  /** Registry offset to start from (npm's `from`), so the window can page through the catalog. */
  readonly from?: number
  /** Sorting applied to the admitted entries of one page. */
  readonly sort?: 'relevance' | 'updated' | 'name'
  /** Keep only entries a user asked for. */
  readonly filter?: {
    /** Only plugins that also inject a browser half (`dsh.client`). */
    readonly clientOnly?: boolean
    /** Only these plugin names (the window's installed view). */
    readonly names?: readonly string[]
  }
  /**
   * How many registry pages to walk in order to fill one result page.
   *
   * Registry hits are mostly *not* plugins: a `dsh` query returns thousands of unrelated packages and
   * admission rejects them. Without this, page two of the window would show three entries and look
   * broken. Bounded, because each page costs one request per candidate.
   */
  readonly fillPages?: number
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
/**
 * Search the registry and confirm candidates until one page of admitted plugins is full.
 *
 * Two things make this more than a registry call. First, **admission**, which needs each candidate's
 * own packument (a search hit does not carry `dsh`). Second, **filling**: registry hits are mostly not
 * plugins, so a naive "read 20 hits, keep the 4 plugins" makes page 2 look broken. This walks up to
 * `fillPages` registry pages until `size` admitted entries are found or the registry runs out, and
 * reports both the registry position and how many hits that cost.
 *
 * @param query - Free-text query; empty means "the plugin keyword".
 * @param options - Registry, page size/offset, filters, transport.
 * @returns One page of admitted plugins plus the bookkeeping the window needs.
 */
export async function searchMarketPackages(
  query: string,
  options: MarketCatalogOptions,
): Promise<MarketSearchResult> {
  const origin = options.origin ?? REGISTRY_ORIGIN
  const text = query.trim() === '' ? 'keywords:dsh-plugin' : query.trim()
  const size = options.limit ?? 20
  const perPage = options.candidates ?? 50
  const fillPages = Math.max(1, options.fillPages ?? 4)
  const filter = options.filter ?? {}
  const wanted = filter.names === undefined ? undefined : new Set(filter.names)
  const startFrom = Math.max(0, options.from ?? 0)

  const packages: MarketPackage[] = []
  const skipped: { name: string; reason: string }[] = []
  let from = startFrom
  let scanned = 0
  let hasMore = false

  for (let page = 0; page < fillPages; page++) {
    const searched = await options.getJson(searchUrl(text, perPage, origin, from))
    const objects = (searched as { objects?: unknown }).objects
    const hits = Array.isArray(objects) ? objects : []
    if (hits.length === 0) break
    scanned += hits.length
    hasMore = hits.length >= perPage
    // Confirm candidates in small parallel windows rather than one request at a time. Sequential
    // confirmation is what made a registry search take ~8 s — and far longer once several registry
    // pages had to be walked — during which the window's button stayed disabled and the search looked
    // broken from the outside. Order is preserved and we still stop as soon as the page is full.
    const candidates: { readonly name: string; readonly summary: Record<string, unknown> }[] = []
    for (const hit of hits) {
      const entry = hit as { package?: Record<string, unknown> }
      const name = entry.package?.name
      if (typeof name !== 'string' || name === '') continue
      if (isPlatformPackage(name)) {
        skipped.push({ name, reason: '平台自身（@deepseek-ai/dsh*），不是插件' })
        continue
      }
      if (isUpstreamMarket(name)) {
        skipped.push({ name, reason: '上游市场自己（dshmarket），壳内已有市场' })
        continue
      }
      // The window's "已安装" view asks for specific names: no reason to confirm the rest.
      if (wanted !== undefined && !wanted.has(name)) continue
      candidates.push({ name, summary: entry.package ?? {} })
    }

    for (let start = 0; start < candidates.length && packages.length < size; start += CONFIRM_CONCURRENCY) {
      const window = candidates.slice(start, start + CONFIRM_CONCURRENCY)
      const confirmed = await Promise.all(window.map(async candidate => {
        const packument = await options.getJson(packumentUrl(candidate.name, origin))
        const { version, manifest } = pickLatest(packument)
        if (version === undefined) return { name: candidate.name, reason: 'registry 没有可用的 latest 版本' }
        const reason = rejectReason(candidate.name, manifest)
        if (reason !== undefined) return { name: candidate.name, reason }
        const admitted = toMarketPackage(candidate.name, version, candidate.summary, manifest)
        if (filter.clientOnly === true && !admitted.client) return undefined
        return admitted
      }))
      for (const result of confirmed) {
        if (result === undefined) continue
        if ('reason' in result) {
          skipped.push({ name: result.name, reason: result.reason })
          continue
        }
        packages.push(result)
        if (packages.length >= size) break
      }
    }
    from += hits.length
    if (packages.length >= size || !hasMore) break
  }

  return {
    query: text,
    packages: sortPackages(packages, options.sort),
    total: packages.length,
    page: { from: startFrom, size, hasMore, scanned },
    skipped,
  }
}

/** Relevance is the registry's own order; the other two orders are ours. */
export function sortPackages(
  packages: readonly MarketPackage[],
  sort: MarketCatalogOptions['sort'],
): MarketPackage[] {
  const copy = [...packages]
  if (sort === 'updated') {
    return copy.sort((left, right) => (right.published || '').localeCompare(left.published || ''))
  }
  if (sort === 'name') return copy.sort((left, right) => left.name.localeCompare(right.name))
  return copy
}
