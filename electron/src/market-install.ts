/**
 * Install, update and remove market plugins — through the path the shell has already proved.
 *
 * Why this module exists at all: the upstream market installs plugins by having **dsh** spawn a
 * Node-mode child, and on this platform that spawn reaches the GUI binary with a `cwd` that does not
 * exist, so it dies with `ENOENT` (`spawn …\DSH Desktop.exe ENOENT`). The shell, meanwhile, owns a
 * path that works and that we can reason about completely:
 *
 *     <runtime>/bin/node.exe  <runtime>/node_modules/pnpm/bin/pnpm.cjs  <args…>
 *
 * with `cwd` = the profile, `shell: false` (no `cmd.exe`, so no console window and no quoting
 * hazards) and `windowsHide: true`. pnpm writes the profile's `package.json` itself; we only add the
 * second half DSH needs — registering the plugin as a **bundle** (`dsh.profile.bundles`), which is
 * what turns an installed dependency into a patch layer the harness actually loads.
 *
 * Failures are classified, never summarised away: the raw output always travels with the result, so a
 * user can paste it and we can act on it instead of guessing from one word.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** What the market window can ask for. */
export type MarketAction = 'install' | 'update' | 'uninstall'

/** The profile fields we read and write. `dsh.profile.bundles` is DSH's own patch-layer list. */
export interface ProfileManifest {
  readonly dependencies?: Record<string, string>
  readonly dsh?: { readonly profile?: { readonly bundles?: unknown } }
  [key: string]: unknown
}

/** Why pnpm said no, in a form the UI can explain. */
export interface MarketFailure {
  /** Coarse category; `unknown` still carries the raw output. */
  readonly kind: 'network' | 'registry' | 'build-permission' | 'store-mismatch' | 'not-found' | 'workspace' | 'unknown'
  /** One line for the list row. */
  readonly message: string
  /** What the user can do about it, when we know. */
  readonly hint?: string
}

/** Outcome of one action. */
export interface MarketActionResult {
  readonly ok: boolean
  readonly action: MarketAction
  /** The package name the action targeted. */
  readonly name: string
  /** The spec handed to pnpm (`name@version` for install/update, `name` for uninstall). */
  readonly spec: string
  /** pnpm's exit code, `null` when the process never started. */
  readonly code: number | null
  /** Raw combined output, always present — the diagnostics pane shows exactly this. */
  readonly output: string
  /** Present only when `ok` is false. */
  readonly failure?: MarketFailure
  /** True when `dsh.profile.bundles` had to be changed to make the change effective. */
  readonly bundleRegistered: boolean
}

/**
 * The pnpm arguments for one action.
 *
 * Every install/update pins the exact version: pnpm's fresh-release hold would otherwise resolve an
 * older version silently, which is how a user ends up running a build they did not pick.
 *
 * @param action - What to do.
 * @param name - Package name.
 * @param version - Exact version for install/update.
 */
export function pnpmArgs(action: MarketAction, name: string, version?: string): string[] {
  if (action === 'uninstall') return ['remove', name]
  if (version === undefined || version === '') return ['add', name]
  return ['add', `${name}@${version}`]
}

/**
 * Register or unregister a plugin in `dsh.profile.bundles`.
 *
 * Installed-but-unregistered is the confusing half-state: `pnpm add` succeeds, the dependency is in
 * `package.json`, and the harness still does not load the plugin because a profile loads **bundles**.
 * Removing is the mirror image.
 *
 * @param manifest - The profile's parsed `package.json`.
 * @param name - Package name to register or drop.
 * @param action - `uninstall` drops it, anything else adds it.
 * @returns The manifest to write and whether it changed.
 */
export function withBundleRegistration(
  manifest: ProfileManifest,
  name: string,
  action: MarketAction,
): { readonly manifest: ProfileManifest; readonly changed: boolean } {
  const current = manifest.dsh?.profile?.bundles
  const bundles = Array.isArray(current) ? current.filter((entry): entry is string => typeof entry === 'string') : []
  const present = bundles.includes(name)
  const wanted = action !== 'uninstall'
  if (present === wanted) return { manifest, changed: false }
  const next = wanted ? [...bundles, name] : bundles.filter(entry => entry !== name)
  return {
    manifest: { ...manifest, dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: next } } },
    changed: true,
  }
}

/** Marker lines pnpm prints for the failures we can name confidently. */
const FAILURE_RULES: readonly {
  readonly test: RegExp
  readonly kind: MarketFailure['kind']
  readonly message: string
  readonly hint?: string
}[] = [
  {
    test: /ERR_PNPM_UNEXPECTED_STORE/u,
    kind: 'store-mismatch',
    message: '这个 profile 的 node_modules 链接到的 pnpm store 与当前 pnpm 解析出的不是同一个',
    hint: '重启应用：壳会在启动时把 profile 重新链接到当前 store',
  },
  {
    test: /ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED/u,
    kind: 'build-permission',
    message: 'git 依赖的 prepare 构建被 pnpm 的构建许可拦住',
    hint: '改用 registry 上发布的版本，或在 profile 的 pnpm 配置里允许该依赖构建',
  },
  {
    test: /ERR_PNPM_NO_MATCHING_VERSION|ERR_PNPM_PEER_DEP_ISSUES|ETARGET/u,
    kind: 'registry',
    message: 'registry 上没有匹配的版本（或该版本不满足依赖约束）',
    hint: '换成列表里给出的最新版本再试',
  },
  { test: /E404|ERR_PNPM_FETCH_404|not found in the registry/u, kind: 'not-found', message: 'registry 上没有这个包' },
  {
    test: /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ERR_PNPM_META_FETCH_FAIL|ERR_PNPM_FETCH_5\d\d|EAI_AGAIN/u,
    kind: 'network',
    message: '连不上 registry（网络或代理问题）',
    hint: '检查代理设置；壳的「设置」里可以配置代理',
  },
  {
    test: /ERR_PNPM_WORKSPACE_PKG_NOT_FOUND|ERR_PNPM_ADDING_TO_ROOT|only workspace|pnpm-workspace/u,
    kind: 'workspace',
    message: '上层目录里有 pnpm workspace，接管了这次安装',
    hint: 'profile 目录不应位于某个 pnpm workspace 之下',
  },
]

/**
 * Turn pnpm's output into a category the UI can act on.
 *
 * Returns `undefined` when pnpm succeeded — callers must not classify success.
 *
 * @param output - Combined stdout/stderr.
 * @param code - pnpm's exit code.
 */
export function classifyPnpmFailure(output: string, code: number | null): MarketFailure | undefined {
  if (code === 0) return undefined
  const text = output
  for (const rule of FAILURE_RULES) {
    if (rule.test.test(text)) return { kind: rule.kind, message: rule.message, ...(rule.hint === undefined ? {} : { hint: rule.hint }) }
  }
  const firstError = text
    .split(/\r?\n/u)
    .map(line => line.trim())
    .find(line => line.startsWith('ERR_') || line.includes(' ERROR ') || line.includes('ERR_PNPM'))
  return {
    kind: 'unknown',
    message: code === null ? 'pnpm 没能启动' : `pnpm 以退出码 ${String(code)} 失败`,
    ...(firstError === undefined ? {} : { hint: firstError.slice(0, 240) }),
  }
}

/** How the module reaches the outside world; injectable so tests need neither pnpm nor a profile. */
export interface MarketInstallOptions {
  /** Directory whose `package.json`/`node_modules` the actions apply to. */
  readonly profileDir: string
  /** Node executable: the bundled real node (`bin/node.exe`) or, as a fallback, the app binary. */
  readonly nodeExecutable: string
  /** pnpm's JavaScript entry (`node_modules/pnpm/bin/pnpm.cjs`). */
  readonly pnpmEntry: string
  /** True when `nodeExecutable` is the GUI app binary, which needs `ELECTRON_RUN_AS_NODE=1`. */
  readonly appBinary?: boolean
  /** Timeout for one action, milliseconds. */
  readonly timeoutMs?: number
  /** Reads the profile manifest. */
  readonly readManifest: () => ProfileManifest
  /** Writes the profile manifest back. */
  readonly writeManifest: (manifest: ProfileManifest, previous: ProfileManifest) => void
  /** Runs pnpm and resolves with its exit code and combined output. */
  readonly runPnpm: (args: readonly string[], environment: NodeJS.ProcessEnv) => Promise<{ code: number | null; output: string }>
}

/** Build the child environment: the app binary needs Node mode, a real node ignores it. */
export function marketChildEnvironment(base: NodeJS.ProcessEnv = process.env, appBinary = false): NodeJS.ProcessEnv {
  return appBinary ? { ...base, ELECTRON_RUN_AS_NODE: '1' } : { ...base }
}

/**
 * Run one market action.
 *
 * Order matters: pnpm first (it owns `dependencies`), then the bundle registration (we own
 * `dsh.profile.bundles`). If pnpm fails, the manifest is left untouched — a half-registered bundle
 * whose dependency is missing would make the harness fail to boot, which is far worse than a plugin
 * that simply did not get added.
 *
 * @param action - install / update / uninstall.
 * @param name - Package name.
 * @param options - Profile paths, manifest access and the pnpm runner.
 * @param version - Exact version for install/update.
 */
export async function runMarketAction(
  action: MarketAction,
  name: string,
  options: MarketInstallOptions,
  version?: string,
): Promise<MarketActionResult> {
  const args = pnpmArgs(action, name, version)
  const spec = args[1] ?? name
  const environment = marketChildEnvironment(process.env, options.appBinary === true)
  let code: number | null = null
  let output = ''
  try {
    const result = await options.runPnpm(args, environment)
    code = result.code
    output = result.output
  } catch (error) {
    output = error instanceof Error ? error.message : String(error)
  }

  const failure = classifyPnpmFailure(output, code)
  if (failure !== undefined) return { ok: false, action, name, spec, code, output, failure, bundleRegistered: false }

  const previous = options.readManifest()
  const { manifest, changed } = withBundleRegistration(previous, name, action)
  if (changed) options.writeManifest(manifest, previous)
  return { ok: true, action, name, spec, code, output, bundleRegistered: changed }
}

/**
 * Resolve the executables an action needs from the bundled runtime.
 *
 * Packaged, `runtimeRoot` is the **ASAR** (`resources/app.asar/dsh`). Electron's patched `fs` reads
 * such paths, so an `existsSync` check happily says yes — but `spawn` is a real OS call and cannot open
 * a file inside an archive. That mismatch is the whole failure:
 * `spawn …\app.asar\dsh\bin\node.exe ENOENT` while the same path "exists". Anything we *start* must
 * come from the archive's physical twin, `app.asar.unpacked`, which is exactly where electron-builder
 * puts the files that cannot be read from an archive (executables, native modules, pnpm's JS).
 *
 * @param runtimeRoot - Prepared runtime directory (`resources/.../dsh`), possibly inside an ASAR.
 * @param appExecutable - The application binary, used only when no real node is bundled.
 * @returns Paths, or `undefined` when the runtime does not look usable.
 */
export function resolveMarketRuntime(
  runtimeRoot: string,
  appExecutable: string,
): { readonly nodeExecutable: string; readonly pnpmEntry: string; readonly appBinary: boolean } | undefined {
  const pnpmEntry = firstExisting(physicalCandidates(join(runtimeRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')))
  if (pnpmEntry === undefined) return undefined
  const bundledNode = firstExisting(physicalCandidates(join(runtimeRoot, 'bin', 'node.exe')))
  if (bundledNode !== undefined) return { nodeExecutable: bundledNode, pnpmEntry, appBinary: false }
  return { nodeExecutable: appExecutable, pnpmEntry, appBinary: true }
}

/**
 * A path inside an ASAR and its physical twin, physical first.
 *
 * A path that is already physical (development trees, or nothing to do with an archive) is returned
 * unchanged, so callers can pass any path through this without thinking about it.
 *
 * @param candidate - A path that may live inside `app.asar`.
 */
export function physicalCandidates(candidate: string): readonly string[] {
  if (!candidate.includes('app.asar') || candidate.includes('app.asar.unpacked')) return [candidate]
  return [candidate.replace('app.asar', 'app.asar.unpacked'), candidate]
}

/** The first of these paths that exists, if any. */
function firstExisting(candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}
