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
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { packumentUrl, searchMarketPackages, type MarketSearchResult } from './market-catalog.ts'
import type { MarketSearchRequest } from './market-ipc.ts'
import { appendMarketLog, marketLogPath, readMarketLog, type MarketLogEntry } from './market-log.ts'
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
   * window's page/filter choices, because the window owns what the user asked for.
   */
  search(request: MarketSearchRequest): Promise<MarketSearchResult> {
    const getJson = this.#options.fetchJsonImpl ?? (url => fetchJson(url))
    return searchMarketPackages(request.query, {
      getJson,
      from: request.from ?? 0,
      limit: request.pageSize ?? 20,
      sort: request.sort ?? 'relevance',
      // `exactOptionalPropertyTypes` is on, so an absent filter must be an absent key.
      ...(request.clientOnly === true ? { filter: { clientOnly: true } } : {}),
    })
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

  /** Plugin names the profile currently declares, in the window's list order. */
  installed(): readonly { readonly name: string; readonly spec: string }[] {
    const dependencies = readProfileManifest(this.#options.profileDir).dependencies ?? {}
    return Object.entries(dependencies).map(([name, spec]) => ({ name, spec }))
  }

  async #act(action: MarketAction, name: string, version?: string): Promise<MarketActionResult> {
    const { profileDir, runtimeRoot, appExecutable } = this.#options
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
    this.#options.log?.(`${action} ${name}${version === undefined ? '' : `@${version}`}（${runtime.appBinary ? '应用二进制' : '随包 node'}）`)
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
    }, version)
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