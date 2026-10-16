/**
 * The market's adapters: the two places where our own code meets the outside world.
 *
 * Everything above this file is pure and injected (`market-catalog.ts`, `market-install.ts`); this is
 * where a real `fetch` and a real child process appear, and where the profile's `package.json` is
 * actually read and written. Keeping that boundary in one small file is what makes the rest testable
 * without a network, pnpm or a profile.
 *
 * The child process is deliberately **not** launched through a shell: `node.exe <pnpm.cjs> <args>`
 * with `shell: false` means no `cmd.exe`, so no console window and no path-quoting hazard — and now
 * that a real console-subsystem node ships with the runtime, the grandchildren keep inheriting the
 * invisible console instead of allocating a new one.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { packumentUrl, searchMarketPackages, type MarketSearchResult } from './market-catalog.ts'
import { countByCategory, fetchCatalog, filterByCategory, searchCatalog, sortCatalog, type Catalog, type CatalogSort } from './market-catalog-source.ts'
import { inspectGithubPlugin } from './market-github.ts'
import type { MarketSearchRequest } from './market-ipc.ts'
import { appendMarketLog, marketLogPath, readMarketLog, type MarketLogEntry } from './market-log.ts'
import { diagnoseConflicts, readConflictWorld, type ConflictFinding, type StoreFacts } from './market-conflict.ts'
import {
  runMarketAction,
  resolveMarketRuntime,
  type MarketAction,
  type MarketActionResult,
  type MarketInstallOptions,
  type ProfileManifest,
} from './market-install.ts'

/** Defaults that keep one slow registry from freezing the window. */
export const FETCH_TIMEOUT_MS = 20_000
/** pnpm can legitimately take minutes on a cold store; the action UI stays cancellable. */
export const PNPM_TIMEOUT_MS = 15 * 60_000
/** Registry requests must identify themselves; npm blocks anonymous-looking bulk traffic. */
export const USER_AGENT = 'dsh-desktop-market/1.0 (+https://github.com/gzh330205/deepseek-harness-desktop)'

/** A JSON GET that fails loudly instead of returning `undefined` on an HTTP error. */
export type JsonFetcher = (url: string) => Promise<unknown>

/**
 * Fetch JSON with a timeout and an explicit failure for non-2xx.
 *
 * @param url - Registry URL.
 * @param options - Timeout, identity, and an injectable `fetch` for tests.
 */
export async function fetchJson(
  url: string,
  options: { readonly timeoutMs?: number; readonly fetchImpl?: typeof fetch } = {},
): Promise<unknown> {
  const doFetch = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const response = await doFetch(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT }, signal: controller.signal })
    if (!response.ok) throw new Error(`registry ${String(response.status)} ${response.statusText}`.trim())
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/** What one pnpm run produced. */
export interface PnpmRunResult {
  readonly code: number | null
  readonly output: string
}

/**
 * Run pnpm's JavaScript entry on a node executable and collect its output.
 *
 * stdout and stderr are merged on purpose: pnpm reports failures on both, and a diagnostics pane that
 * shows only half of the story is worse than none. `shell: false` keeps `cmd.exe` (and therefore any
 * console window) out of the picture entirely.
 *
 * @param options - Executables, working directory, args and timeout.
 */
export function runPnpm(
  options: {
    readonly nodeExecutable: string
    readonly pnpmEntry: string
    readonly args: readonly string[]
    readonly cwd: string
    readonly environment: NodeJS.ProcessEnv
    readonly timeoutMs?: number
    readonly appBinary?: boolean
  },
): Promise<PnpmRunResult> {
  return new Promise(resolve => {
    const child = spawn(options.nodeExecutable, [options.pnpmEntry, ...options.args], {
      cwd: options.cwd,
      env: options.environment,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const append = (chunk: Buffer): void => {
      output += chunk.toString('utf8')
      // Keep the tail bounded: a pathological install can print megabytes, and the UI shows the end.
      if (output.length > 256 * 1024) output = output.slice(-192 * 1024)
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    const timer = setTimeout(() => {
      append(Buffer.from(`\n[market] 超时 ${String(options.timeoutMs ?? PNPM_TIMEOUT_MS)} ms，已终止 pnpm\n`))
      child.kill()
    }, options.timeoutMs ?? PNPM_TIMEOUT_MS)
    child.on('error', error => {
      clearTimeout(timer)
      resolve({ code: null, output: `${output}\n[market] ${error.message}` })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, output })
    })
  })
}

/** Read the profile manifest, tolerating a missing or broken file. */
export function readProfileManifest(profileDir: string): ProfileManifest {
  const path = join(profileDir, 'package.json')
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed as ProfileManifest : {}
  } catch {
    return {}
  }
}

/**
 * Write the profile manifest atomically.
 *
 * The harness reads this file at boot: a truncated write (crash, power loss) would leave a profile
 * that cannot start, so the new content lands under a temporary name and is renamed into place.
 *
 * @param profileDir - The profile directory.
 * @param manifest - Manifest to persist.
 */
export function writeProfileManifest(profileDir: string, manifest: ProfileManifest): void {
  const path = join(profileDir, 'package.json')
  const temporary = `${path}.market.tmp`
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
}

/** Everything the market window needs from the shell. */
export interface MarketServiceOptions {
  /** Profile whose `package.json`/`node_modules` actions apply to. */
  readonly profileDir: string
  /** Prepared runtime root (`resources/…/dsh`), for the bundled node and pnpm. */
  readonly runtimeRoot: string
  /** The app binary, used only when the runtime has no bundled node. */
  readonly appExecutable: string
  /** Injected for tests. */
  readonly fetchJsonImpl?: JsonFetcher
  /** Injected for tests. */
  readonly runPnpmImpl?: MarketInstallOptions['runPnpm']
  /** Progress/log sink (the window's activity line). */
  readonly log?: (line: string) => void
  /** Directory for the action log (the shell's log directory); omit to keep no file log. */
  readonly logDir?: string
}

/**
 * The market, as the window sees it: search, install, update, uninstall.
 *
 * A thin coordinator on purpose — each layer below it owns one decision (what may be offered; what
 * pnpm is asked to do; how the profile changes), so this class only has to sequence them and turn
 * "the runtime is not where we expected" into an actionable result rather than a crash.
 */
export class MarketService {
  readonly #options: MarketServiceOptions
  /**
   * The catalog, kept in memory for a short while.
   *
   * The document is ~5 MB and the upstream market refetches it on every open; we refetch per open too,
   * but a user who switches category or pages does not pay for it again. Deliberately not persisted:
   * per the upstream market's own reasoning, a stale catalog answers "this plugin does not exist" for
   * something published this morning, and a wrong answer is worse than a slow one.
   */
  #catalogCache: { readonly at: number; readonly catalog: Catalog } | undefined

  constructor(options: MarketServiceOptions) {
    this.#options = options
  }

  /** Where the actions run, for display and for error messages. */
  get profileDir(): string {
    return this.#options.profileDir
  }

  /**
   * Search one page of the catalog.
   *
   * The registry is walked (and its noise filtered) by `searchMarketPackages`; this only forwards the
   * window's page/filter choices, because the window owns what the user asked for. The whole thing is
   * bounded by a deadline: an interactive search must always settle, or the window stays disabled and
   * the search looks broken — which is exactly how it was reported.
   */
  search(request: MarketSearchRequest): Promise<MarketSearchResult> {
    const getJson = this.#options.fetchJsonImpl ?? (url => fetchJson(url))
    return withDeadline(searchMarketPackages(request.query, {
      getJson,
      from: request.from ?? 0,
      limit: request.pageSize ?? 20,
      // Interactive budget: 30 candidates per registry page and at most two pages. A search is a
      // fallback path (the catalog is the main one), and every extra candidate is another request the
      // user waits for with the button disabled.
      candidates: 30,
      fillPages: 2,
      sort: request.sort ?? 'relevance',
      // `exactOptionalPropertyTypes` is on, so an absent filter must be an absent key.
      ...(request.clientOnly === true ? { filter: { clientOnly: true } } : {}),
    }), SEARCH_DEADLINE_MS, 'registry 查询超时（网络慢，或 registry 不可达）')
  }

  /**
   * The browsable catalog: one request, then everything is local.
   *
   * A category chip click, a sort change and typing in the box all go through here and cost nothing
   * beyond this process — which is what makes "the market opens with a list" possible at all.
   */
  async browse(request: {
    readonly query?: string
    readonly category?: string
    readonly sort?: CatalogSort
    readonly page?: number
    readonly pageSize?: number
    /** Ignore a cached copy and refetch (the window's "reload" button). */
    readonly refresh?: boolean
  } = {}): Promise<{
    readonly categories: readonly { readonly id: string; readonly en?: string; readonly zh?: string }[]
    /** Entries per category over the whole catalog (a chip's number must not depend on the page). */
    readonly categoryCounts: Readonly<Record<string, number>>
    readonly updated?: string
    readonly total: number
    readonly page: number
    readonly pageSize: number
    readonly entries: readonly unknown[]
    readonly installed: readonly string[]
  }> {
    const getJson = this.#options.fetchJsonImpl ?? (url => fetchJson(url))
    const catalog = await this.#catalog(getJson, request.refresh === true)
    const filtered = searchCatalog(filterByCategory(catalog.entries, request.category), request.query ?? '')
    const sorted = sortCatalog(filtered, request.sort ?? 'stars')
    const pageSize = Math.min(120, Math.max(1, Math.trunc(request.pageSize ?? 40)))
    const page = Math.max(0, Math.trunc(request.page ?? 0))
    const start = page * pageSize
    return {
      categories: catalog.categories,
      categoryCounts: countByCategory(catalog.entries),
      ...(catalog.updated === undefined ? {} : { updated: catalog.updated }),
      total: sorted.length,
      page,
      pageSize,
      entries: sorted.slice(start, start + pageSize),
      installed: this.installed().map(entry => entry.name),
    }
  }

  /** Fetch the catalog, reusing a recent copy within the window. */
  async #catalog(getJson: JsonFetcher, refresh = false): Promise<Catalog> {
    const cached = this.#catalogCache
    if (!refresh && cached !== undefined && Date.now() - cached.at < 10 * 60 * 1000) return cached.catalog
    const catalog = await fetchCatalog(getJson)
    this.#catalogCache = { at: Date.now(), catalog }
    return catalog
  }
  /** Install an exact version. */
  install(name: string, version: string): Promise<MarketActionResult> {
    return this.#act('install', name, version)
  }

  /** Move a plugin to an exact version. */
  update(name: string, version: string): Promise<MarketActionResult> {
    return this.#act('update', name, version)
  }

  /** Remove a plugin and unregister its bundle. */
  uninstall(name: string): Promise<MarketActionResult> {
    return this.#act('uninstall', name)
  }

  /**
   * Install a plugin straight from GitHub — the case where it is in neither the catalog's npm mapping
   * nor the registry.
   *
   * The repository's own manifest is read and vetted **before** anything touches the profile. That
   * ordering is the point: a package that declares no `dsh` cannot be registered as a bundle, and
   * installing it first only to remove it afterwards would change the profile in between. The name
   * that gets registered is the one the repository declares (`portable-dsh-multi-agent`, not the
   * catalog's `portable-dsh-multi-agent-plugin`), because that is the name the harness looks up.
   *
   * @param input - `owner/repo`, a repository URL, or a release tarball URL (optionally with a ref).
   */
  async installFromGithub(input: string): Promise<MarketActionResult> {
    const getJson = this.#options.fetchJsonImpl ?? (url => fetchJson(url))
    const inspected = await inspectGithubPlugin(getJson, input)
    if ('reason' in inspected) {
      return {
        ok: false,
        action: 'install',
        name: input,
        spec: input,
        code: null,
        output: inspected.reason,
        failure: {
          kind: inspected.kind,
          message: inspected.reason,
          hint: '示例：owner/repo、https://github.com/owner/repo，或仓库发布页里的 .tgz 地址',
        },
        bundleRegistered: false,
      }
    }
    const { source, name, spec, scripts } = inspected.plugin
    this.#options.log?.(`从 GitHub 安装 ${source.owner}/${source.repo} → ${name}${scripts.length === 0 ? '' : `（会执行安装脚本：${scripts.join('、')}）`}`)
    return this.#act('install', name, undefined, spec)
  }

  /** Read a GitHub source without installing it: what the window shows before the user commits. */
  async inspectGithub(input: string): Promise<{ readonly ok: boolean; readonly name?: string; readonly version?: string; readonly spec?: string; readonly scripts?: readonly string[]; readonly reason?: string }> {
    const getJson = this.#options.fetchJsonImpl ?? (url => fetchJson(url))
    const inspected = await inspectGithubPlugin(getJson, input)
    if ('reason' in inspected) return { ok: false, reason: inspected.reason }
    return {
      ok: true,
      name: inspected.plugin.name,
      ...(inspected.plugin.version === undefined ? {} : { version: inspected.plugin.version }),
      spec: inspected.plugin.spec,
      scripts: inspected.plugin.scripts,
    }
  }

  /** Plugin names the profile currently declares, in the window's list order. */
  installed(): readonly { readonly name: string; readonly spec: string }[] {
    const dependencies = readProfileManifest(this.#options.profileDir).dependencies ?? {}
    return Object.entries(dependencies).map(([name, spec]) => ({ name, spec }))
  }

  async #act(action: MarketAction, name: string, version?: string, spec?: string): Promise<MarketActionResult> {
    const { profileDir, runtimeRoot, appExecutable } = this.#options
    // pnpm runs with `cwd` = the profile, and a spawn whose `cwd` does not exist fails with ENOENT
    // **naming the executable** — a message that reads like "the runtime is missing" while the real
    // problem is an empty profile directory (fresh `DSH_HOME`, or a first run before seeding). Creating
    // it first costs nothing and removes the whole class of confusion.
    try {
      mkdirSync(profileDir, { recursive: true })
    } catch {
      // A profile we cannot create will fail below with pnpm's own error, which is the useful one.
    }
    const runtime = resolveMarketRuntime(runtimeRoot, appExecutable)
    if (runtime === undefined) {
      return {
        ok: false,
        action,
        name,
        spec: name,
        code: null,
        output: `随包运行时里找不到 pnpm 的入口：${join(runtimeRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')}`,
        failure: { kind: 'unknown', message: '随包运行时不可用', hint: '重新安装 DSH Desktop，或在诊断信息里查看运行时路径' },
        bundleRegistered: false,
      }
    }
    this.#options.log?.(`${action} ${spec ?? name}${version === undefined || spec !== undefined ? '' : `@${version}`}（${runtime.appBinary ? '应用二进制' : '随包 node'}）`)
    const run = this.#options.runPnpmImpl ?? ((args, environment) => runPnpm({
      nodeExecutable: runtime.nodeExecutable,
      pnpmEntry: runtime.pnpmEntry,
      args,
      cwd: profileDir,
      environment,
      appBinary: runtime.appBinary,
    }))
    const started = Date.now()
    const result = await runMarketAction(action, name, {
      profileDir,
      nodeExecutable: runtime.nodeExecutable,
      pnpmEntry: runtime.pnpmEntry,
      appBinary: runtime.appBinary,
      readManifest: () => readProfileManifest(profileDir),
      writeManifest: manifest => { writeProfileManifest(profileDir, manifest) },
      runPnpm: run,
    }, version, spec)
    // Recorded even when it succeeded: "it worked yesterday" is only checkable if successes are logged.
    this.#record({
      at: new Date().toISOString(),
      action,
      name,
      spec: result.spec,
      ok: result.ok,
      code: result.code,
      ms: Date.now() - started,
      ...(result.failure === undefined ? {} : { kind: result.failure.kind, message: result.failure.message }),
      ...(result.output === '' ? {} : { output: result.output }),
    })
    return result
  }

  /** The tail of the action log, newest last (the window shows this). */
  log(limit = 50): readonly MarketLogEntry[] {
    const dir = this.#options.logDir
    return dir === undefined ? [] : readMarketLog(dir, limit)
  }

  /** Where the action log lives, for the window to show (empty when file logging is off). */
  logPath(): string {
    const dir = this.#options.logDir
    return dir === undefined ? '' : marketLogPath(dir)
  }

  /**
   * Compare every installed plugin against the registry.
   *
   * Only registry specs can be compared: a `link:`/`file:` dependency is the user own checkout and a
   * `github:` one carries no version at all. Those are reported as "cannot compare" rather than
   * silently looking up to date — a wrong "up to date" is worse than an honest "unknown".
   */
  async checkUpdates(): Promise<readonly MarketUpdateStatus[]> {
    const getJson = this.#options.fetchJsonImpl ?? (url => fetchJson(url))
    const statuses: MarketUpdateStatus[] = []
    for (const entry of this.installed()) {
      const source = specSource(entry.spec)
      if (source !== 'registry') {
        statuses.push({ name: entry.name, current: entry.spec, hasUpdate: false, source, reason: '不是 registry 版本，无法比较' })
        continue
      }
      const current = stripRangePrefix(entry.spec)
      try {
        const document = await getJson(packumentUrl(entry.name))
        const latest = latestVersion(document)
        statuses.push({
          name: entry.name,
          current,
          ...(latest === undefined ? {} : { latest }),
          hasUpdate: latest !== undefined && compareVersions(latest, current) > 0,
          source: 'registry',
        })
      } catch (error) {
        statuses.push({ name: entry.name, current, hasUpdate: false, source: 'registry', reason: error instanceof Error ? error.message : String(error) })
      }
    }
    return statuses
  }

  /**
   * Diagnose this profile: contradictions provable from local files.
   *
   * The store comparison is the interesting one — it is the same mismatch the shell relinks at startup,
   * so seeing it here means the relink did not take effect (or the app has not been restarted since).
   */
  diagnose(): readonly ConflictFinding[] {
    const store = readStoreFacts(this.#options.runtimeRoot, this.#options.profileDir)
    return diagnoseConflicts(readConflictWorld(this.#options.profileDir, { store }))
  }
  /** Append one entry to the action log, if file logging is configured. */
  #record(entry: MarketLogEntry): void {
    const dir = this.#options.logDir
    if (dir === undefined) return
    appendMarketLog(dir, entry)
  }
}
/** How one installed plugin compares to the registry. */
export interface MarketUpdateStatus {
  readonly name: string
  /** What the profile declares (`^1.2.3`, a version, or a link/git spec). */
  readonly current: string
  /** Latest version the registry reports, when it could be determined. */
  readonly latest?: string
  readonly hasUpdate: boolean
  /** `registry` can be compared; anything else cannot. */
  readonly source: 'registry' | 'other'
  /** Why it could not be compared, or what went wrong while checking. */
  readonly reason?: string
}

/**
 * Classify a dependency spec by whether a registry version can be compared against it.
 *
 * A registry spec is a version or a version range (`1.2.3`, `^1.2.3`, `~1.2.3`, `>=1.2.3`).
 * `link:`/`file:` point at a checkout and `github:`/`git+…` at a revision: neither has a "latest"
 * to compare with, and pretending they are up to date would be a lie the user cannot see through.
 */
export function specSource(spec: string): 'registry' | 'other' {
  const trimmed = spec.trim()
  if (trimmed === '') return 'other'
  if (/^(link|file|portal|workspace|git|git\+|https?):/iu.test(trimmed)) return 'other'
  const rest = stripRangePrefix(trimmed)
  const first = rest.slice(0, 1)
  return first >= '0' && first <= '9' ? 'registry' : 'other'
}

/**
 * Drop the range decoration a version spec may carry, so the first digit is where a version starts.
 *
 * Written as a scan rather than a character-class regex on purpose: this file is edited by scripts as
 * often as by hand, and a `\\d`/`\\s` that survives one escaping layer too many silently turns a
 * working classifier into "everything is incomparable".
 *
 * @param spec - A dependency spec such as `^1.2.3`, `>=2.0.0` or `v1.0.0`.
 * @returns The spec without leading `^ ~ > < = v` and spaces.
 */
export function stripRangePrefix(spec: string): string {
  const decoration = '^~><=vV '
  let index = 0
  while (index < spec.length && decoration.includes(spec.slice(index, index + 1))) index += 1
  return spec.slice(index)
}

/**
 * Compare two versions the way a user reads them: numerically, release over prerelease.
 *
 * Deliberately small — this only decides whether to *offer* an update, and a wrong "yes" costs one
 * click, while a wrong "no" is the failure mode worth avoiding. Build metadata is ignored (as in
 * semver) and a missing part counts as zero (`1.2` == `1.2.0`).
 */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const [core = '', pre = ''] = value.trim().replace(/^v/u, '').split('-', 2)
    const parts = core.split('.').map(part => Number.parseInt(part, 10))
    return { parts: [0, 1, 2].map(index => Number.isFinite(parts[index]) ? (parts[index] as number) : 0), pre }
  }
  const a = parse(left); const b = parse(right)
  for (let index = 0; index < 3; index++) {
    if (a.parts[index] !== b.parts[index]) return (a.parts[index] as number) > (b.parts[index] as number) ? 1 : -1
  }
  if (a.pre === b.pre) return 0
  if (a.pre === '') return 1
  if (b.pre === '') return -1
  return a.pre.localeCompare(b.pre)
}

/** The version a packument calls latest, if it says so. */
function latestVersion(document: unknown): string | undefined {
  if (document === null || typeof document !== 'object') return undefined
  const latest = (document as { 'dist-tags'?: { latest?: unknown } })[ 'dist-tags' ]?.latest
  return typeof latest === 'string' && latest !== '' ? latest : undefined
}
/**
 * How long an interactive registry search may take before it is reported as a failure.
 *
 * Bounded on purpose: the window disables its button while a search is in flight, so a search that
 * never settles leaves the whole view stuck. A deadline turns that into an ordinary, explainable
 * failure the user can retry.
 */
const SEARCH_DEADLINE_MS = 25_000

/** Resolve with `work`, or reject with `message` once `ms` have passed. */
function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(message)) }, ms)
    work.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))) },
    )
  })
}

/**
 * Read the two store facts a mismatch needs, each best-effort.
 *
 * `modulesMajor` comes from the profile's `node_modules/.modules.yaml` (pnpm writes the store it used);
 * `pnpmMajor` from the bundled pnpm's own version. Either missing means "cannot tell", and the
 * diagnosis must then stay silent rather than guess.
 */
function readStoreFacts(runtimeRoot: string, profileDir: string): StoreFacts {
  let modulesMajor: string | undefined
  try {
    const match = /store\/v(\d+)/u.exec(readFileSync(join(profileDir, 'node_modules', '.modules.yaml'), 'utf8'))
    if (match?.[1] !== undefined) modulesMajor = match[1]
  } catch {
    // No modules file yet: nothing to compare against.
  }
  let pnpmMajor: string | undefined
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(runtimeRoot, 'node_modules', 'pnpm', 'package.json'), 'utf8'))
    const version = (manifest as { version?: unknown }).version
    if (typeof version === 'string' && version !== '') pnpmMajor = version.split('.')[0]
  } catch {
    // Bundled pnpm's version unreadable: skip the comparison.
  }
  return {
    ...(modulesMajor === undefined ? {} : { modulesMajor }),
    ...(pnpmMajor === undefined ? {} : { pnpmMajor }),
  }
}
