/**
 * The profile the desktop shell owns.
 *
 * The shell boots `dsh --profile dsh-desktop`, not `dsh web`, so its plugin set, lockfile
 * and node_modules live in `$DSH_HOME/profiles/dsh-desktop` and cannot be mutated by the
 * user's command-line dsh — the isolation the official shell also implements.
 *
 * The name cannot be `desktop`: dsh reserves that one for the official Electron app
 * (`rejectElectronProfile` in its launcher errors with "profile \"desktop\" is managed
 * exclusively by the Electron application", for both booting and `dsh plugin`).
 *
 * `dsh` also refuses to boot a profile that does not exist yet
 * (`profile "x" does not exist; create it with 'dsh plugin --profile x add <package>'`),
 * and a migrated user's plugins are declared in the shipped `web` profile. So the first
 * run seeds our profile from that template: same bundle list and same dependency set,
 * then installs them with the bundled pnpm. Nothing existing is ever overwritten.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { DESKTOP_PROFILE_NAME } from './constants.ts'

export { DESKTOP_PROFILE_NAME }
/** The profile the shipped `dsh web` command uses, and therefore the migration source. */
const WEB_PROFILE_NAME = 'web'
/** Bundles every web-serving profile needs when there is no template to copy. */
const FALLBACK_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

export interface ProfileSeed {
  readonly path: string
  readonly created: boolean
  readonly bundles: readonly string[]
  /** Dependencies declared by the template; non-empty means an install is worthwhile. */
  readonly dependencies: Readonly<Record<string, string>>
  /** Where the profile came from, for diagnostics. */
  readonly seededFrom: 'existing' | 'cloned-web' | 'default'
}

export interface ProfileManifest {
  readonly name?: string
  readonly private?: boolean
  readonly dependencies?: Record<string, string>
  readonly dsh?: { readonly profile?: { readonly bundles?: string[]; readonly patchReload?: string } }
}

/**
 * Default harness home, matching dsh's own resolution when `DSH_HOME` is unset.
 * @param environment - Environment to consult for `DSH_HOME`.
 */
export function harnessHomeFrom(environment: NodeJS.ProcessEnv, home = homedir()): string {
  const configured = environment.DSH_HOME
  return configured === undefined || configured === '' ? join(home, '.dsh') : configured
}

export function profilePath(home: string, name = DESKTOP_PROFILE_NAME): string {
  return join(home, 'profiles', name)
}

function readManifest(path: string): ProfileManifest | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ProfileManifest
  } catch {
    return undefined
  }
}

/**
 * Create the shell's profile when it is missing.
 *
 * @param home - Harness home (`DSH_HOME` or `~/.dsh`).
 * @param name - Profile name. Must be the one the host is launched with: seeding
 *   `dsh-desktop` while booting `--profile dsh-desktop-debug` leaves the app without a
 *   profile, which dsh treats as fatal.
 * @returns What the profile looks like after the call.
 */
export function ensureDesktopProfile(home: string, name: string = DESKTOP_PROFILE_NAME): ProfileSeed {
  const path = profilePath(home, name)
  const manifestPath = join(path, 'package.json')
  const existing = existsSync(manifestPath) ? readManifest(manifestPath) : undefined
  if (existing !== undefined) {
    const bundles = existing.dsh?.profile?.bundles ?? []
    return {
      path,
      created: false,
      bundles,
      dependencies: existing.dependencies ?? {},
      seededFrom: 'existing',
    }
  }

  const web = profilePath(home, WEB_PROFILE_NAME)
  const webManifestPath = join(web, 'package.json')
  const webManifest = existsSync(webManifestPath) ? readManifest(webManifestPath) : undefined
  if (webManifest !== undefined) {
    // Clone the user's own profile instead of re-seeding from the template.
    //
    // A template seed copies only the bundle list and dependencies, which loses exactly the
    // things a real user has built up: the `cordis.patch.yml` user layer (where their agent
    // presets and plugin settings live), the packages their patch resolves, the plugin
    // manager state, and the workspace file. A real install hit this — every new session
    // failed with `agent-preset/not-found: Unknown agent preset: git-bash`, because that
    // preset was defined in the user layer that never came across.
    const clone = `${path}.cloning-${String(process.pid)}`
    try {
      rmSync(clone, { recursive: true, force: true })
      // `cpSync` keeps symlinks as symlinks, which is what pnpm's node_modules needs.
      cpSync(web, clone, { recursive: true })
      const manifest: ProfileManifest = {
        ...webManifest,
        name: `dsh-profile-${name}`,
      }
      writeFileSync(join(clone, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      // Rename last: a half-copied profile would look like an existing one next start.
      mkdirSync(dirname(path), { recursive: true })
      renameSync(clone, path)
      return {
        path,
        created: true,
        bundles: manifest.dsh?.profile?.bundles ?? [],
        dependencies: manifest.dependencies ?? {},
        seededFrom: 'cloned-web',
      }
    } catch (error) {
      rmSync(clone, { recursive: true, force: true })
      // Fall through to the minimal seed: a profile that boots beats a faithful copy that
      // does not.
      if (process.env.DSH_DESKTOP_DEBUG === '1') {
        process.stderr.write(`dsh desktop: 克隆 web profile 失败，改用最小播种：${String(error)}\n`)
      }
    }
  }

  const webBundles = webManifest?.dsh?.profile?.bundles ?? []
  const bundles = webBundles.length > 0 ? [...webBundles] : [...FALLBACK_BUNDLES]
  const dependencies = webManifest?.dependencies ?? {}

  const manifest: ProfileManifest = {
    name: `dsh-profile-${name}`,
    private: true,
    dependencies,
    dsh: {
      profile: {
        bundles,
        // Same live-reload behaviour the shipped web profile uses.
        patchReload: webManifest?.dsh?.profile?.patchReload ?? 'live',
      },
    },
  }

  mkdirSync(path, { recursive: true })
  const temporary = `${manifestPath}.tmp-${String(process.pid)}`
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  // Atomic rename: a half-written profile manifest would break every later boot.
  renameSync(temporary, manifestPath)

  return { path, created: true, bundles, dependencies, seededFrom: 'default' }
}

/**
 * Whether the profile still needs its declared plugins installed.
 *
 * Not "did we just create it": an install can fail (no network, a bad package-manager
 * call) and the app must retry next start instead of leaving the user without the plugins
 * the migration promised to carry over.
 *
 * @param seed - Result of {@link ensureDesktopProfile}.
 */
export function profileNeedsInstall(seed: ProfileSeed): boolean {
  if (Object.keys(seed.dependencies).length === 0) return false
  return !existsSync(join(seed.path, 'node_modules'))
}

/**
 * The store major recorded in pnpm's `.modules.yaml`, e.g. `"10"` for `…/store/v10`.
 *
 * The file is YAML in JSON's clothes (`"storeDir": "C:\\…\\store\\v10",`), so the value is unquoted
 * and backslash-unescaped before the version is read off the end.
 *
 * @param text - Contents of `node_modules/.modules.yaml`.
 * @returns The major version, or `undefined` when the file does not record a store.
 */
export function storeMajorFromModulesYaml(text: string): string | undefined {
  const line = /^\s*"?storeDir"?\s*:\s*(.+?)\s*,?\s*$/mu.exec(text)?.[1]
  if (line === undefined) return undefined
  const value = line.replace(/^["']|["']$/gu, '').replace(/\\{2}/gu, '/').replace(/\\/gu, '/')
  return /\/v(\d+)$/u.exec(value)?.[1]
}

/**
 * Whether the profile's `node_modules` was linked from a different pnpm major than ours.
 *
 * pnpm versions its content store by its own major and refuses to touch a `node_modules` linked from
 * another one (`ERR_PNPM_UNEXPECTED_STORE`): every existing profile hits that the first time the
 * bundled pnpm is upgraded across a major (10.34.2 → 11.7.0, which is what the `allowBuilds`
 * alignment needed). The remedy is a plain `pnpm install`, which relinks from the new store without
 * changing the dependency set — the lockfile decides that, not the store.
 *
 * @param directory - Profile directory.
 * @param bundledPnpmVersion - pnpm shipped in the runtime manifest, e.g. `11.7.0`.
 * @param migratedStore - Store this profile was already relinked to (`v11`), when the shell recorded
 *   one. pnpm does not always rewrite `.modules.yaml` (a profile with no dependencies keeps the old
 *   file), so without this the mismatch would be re-detected on every start and the profile purged
 *   and reinstalled each launch.
 * @returns The mismatch to report, or `undefined` when there is nothing to relink.
 */
export function profileStoreMismatch(
  directory: string,
  bundledPnpmVersion: string,
  migratedStore?: string,
): { readonly from: string; readonly to: string } | undefined {
  const bundled = /^(\d+)\./u.exec(bundledPnpmVersion)?.[1]
  if (bundled === undefined) return undefined
  if (migratedStore === `v${bundled}`) return undefined
  let text: string
  try {
    text = readFileSync(join(directory, 'node_modules', '.modules.yaml'), 'utf8')
  } catch {
    // No `node_modules`, or one pnpm did not write: nothing to migrate.
    return undefined
  }
  const linked = storeMajorFromModulesYaml(text)
  if (linked === undefined || linked === bundled) return undefined
  return { from: `v${linked}`, to: `v${bundled}` }
}

/**
 * Install the profile's declared dependencies with the bundled pnpm.
 *
 * Runs the app's own binary in Node mode with pnpm's JavaScript entry point — **never a
 * `.cmd` shim through a shell**. That is not a style preference: the shim path contains
 * the install directory, and a user who installed to `D:\Program Files\…` got
 * `'D:\Program' is not recognized as an internal or external command`, so the migration
 * installed nothing at all. Development paths contain no spaces, which is why it looked
 * healthy until it ran on a real install.
 *
 * A failure is reported, never fatal: the profile still boots without its optional
 * plugins (dsh logs `skipping profile bundle` and continues).
 *
 * @param options.nodeExecutable - The app's own executable (`process.execPath`).
 * @param options.pnpmEntry - `node_modules/pnpm/bin/pnpm.cjs` in the bundled runtime.
 * @param options.additions - Extra `link:` specs to add (a repaired profile's plugins).
 * @param options.run - Command runner, injected so the logic is testable.
 */
export async function installProfileDependencies(options: {
  readonly path: string
  readonly nodeExecutable: string
  readonly pnpmEntry: string
  readonly additions?: readonly string[]
  readonly timeoutMs?: number
  readonly run: (command: string, args: readonly string[], options: {
    readonly cwd: string
    readonly env: NodeJS.ProcessEnv
    readonly timeoutMs: number
    readonly shell: boolean
  }) => Promise<{ readonly code: number | null; readonly output: string }>
}): Promise<{ readonly ok: boolean; readonly detail: string }> {
  try {
    const additions = options.additions ?? []
    // `confirmModulesPurge=false`: a store change (a bundled-pnpm major upgrade) makes pnpm want to
    // delete and relink `node_modules`, and with no TTY it aborts instead of asking —
    // `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`. The prompt exists for interactive shells; here the
    // lockfile decides the dependency set, so the purge is the migration we asked for.
    const args = [
      ...additions.length > 0 ? ['add', ...additions] : ['install'],
      '--config.confirmModulesPurge=false',
    ]
    const result = await options.run(options.nodeExecutable, [options.pnpmEntry, ...args], {
      cwd: options.path,
      // `DSH_DESKTOP_NODE_EXECUTABLE` stays set: it is what the bundled `node` shim uses
      // for lifecycle scripts that expect a `node` on PATH.
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        DSH_DESKTOP_NODE_EXECUTABLE: options.nodeExecutable,
      },
      timeoutMs: options.timeoutMs ?? 10 * 60_000,
      shell: false,
    })
    if (result.code === 0) return { ok: true, detail: 'profile 依赖安装完成' }
    return { ok: false, detail: `pnpm install 退出码 ${String(result.code)}：${result.output.slice(-400)}` }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

/** Files that make up a profile's user layer rather than its installed packages. */
const USER_LAYER_FILES = ['cordis.patch.yml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', '.plugin-manager', '.dsh-market']

export interface ProfileRepair {
  readonly repaired: boolean
  readonly copied: readonly string[]
  /** `link:` specs the source profile has and this one is missing. */
  readonly missingLinks: readonly string[]
}

/**
 * Repair a profile that an earlier version seeded from the template only.
 *
 * Versions up to 0.3.7 copied the bundle list and dependencies but not the user layer, so
 * a migrated profile booted with dsh's generated skeleton patch and none of the packages
 * that patch resolves — every new session failed with `agent-preset/not-found`. Cloning
 * fixes future migrations; this fixes a profile that was already seeded that way, without
 * touching anything a user has since configured by hand.
 *
 * The test is deliberately crude and conservative: the target's patch is a fraction of the
 * source's, which is what a generated skeleton looks like next to a real user layer. Any
 * doubt means "leave it alone".
 *
 * @param home - Harness home.
 * @param name - Profile the shell owns.
 */
export function repairSeededProfile(home: string, name: string = DESKTOP_PROFILE_NAME): ProfileRepair {
  const nothing: ProfileRepair = { repaired: false, copied: [], missingLinks: [] }
  const target = profilePath(home, name)
  const source = profilePath(home, WEB_PROFILE_NAME)
  if (!existsSync(join(target, 'package.json')) || !existsSync(join(source, 'package.json'))) return nothing

  const sourcePatch = join(source, 'cordis.patch.yml')
  if (!existsSync(sourcePatch)) return nothing
  const targetPatch = join(target, 'cordis.patch.yml')
  const sourceSize = statSync(sourcePatch).size
  const targetSize = existsSync(targetPatch) ? statSync(targetPatch).size : 0
  if (sourceSize === 0 || targetSize > sourceSize / 4) return nothing

  const copied: string[] = []
  try {
    // Keep the skeleton: it is dsh's own default, and a user may want to diff against it.
    if (existsSync(targetPatch)) renameSync(targetPatch, `${targetPatch}.bak-seeded-${String(Date.now())}`)
    for (const file of USER_LAYER_FILES) {
      const from = join(source, file)
      if (!existsSync(from)) continue
      const to = join(target, file)
      // Only the patch was demonstrably generated; everything else is left alone if present.
      if (existsSync(to) && file !== 'cordis.patch.yml') continue
      cpSync(from, to, { recursive: true })
      copied.push(file)
    }
  } catch {
    return { repaired: copied.length > 0, copied, missingLinks: [] }
  }

  return { repaired: true, copied, missingLinks: missingLinkedPackages(source, target) }
}

/**
 * `link:` packages the source profile has and the target does not.
 *
 * A user's patch names plugins that were installed into their profile over time; those are
 * not in `package.json` dependencies, so an install alone would not bring them across.
 */
function missingLinkedPackages(source: string, target: string): string[] {
  const sourceModules = join(source, 'node_modules')
  const targetModules = join(target, 'node_modules')
  if (!existsSync(sourceModules)) return []
  const missing: string[] = []
  for (const entry of readdirSync(sourceModules, { withFileTypes: true })) {
    if (entry.name === '.pnpm' || entry.name === '.bin') continue
    const from = join(sourceModules, entry.name)
    let real: string
    try {
      real = readlinkSync(from)
    } catch {
      continue // Not a symlink: a regular directory needs no `link:` spec.
    }
    if (existsSync(join(targetModules, entry.name))) continue
    missing.push(`link:${real}`)
  }
  return missing
}

/**
 * Symlinked packages in a profile's `node_modules`: the local plugins the user installed there.
 *
 * They matter for exactly one operation: relinking the profile after the bundled pnpm changes its
 * store version. pnpm's purge deletes `node_modules` wholesale and then restores only what
 * `package.json` and the lockfile describe — but a plugin installed by hand, or by `dsh plugin` in a
 * way that never reached `package.json`, is only a symlink in that directory. Losing it removes the
 * plugin from a profile whose `cordis.patch.yml` still names it.
 *
 * @param directory - Profile directory.
 * @returns Name and link target of every symlinked package, `.bin`/`.pnpm` excluded.
 */
export function linkedPackages(directory: string): { readonly name: string; readonly target: string }[] {
  const modules = join(directory, 'node_modules')
  if (!existsSync(modules)) return []
  const linked: { name: string; target: string }[] = []
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    if (entry.name === '.pnpm' || entry.name === '.bin') continue
    try {
      linked.push({ name: entry.name, target: readlinkSync(join(modules, entry.name)) })
    } catch {
      // A regular directory: pnpm's install owns it, and the lockfile will bring it back.
    }
  }
  return linked
}

/**
 * Re-create a plugin link pnpm's purge removed.
 *
 * A junction on Windows (`pnpm link:` produces exactly that and needs no elevation) and a directory
 * symlink elsewhere.
 *
 * @param directory - Profile directory.
 * @param entry - Name and target from {@link linkedPackages}.
 */
export function relinkPackage(directory: string, entry: { readonly name: string; readonly target: string }): void {
  symlinkSync(entry.target, join(directory, 'node_modules', entry.name), process.platform === 'win32' ? 'junction' : 'dir')
}
