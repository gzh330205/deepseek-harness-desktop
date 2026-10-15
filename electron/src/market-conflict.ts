/**
 * Conflict diagnosis: what a profile's plugin state can be proven to get wrong.
 *
 * Written as a pure function over a small "world" object plus one reader that fills it from disk, for
 * one reason: the interesting cases are the *contradictions* between facts that live in different
 * files — a dependency without an install, an install the profile never loads, a bundle listed twice,
 * a store the pnpm of the day refuses. Every finding must be provable from those files; anything that
 * would need a guess (which plugin "owns" a tool name, say) is deliberately not reported, because a
 * diagnosis that cries wolf is worse than no diagnosis.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { ProfileManifest } from './market-install.ts'

/** One plugin as the profile knows it. */
export interface InstalledFact {
  readonly name: string
  /** The spec `dependencies` declares. */
  readonly spec: string
  /** The version of the installed copy, when it can be read. */
  readonly version?: string
  /** True when `node_modules/<name>` exists. */
  readonly present: boolean
  /** Whether the installed copy declares `dsh` (i.e. is really a plugin). */
  readonly declaresDsh?: boolean
  /**
   * Top-level keys of the plugin's own patch file (`dsh.bundle.patch`), i.e. the services it declares
   * it patches. This is the only capability claim that can be read without executing the plugin, and
   * therefore the only one worth diagnosing.
   */
  readonly patches?: readonly string[]
}

/** Where the pnpm store disagreement stands, if it could be read. */
export interface StoreFacts {
  /** Major version of the store the profile's `node_modules` is linked to. */
  readonly modulesMajor?: string
  /** Major version of the store the pnpm that would run now uses. */
  readonly pnpmMajor?: string
}

/** Everything the diagnosis looks at. */
export interface ConflictWorld {
  readonly dependencies: Readonly<Record<string, string>>
  /** `dsh.profile.bundles` — the list the harness actually loads. */
  readonly bundles: readonly string[]
  /** Facts for every name mentioned by either list. */
  readonly installed: readonly InstalledFact[]
  /** Paths (profile and ancestors) that hold a `pnpm-workspace.yaml`. */
  readonly workspaceMarkers: readonly string[]
  readonly store?: StoreFacts
  /** The runtime's DSH version, for context in messages. */
  readonly dshVersion?: string
}

/** One thing that is wrong, with the evidence that says so. */
export interface ConflictFinding {
  readonly severity: 'error' | 'warn' | 'info'
  readonly code:
    | 'missing-install'
    | 'not-registered'
    | 'duplicate-bundle'
    | 'orphan-install'
    | 'not-a-plugin'
    | 'platform-package'
    | 'workspace-takeover'
    | 'store-mismatch'
    | 'version-drift'
    | 'capability-overlap'
  /** What the finding is about (plugin name, or a path for environment findings). */
  readonly subject: string
  /** One line, phrased for the user. */
  readonly message: string
  /** What to do about it, when there is an obvious answer. */
  readonly hint?: string
}

/** The harness's own packages: never a plugin a user should install from a market. */
function isPlatformPackage(name: string): boolean {
  return /^@deepseek-ai\/dsh($|-)/u.test(name)
}

/** Split `^1.2.3` into `1.2.3` without a character-class regex (see `stripRangePrefix`). */
function bareVersion(spec: string): string {
  const decoration = '^~><=vV '
  let index = 0
  while (index < spec.length && decoration.includes(spec.slice(index, index + 1))) index += 1
  return spec.slice(index)
}

/**
 * Diagnose a profile's plugin state.
 *
 * @param world - The facts, as read from disk.
 * @returns Findings, most severe first. An empty list means nothing could be proven wrong.
 */
export function diagnoseConflicts(world: ConflictWorld): readonly ConflictFinding[] {
  const findings: ConflictFinding[] = []
  const facts = new Map(world.installed.map(fact => [fact.name, fact]))
  const declared = new Set(Object.keys(world.dependencies))

  // A bundle listed twice loads twice; on a patch layer that means the same hook installed twice.
  const seenBundles = new Set<string>()
  for (const bundle of world.bundles) {
    if (seenBundles.has(bundle)) {
      findings.push({
        severity: 'warn',
        code: 'duplicate-bundle',
        subject: bundle,
        message: `插件列表（dsh.profile.bundles）里 ${bundle} 出现了多次`,
        hint: '删掉重复项，只保留一次',
      })
    }
    seenBundles.add(bundle)
  }

  for (const [name, spec] of Object.entries(world.dependencies)) {
    const fact = facts.get(name)
    if (isPlatformPackage(name)) {
      findings.push({
        severity: 'warn',
        code: 'platform-package',
        subject: name,
        message: `${name} 是 DSH 自身的一部分，却作为插件依赖装在这个 profile 里`,
        hint: '它随运行时一起发布；从 profile 依赖里移除，避免和运行时打架',
      })
    }
    if (fact === undefined || !fact.present) {
      findings.push({
        severity: 'error',
        code: 'missing-install',
        subject: name,
        message: `声明了依赖 ${name}（${spec}），但 node_modules 里没有它`,
        hint: '在市场里重新安装这个插件，或对该 profile 跑一次 pnpm install',
      })
      continue
    }
    if (fact.declaresDsh === false) {
      findings.push({
        severity: 'error',
        code: 'not-a-plugin',
        subject: name,
        message: `${name} 装上了，但它的 package.json 没有声明 dsh 字段，harness 不会把它当插件加载`,
        hint: '确认装的是不是 DSH 插件；普通 npm 包不会生效',
      })
    }
    // Installed and declared, but the profile never loads it: the half-state that looks like
    // "the plugin installed but nothing happened".
    if (!world.bundles.includes(name)) {
      findings.push({
        severity: 'warn',
        code: 'not-registered',
        subject: name,
        message: `${name} 已安装，但没有登记进 dsh.profile.bundles，这个 profile 不会加载它`,
        hint: '在市场里重装一次（安装会自动登记），或手工把名字加进该列表',
      })
    }
    const wanted = bareVersion(spec)
    if (fact.version !== undefined && wanted !== '' && !spec.includes(':') && fact.version !== wanted) {
      findings.push({
        severity: 'info',
        code: 'version-drift',
        subject: name,
        message: `${name} 声明的是 ${spec}，实际装的是 ${fact.version}`,
        hint: '若不确定，用市场里的「检查更新」重装到想要的版本',
      })
    }
  }

  // Installed but nobody declares it: leftovers from an interrupted install or a manual pnpm add.
  for (const fact of world.installed) {
    if (declared.has(fact.name)) continue
    findings.push({
      severity: 'warn',
      code: 'orphan-install',
      subject: fact.name,
      message: `${fact.name} 在 node_modules 里，但 package.json 没有声明它`,
      hint: '要么把它登记（市场里重装一次），要么卸载清掉这份残留',
    })
  }

  // The environment classes that make every install fail, with the fix we already know.
  for (const marker of world.workspaceMarkers) {
    findings.push({
      severity: 'error',
      code: 'workspace-takeover',
      subject: marker,
      message: `${marker} 是 pnpm workspace，它会连 profile 的安装一起接管（用的是它自己的 store）`,
      hint: 'profile 不应位于 pnpm workspace 之下：把它移出该目录树',
    })
  }
  const store = world.store
  if (store?.modulesMajor !== undefined && store.pnpmMajor !== undefined && store.modulesMajor !== store.pnpmMajor) {
    findings.push({
      severity: 'error',
      code: 'store-mismatch',
      subject: 'pnpm store',
      message: `profile 的 node_modules 链接的是 store/v${store.modulesMajor}，而当前 pnpm 用 store/v${store.pnpmMajor}`,
      hint: '重启应用：壳会在启动时把 profile 重新链接到当前 store',
    })
  }

  // Capability overlap, provable form: two plugins whose own patch files touch the same top-level key
  // are both claiming the same hook. Reported as a warning because DSH allows several patches on one
  // service — the point is that the user should know two plugins meet there.
  const patchedBy = new Map<string, string[]>()
  for (const fact of world.installed) {
    for (const key of fact.patches ?? []) {
      const owners = patchedBy.get(key) ?? []
      owners.push(fact.name)
      patchedBy.set(key, owners)
    }
  }
  for (const [key, owners] of patchedBy) {
    if (owners.length < 2) continue
    findings.push({
      severity: 'warn',
      code: 'capability-overlap',
      subject: key,
      message: `${owners.length} 个插件都声明要改同一个挂点 ${key}：${owners.join('、')}`,
      hint: '如果不是有意叠加，检查这些插件的补丁是否互相覆盖',
    })
  }
  const rank = { error: 0, warn: 1, info: 2 } as const
  return findings.sort((left, right) => rank[left.severity] - rank[right.severity])
}

/** Read one installed plugin's manifest facts. */
function readInstalledFact(profileDir: string, name: string, spec: string): InstalledFact {
  const packageDir = join(profileDir, 'node_modules', ...name.split('/'))
  const manifestPath = join(packageDir, 'package.json')
  if (!existsSync(manifestPath)) return { name, spec, present: false }
  try {
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const record = manifest !== null && typeof manifest === 'object' ? manifest as Record<string, unknown> : {}
    const version = typeof record.version === 'string' ? record.version : undefined
    const dsh = record.dsh
    const patch = dsh !== null && typeof dsh === 'object'
      ? (dsh as { bundle?: { patch?: unknown } }).bundle?.patch
      : undefined
    const patches = typeof patch === 'string' && patch !== '' ? readPatchKeys(join(packageDir, patch)) : []
    return {
      name,
      spec,
      ...(version === undefined ? {} : { version }),
      present: true,
      declaresDsh: dsh !== null && typeof dsh === 'object',
      ...(patches.length === 0 ? {} : { patches }),
    }
  } catch {
    // A package.json we cannot parse is itself worth reporting as "not a plugin we can trust".
    return { name, spec, present: true, declaresDsh: false }
  }
}

/**
 * Fill a {@link ConflictWorld} from a profile directory.
 *
 * Read-only on purpose: a diagnosis may not change what it observes, or the second run would report a
 * different profile than the first.
 *
 * @param profileDir - The profile the shell owns.
 * @param options - Extra context the shell knows (store versions, DSH version).
 */
export function readConflictWorld(
  profileDir: string,
  options: { readonly store?: StoreFacts; readonly dshVersion?: string } = {},
): ConflictWorld {
  let manifest: ProfileManifest = {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    if (parsed !== null && typeof parsed === 'object') manifest = parsed as ProfileManifest
  } catch {
    manifest = {}
  }
  const dependencies = manifest.dependencies ?? {}
  const rawBundles = manifest.dsh?.profile?.bundles
  const bundles = Array.isArray(rawBundles) ? rawBundles.filter((entry): entry is string => typeof entry === 'string') : []

  // Names to inspect: everything declared, everything bundled, and anything sitting in node_modules
  // that looks like a plugin (the orphan case is exactly the one nobody declares).
  const names = new Set<string>([...Object.keys(dependencies), ...bundles])
  try {
    for (const entry of readdirSync(join(profileDir, 'node_modules'), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      if (entry.name.startsWith('@')) {
        for (const scoped of readdirSync(join(profileDir, 'node_modules', entry.name), { withFileTypes: true })) {
          if (scoped.isDirectory()) names.add(`${entry.name}/${scoped.name}`)
        }
        continue
      }
      if (entry.isDirectory() || entry.isSymbolicLink()) names.add(entry.name)
    }
  } catch {
    // No node_modules at all: the declared-but-missing findings already cover that.
  }

  const installed: InstalledFact[] = []
  for (const name of names) {
    const spec = dependencies[name] ?? (bundles.includes(name) ? '(登记为 bundle)' : '')
    const fact = readInstalledFact(profileDir, name, spec)
    // Only plugins and plugin-shaped leftovers are interesting; a transitive dependency of a plugin
    // (react, katex …) is not installed "as a plugin" and must not be reported as an orphan.
    if (fact.declaresDsh === true || dependencies[name] !== undefined || bundles.includes(name)) installed.push(fact)
  }

  const workspaceMarkers: string[] = []
  let directory = profileDir
  for (let depth = 0; depth < 4; depth += 1) {
    if (existsSync(join(directory, 'pnpm-workspace.yaml'))) workspaceMarkers.push(join(directory, 'pnpm-workspace.yaml'))
    const parent = join(directory, '..')
    if (parent === directory) break
    directory = parent
  }

  return {
    dependencies,
    bundles,
    installed,
    workspaceMarkers,
    ...(options.store === undefined ? {} : { store: options.store }),
    ...(options.dshVersion === undefined ? {} : { dshVersion: options.dshVersion }),
  }
}

/** True when a directory holds a `pnpm-workspace.yaml` (used to explain a workspace takeover). */
export function hasWorkspaceMarker(directory: string): boolean {
  try {
    return statSync(join(directory, 'pnpm-workspace.yaml')).isFile()
  } catch {
    return false
  }
}

/**
 * Top-level keys of a patch file, without a YAML parser.
 *
 * A DSH patch (`cordis.patch.yml`) names the service or path it patches as an indentation-0 key; the
 * body underneath is indentation-carrying content. That is enough to answer "which hooks does this
 * plugin declare", and it keeps the diagnosis dependency-free — a full YAML parse would fail on the
 * plugins whose patch file uses anchors, and a failed parse is exactly the case where a silent
 * "no conflict" would be worse than not checking.
 *
 * @param patchPath - Absolute path of the patch file named by `dsh.bundle.patch`.
 * @returns The keys, deduplicated, or an empty list when the file cannot be read.
 */
export function readPatchKeys(patchPath: string): readonly string[] {
  let text = ''
  try {
    text = readFileSync(patchPath, 'utf8')
  } catch {
    return []
  }
  const keys: string[] = []
  for (const line of text.split(/\r?\n/u)) {
    if (line === '' || line.startsWith('#') || line.startsWith(' ') || line.startsWith('\t')) continue
    const match = /^([^\s:#][^:]*):/u.exec(line)
    const key = match?.[1]?.trim()
    if (key !== undefined && key !== '' && !keys.includes(key)) keys.push(key)
  }
  return keys
}
