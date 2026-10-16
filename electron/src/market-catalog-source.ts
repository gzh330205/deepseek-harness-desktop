/**
 * The community plugin catalog: what the market browses.
 *
 * Where this comes from, and why it is not npm search: the upstream market fetches the same public
 * list (`https://awesome-dsh-plugin.com/plugins.json` — its `lib/regions.js` names it
 * `CATALOG_OFFICIAL`) every time it opens. One request returns thousands of entries that already carry
 * a category, stars, download counts and an npm mapping, so the market can paint a full list and its
 * category chips immediately, and filter/search locally without another round trip. npm's own search is
 * the opposite shape: unranked noise that has to be confirmed one packument at a time, which is why
 * our first version opened empty until the user pressed search.
 *
 * The list is **external input**: it is treated as data, validated entry by entry, and never trusted
 * for admission — installing something from it still has to prove the package declares
 * `dsh.bundle.patch`, which is the rule the shell can verify itself.
 */

/** The catalog's stable public address. */
export const CATALOG_URL = 'https://awesome-dsh-plugin.com/plugins.json'

/** One catalog entry, after validation. */
export interface CatalogEntry {
  readonly name: string
  readonly owner?: string
  /** GitHub (or other) source URL. */
  readonly url?: string
  /** Human-readable catalog page. */
  readonly page?: string
  /** Category id, as the catalog's own vocabulary spells it (e.g. `agi`, `ui`). */
  readonly category?: string
  readonly description?: { readonly en?: string; readonly zh?: string }
  /** npm package name, when the entry is installable from a registry. */
  readonly npm?: string
  readonly version?: string
  readonly stars: number
  readonly downloads: number
  /** What the plugin declares it needs from the machine (`fs-write`, `env`, …). */
  readonly capabilities: readonly string[]
  readonly added?: string
}

/** The catalog document itself. */
export interface Catalog {
  readonly updated?: string
  /** The category vocabulary the entries draw from, in catalog order. */
  readonly categories: readonly string[]
  readonly entries: readonly CatalogEntry[]
}

/** A string, or `undefined` when the value is not a usable one. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** A finite non-negative number, defaulting to 0 (counts are decoration, never a reason to reject). */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** A list of non-empty strings, ignoring anything else. */
function strings(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    const one = text(item)
    if (one !== undefined) out.push(one)
  }
  return out
}

/** A bilingual description, when either language is present. */
function description(value: unknown): { readonly en?: string; readonly zh?: string } | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const en = text(record.en)
  const zh = text(record.zh) ?? text(record['zh-CN'])
  if (en === undefined && zh === undefined) return undefined
  return { ...(en === undefined ? {} : { en }), ...(zh === undefined ? {} : { zh }) }
}

/**
 * Parse a catalog document.
 *
 * Malformed entries are dropped rather than failing the whole list: this is a 5 MB external document
 * that grows daily, and one bad entry must not empty the market. An entries list that is not an array
 * at all *is* a failure (the document is not what we think it is) and yields an empty catalog.
 *
 * @param document - Parsed JSON from the catalog URL.
 */
export function parseCatalog(document: unknown): Catalog {
  if (document === null || typeof document !== 'object') return { categories: [], entries: [] }
  const record = document as Record<string, unknown>
  const rawEntries = Array.isArray(record.plugins) ? record.plugins : []
  const entries: CatalogEntry[] = []
  for (const raw of rawEntries) {
    if (raw === null || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    const name = text(entry.name)
    if (name === undefined) continue
    const owner = text(entry.owner)
    const url = text(entry.url)
    const page = text(entry.page)
    const category = text(entry.category)
    const described = description(entry.description)
    const npm = text(entry.npm)
    const version = text(entry.version)
    const added = text(entry.added)
    entries.push({
      name,
      stars: count(entry.stars),
      downloads: count(entry.downloads),
      capabilities: strings(entry.capabilities),
      ...(owner === undefined ? {} : { owner }),
      ...(url === undefined ? {} : { url }),
      ...(page === undefined ? {} : { page }),
      ...(category === undefined ? {} : { category }),
      ...(described === undefined ? {} : { description: described }),
      ...(npm === undefined ? {} : { npm }),
      ...(version === undefined ? {} : { version }),
      ...(added === undefined ? {} : { added }),
    })
  }
  return {
    ...(text(record.updated) === undefined ? {} : { updated: text(record.updated) as string }),
    categories: strings(record.categories),
    entries,
  }
}

/**
 * Fetch and parse the catalog.
 *
 * @param getJson - Transport (the shell's own `fetchJson`, so timeouts and the non-2xx rule apply).
 * @param options - Override the URL (tests, or a mirror).
 */
export async function fetchCatalog(
  getJson: (url: string) => Promise<unknown>,
  options: { readonly url?: string } = {},
): Promise<Catalog> {
  const document = await getJson(options.url ?? CATALOG_URL)
  return parseCatalog(document)
}

/** Filter to one category (`''` or `undefined` means "all"). */
export function filterByCategory(entries: readonly CatalogEntry[], category: string | undefined): readonly CatalogEntry[] {
  if (category === undefined || category === '') return entries
  return entries.filter(entry => entry.category === category)
}

/** How a list of entries is ordered. */
export type CatalogSort = 'stars' | 'downloads' | 'name' | 'added'

/** Sort a copy, descending for counts and ascending for names. */
export function sortCatalog(entries: readonly CatalogEntry[], sort: CatalogSort = 'stars'): readonly CatalogEntry[] {
  const copy = [...entries]
  if (sort === 'name') return copy.sort((left, right) => left.name.localeCompare(right.name))
  if (sort === 'added') return copy.sort((left, right) => (right.added ?? '').localeCompare(left.added ?? ''))
  if (sort === 'downloads') return copy.sort((left, right) => right.downloads - left.downloads)
  return copy.sort((left, right) => right.stars - left.stars)
}

/**
 * Local search over the catalog — no network, so it can run on every keystroke.
 *
 * @param entries - The catalog's entries.
 * @param query - Free text; matched against name, owner, both descriptions and capabilities.
 */
export function searchCatalog(entries: readonly CatalogEntry[], query: string): readonly CatalogEntry[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return entries
  return entries.filter(entry => {
    const haystack = [
      entry.name,
      entry.owner ?? '',
      entry.category ?? '',
      entry.description?.en ?? '',
      entry.description?.zh ?? '',
      entry.capabilities.join(' '),
    ].join(' ').toLowerCase()
    return haystack.includes(needle)
  })
}
