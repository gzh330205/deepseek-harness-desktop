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

import { searchMarketPackages, type MarketSearchResult } from './market-catalog.ts'
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

  /** Search the catalog (admission applied). */
  search(query: string): Promise<MarketSearchResult> {
    const getJson = this.#options.fetchJsonImpl ?? (url => fetchJson(url))
    return searchMarketPackages(query, { getJson })
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
    return runMarketAction(action, name, {
      profileDir,
      nodeExecutable: runtime.nodeExecutable,
      pnpmEntry: runtime.pnpmEntry,
      appBinary: runtime.appBinary,
      readManifest: () => readProfileManifest(profileDir),
      writeManifest: manifest => { writeProfileManifest(profileDir, manifest) },
      runPnpm: run,
    }, version)
  }
}
