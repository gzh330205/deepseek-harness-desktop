/**
 * Provision the plugins that ship with the shell into the DSH profile.
 *
 * The four panels (git changes, run configurations, workspace categories, sidebar width) used to be
 * installed from the market as `dsh-plugin-kit` and its children. The user asked for them to travel
 * with the shell instead of being maintained separately, so:
 *
 * - the compiled plugins are packed next to the app (`resources/plugins`, see
 *   `scripts/prepare-plugins.mjs`);
 * - this module links each one into the profile's `node_modules`, which is where the loader entries
 *   resolve package names from, and registers each package in the profile's
 *   `dsh.profile.bundles` — the list the harness actually loads. Each shipped package carries its
 *   own `dsh.bundle.patch` (a `- insert:` row), so *registering the package* is the whole injection:
 *   writing `{ id, name }` rows into the user's patch does not work, because a top-level patch entry
 *   that carries a `name` is only an assertion that the row already exists (see the vendor loader's
 *   `applyEntryPatches`) and never inserts one. Links, not copies: the app updates in place and the
 *   profile must not keep a stale duplicate;
 * - `dsh-plugin-kit` is removed from the profile: its only remaining job was hosting settings tabs,
 *   and the MCP/Skills and ONE-WAY windows now own those features.
 *
 * Every step is idempotent and the profile files are backed up before they are changed, because this
 * runs on every start against a file the user may have hand-edited.
 */

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import type { DshConfigStore } from './dsh-config.ts'

/** Plugin rows/names that the shell now owns and must not be loaded as plugins any more. */
const RETIRED_ROWS = ['dsh-oneway-usage-monitor', 'dsh-mcp-skill-manager', 'dsh-plugin-kit', 'plugin-kit']
const RETIRED_DEPENDENCIES = ['dsh-plugin-kit']
const RETIRED_BUNDLES = ['dsh-plugin-kit']

export interface ProvisionResult {
  readonly ok: boolean
  readonly reason?: string
  /** Plugin package names whose profile link was created or refreshed. */
  readonly linked: readonly string[]
  /** True when a link already pointed at the shipped copy. */
  readonly unchanged: number
  readonly removedBundles: number
  readonly removedRows: number
  /** Package names appended to the profile's `dsh.profile.bundles` (what actually mounts them). */
  readonly addedBundles: readonly string[]
}

export interface ProvisionOptions {
  /** Directory containing the shipped plugin packages (each a directory with package.json). */
  readonly pluginsRoot: string
  readonly profileDir: string
  /** The same store the MCP window uses; its `removeRows` retires the plugin rows. */
  readonly patch: DshConfigStore
  readonly log?: (line: string) => void
}

/** Write a backup next to a file before the shell edits it (one `.bak-shell-<stamp>` per change). */
export function backupFile(path: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
    const backup = `${path}.bak-shell-${stamp}`
    copyFileSync(path, backup)
    // Keep the five newest shell backups of this file; the user's own `.bak-*` files are untouched.
    try {
      const directory = dirname(path)
      const prefix = `${basename(path)}.bak-shell-`
      const backups = readdirSync(directory).filter((name) => name.startsWith(prefix)).sort()
      for (const name of backups.slice(0, Math.max(0, backups.length - 5))) rmSync(join(directory, name), { force: true })
    } catch {
      // Pruning is a courtesy.
    }
    return backup
  } catch {
    return undefined
  }
}

/** Read a directory of plugin packages: `name -> absolute path`. */
export function readShippedPlugins(pluginsRoot: string): Map<string, string> {
  const out = new Map<string, string>()
  let entries: string[]
  try {
    entries = readdirSync(pluginsRoot)
  } catch {
    return out
  }
  for (const entry of entries) {
    const directory = join(pluginsRoot, entry)
    const manifestPath = join(directory, 'package.json')
    if (!existsSync(manifestPath)) continue
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown; main?: unknown }
      if (typeof manifest.name !== 'string' || manifest.name === '') continue
      // The loader row needs an entry point; copying a package without one would only add a
      // "failed to import" at the next DSH start.
      if (typeof manifest.main !== 'string' || !existsSync(join(directory, manifest.main))) continue
      out.set(manifest.name, directory)
    } catch {
      // A malformed package is skipped; the log line in `provisionBundledPlugins` covers it.
    }
  }
  return out
}

/** Windows junctions report their target with a `\\?\` prefix; compare the plain path. */
function junctionTarget(path: string): string | undefined {
  try {
    return readlinkSync(path).replace(/^\\\\\?\\/u, '').toLowerCase()
  } catch {
    return undefined
  }
}

export interface LinkOutcome {
  readonly changed: boolean
  /** When a real directory sat where the link belongs, its backup path (never deleted). */
  readonly displaced?: string
}

/**
 * Remove the link itself, never the directory it points at.
 *
 * This is the Electron trap of the day: inside the Electron main process
 * `rmSync(<junction>, { force: true })` throws `ERR_FS_EISDIR: Path is a directory` instead of
 * removing the junction (plain Node removes it). The old code caught that error and moved on, so
 * the following `symlinkSync` failed with `EEXIST`, the outcome said "unchanged", and every shipped
 * plugin stayed frozen at its stale target with not one log line. `rmSync` with
 * `{ recursive: true }` is even worse: it follows the junction and deletes the *target's* contents
 * (verified — it must never touch a link). `unlinkSync` removes the link entry itself (works in
 * Electron), and `rmdirSync` is the fallback for the same call; if both fail the old link is left
 * alone and the caller learns about it.
 *
 * @returns true when the destination is now free, false when the stale link survives.
 */
function unlinkJunction(destination: string, log?: (line: string) => void): boolean {
  try {
    unlinkSync(destination)
    return true
  } catch {
    try {
      rmdirSync(destination)
      return true
    } catch (error) {
      log?.(`随壳插件：无法移除旧链接 ${destination}（${error instanceof Error ? error.message : String(error)}），保留原状`)
      return false
    }
  }
}

/**
 * Link one shipped package into the profile's node_modules.
 *
 * A real directory is moved aside (kept as `.bak-shell-<stamp>`), never deleted: it is either a
 * pnpm-hoisted copy from an old market install or a checkout someone made on purpose, and the shell
 * must be the copy that actually loads once it ships the plugin. The backup keeps the old version
 * recoverable and makes the replacement visible.
 */
function linkPackage(profileDir: string, name: string, target: string, log?: (line: string) => void): LinkOutcome {
  const nodeModules = join(profileDir, 'node_modules')
  mkdirSync(nodeModules, { recursive: true })
  const destination = join(nodeModules, name)
  let displaced: string | undefined
  try {
    const info = lstatSync(destination)
    if (info.isSymbolicLink()) {
      if (junctionTarget(destination) === target.toLowerCase()) return { changed: false }
      if (!unlinkJunction(destination, log)) return { changed: false }
    } else {
      const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
      displaced = `${destination}.bak-shell-${stamp}`
      renameSync(destination, displaced)
    }
  } catch {
    // Missing: create below.
  }
  try {
    symlinkSync(target, destination, 'junction')
    return { changed: true, ...(displaced === undefined ? {} : { displaced }) }
  } catch (error) {
    // Could not link (e.g. a file with that name): report unchanged rather than crash the start.
    log?.(`随壳插件：创建链接失败 ${destination}（${error instanceof Error ? error.message : String(error)}）`)
    return { changed: false }
  }
}

/**
 * Remove `dsh-plugin-kit` from the profile's dependencies and bundle list.
 *
 * Editing JSON rather than running pnpm: no network, no chance of a half-finished install, and the
 * profile keeps working even if the package itself is still on disk.
 */
export function pruneProfileManifest(profileDir: string): { readonly dependencies: number; readonly bundles: number; readonly backup?: string } {
  const path = join(profileDir, 'package.json')
  if (!existsSync(path)) return { dependencies: 0, bundles: 0 }
  let document: Record<string, unknown>
  try {
    document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return { dependencies: 0, bundles: 0 }
  }
  const dependencies = typeof document.dependencies === 'object' && document.dependencies !== null
    ? { ...document.dependencies as Record<string, unknown> }
    : {}
  let removedDependencies = 0
  for (const name of RETIRED_DEPENDENCIES) {
    if (name in dependencies) { delete dependencies[name]; removedDependencies += 1 }
  }
  const dsh = typeof document.dsh === 'object' && document.dsh !== null ? { ...document.dsh as Record<string, unknown> } : {}
  const profile = typeof dsh.profile === 'object' && dsh.profile !== null ? { ...dsh.profile as Record<string, unknown> } : {}
  const bundles = Array.isArray(profile.bundles) ? [...profile.bundles as unknown[]] : []
  const filtered = bundles.filter((bundle) => !RETIRED_BUNDLES.includes(String(bundle)))
  const removedBundles = bundles.length - filtered.length
  if (removedDependencies === 0 && removedBundles === 0) return { dependencies: 0, bundles: 0 }
  const backup = backupFile(path)
  profile.bundles = filtered
  dsh.profile = profile
  document.dependencies = dependencies
  document.dsh = dsh
  const temporary = `${path}.tmp-${String(process.pid)}`
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
  return { dependencies: removedDependencies, bundles: removedBundles, ...(backup === undefined ? {} : { backup }) }
}

/** Result of registering shipped packages in the profile's bundle list. */
export interface BundleRegistration {
  /** Package names appended to `dsh.profile.bundles`, in the order they were passed in. */
  readonly added: readonly string[]
  readonly backup?: string
}

/**
 * Register shipped plugin packages in the profile's `dsh.profile.bundles`.
 *
 * This is the same list the market writes after `pnpm add` (see `market-install.ts`), and it is the
 * only thing that makes the harness mount a package: the package itself declares its rows in
 * `dsh.bundle.patch`. Missing names are **appended** so the seeded list's order (and the user's own
 * entries) survive; existing names are never moved or duplicated. A missing or unparseable
 * `package.json` is not an error for the start path — the profile is seeded later on first run — so
 * it returns nothing instead of throwing. The file is backed up and replaced atomically, like every
 * other manifest edit in this module.
 */
export function ensureProfileBundles(profileDir: string, names: readonly string[]): BundleRegistration {
  const path = join(profileDir, 'package.json')
  if (!existsSync(path)) return { added: [] }
  let document: Record<string, unknown>
  try {
    document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return { added: [] }
  }
  const dsh = typeof document.dsh === 'object' && document.dsh !== null ? { ...document.dsh as Record<string, unknown> } : {}
  const profile = typeof dsh.profile === 'object' && dsh.profile !== null ? { ...dsh.profile as Record<string, unknown> } : {}
  const bundles = Array.isArray(profile.bundles) ? [...profile.bundles as unknown[]] : []
  const existing = new Set(bundles.map((bundle) => String(bundle)))
  const added = names.filter((name) => !existing.has(name))
  if (added.length === 0) return { added: [] }
  const backup = backupFile(path)
  profile.bundles = [...bundles, ...added]
  dsh.profile = profile
  document.dsh = dsh
  const temporary = `${path}.tmp-${String(process.pid)}`
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
  return { added, ...(backup === undefined ? {} : { backup }) }
}

/**
 * Make the shipped plugins available to the profile and retire the market-installed aggregator.
 *
 * Safe to call on every start: links are refreshed only when needed, bundle names are registered
 * only when missing (a profile that installed them from the market already lists them), the
 * manifest is rewritten only when it still names plugin-kit, and retired rows are removed only while
 * they exist.
 */
export function provisionBundledPlugins(options: ProvisionOptions): ProvisionResult {
  const log = options.log ?? (() => {})
  const shipped = readShippedPlugins(options.pluginsRoot)
  if (shipped.size === 0) return { ok: true, linked: [], unchanged: 0, removedBundles: 0, removedRows: 0, addedBundles: [], reason: '安装包里没有随壳插件' }

  const linked: string[] = []
  const displaced: string[] = []
  let unchanged = 0
  for (const [name, directory] of shipped) {
    const outcome = linkPackage(options.profileDir, name, directory, log)
    if (outcome.changed) linked.push(name)
    else unchanged += 1
    if (outcome.displaced !== undefined) displaced.push(name)
  }

  const registration = ensureProfileBundles(options.profileDir, [...shipped.keys()])
  const manifest = pruneProfileManifest(options.profileDir)
  const removedRows = options.patch.removeRows(RETIRED_ROWS).removed

  if (linked.length > 0) log(`随壳插件：已链接 ${String(linked.length)} 个（${linked.join(', ')}）到 profile`)
  if (displaced.length > 0) log(`随壳插件：${String(displaced.length)} 个旧目录已改名为 .bak-shell-*（${displaced.join(', ')}），现在加载随壳版本`)
  if (registration.added.length > 0) {
    log(`随壳插件：已把 ${String(registration.added.length)} 个插件登记进 profile 的 bundle 列表（${registration.added.join(', ')}）`)
  }
  if (manifest.dependencies > 0 || manifest.bundles > 0) {
    log(`随壳插件：已从 profile 移除 dsh-plugin-kit（依赖 ${String(manifest.dependencies)}、bundle ${String(manifest.bundles)}）`)
  }
  if (removedRows > 0) log(`随壳插件：已移除 ${String(removedRows)} 条旧插件行（ONE-WAY / MCP-Skills 由壳接管）`)
  if (linked.length === 0 && displaced.length === 0 && registration.added.length === 0
    && manifest.dependencies === 0 && manifest.bundles === 0 && removedRows === 0) {
    // A start that changed nothing must still say so: silence here used to mean a swallowed failure.
    log(`随壳插件：${String(shipped.size)} 个已就绪（无变更）`)
  }
  return { ok: true, linked, unchanged, removedBundles: manifest.bundles, removedRows, addedBundles: registration.added }
}
