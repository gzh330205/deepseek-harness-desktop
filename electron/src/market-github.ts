/**
 * GitHub-sourced plugins: the ones that are in neither the catalog's npm mapping nor the registry.
 *
 * Two facts make this work, both measured rather than assumed:
 *
 *  - the community catalog already carries the spec the upstream market installs with, as
 *    `dsh.bundle.patch`-style strings: `github:owner/repo`, or a release tarball URL
 *    (`…/releases/download/v0.2.3/name-0.2.3.tgz`, `…/releases/latest/download/name.tgz`);
 *  - `https://raw.githubusercontent.com/<owner>/<repo>/HEAD/package.json` answers 200 for public
 *    repos and contains both `name` and `dsh`, so a plugin can be **admitted before anything is
 *    installed** — the same rule the npm path applies, checked a different way.
 *
 * What this deliberately does not do: pretend a repository is safe. If its manifest declares install
 * scripts, they run on this machine when pnpm installs it, so the scripts are reported and the window
 * is expected to say so before the user clicks.
 */

import { rejectReason } from './market-catalog.ts'

/** A GitHub source, however the user spelled it. */
export interface GithubSource {
  readonly owner: string
  readonly repo: string
  /** Branch, tag or commit, when the input named one. */
  readonly ref?: string
  /** Set when the input was a release tarball: pnpm installs the URL instead of the repository. */
  readonly tarball?: string
}

/** What a repository's own `package.json` says, once read. */
export interface GithubPlugin {
  readonly source: GithubSource
  /** The package name the repo declares — the name the profile registers. */
  readonly name: string
  readonly version?: string
  /** Install-lifecycle scripts the repo would run on this machine. */
  readonly scripts: readonly string[]
  /** The spec to hand pnpm. */
  readonly spec: string
}

/**
 * The scripts that execute code **at install time**.
 *
 * `prepublishOnly` / `prepack` are deliberately absent: they run when publishing or packing, not when
 * someone installs the package, and listing them would warn users about code that never executes — a
 * false alarm in the one place where a warning has to be believable.
 */
const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'] as const

const REPO_PART = /^[A-Za-z0-9._-]+$/u

/** `owner/repo` for a well-formed pair, `undefined` otherwise. */
function splitRepo(text: string): { readonly owner: string; readonly repo: string } | undefined {
  const parts = text.split('/')
  const owner = parts[0]
  const repo = parts[1]
  if (owner === undefined || repo === undefined || parts.length !== 2) return undefined
  if (!REPO_PART.test(owner) || !REPO_PART.test(repo)) return undefined
  return { owner, repo: repo.replace(/\.git$/u, '') }
}

/** Strip the shell furniture the catalog's `install` strings come wrapped in. */
function unwrap(input: string): string {
  let text = input.trim()
  const marker = ' add '
  const at = text.indexOf(marker)
  if (at >= 0) text = text.slice(at + marker.length).trim()
  text = text.replace(/^["']|["']$/gu, '').trim()
  if (text.startsWith('git+')) text = text.slice(4)
  return text
}

/**
 * Read any of the shapes a user (or the catalog) may hand us.
 *
 * Accepted: `owner/repo`, `github:owner/repo`, `owner/repo#ref`, `https://github.com/owner/repo`,
 * `…/tree/<ref>`, `…/releases/download/<tag>/<file>.tgz`, `…/releases/latest/download/<file>.tgz`,
 * and any of those with the catalog's `dsh plugin --profile … add ` prefix and quotes still attached.
 *
 * @param input - Whatever was typed, pasted, or read out of the catalog.
 * @returns The source, or `undefined` when this is not a GitHub reference at all.
 */
export function parseGithubInput(input: string): GithubSource | undefined {
  const text = unwrap(input)
  if (text === '') return undefined

  // A release tarball: keep the URL as the spec, but still learn owner/repo so we can verify first.
  const tarball = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/(?:download\/[^/]+|latest\/download)\/[^/]+\.tgz$/u.exec(text)
  if (tarball !== null) {
    const pair = splitRepo(`${tarball[1] as string}/${tarball[2] as string}`)
    if (pair === undefined) return undefined
    return { ...pair, tarball: text }
  }

  const scp = /^(?:github:|https?:\/\/github\.com\/)([^/\s]+)\/([^/\s#]+)(?:\.git)?(?:[/#](.+))?$/u.exec(text)
  if (scp !== null) {
    const pair = splitRepo(`${scp[1] as string}/${scp[2] as string}`)
    if (pair === undefined) return undefined
    const tail = scp[3]
    // `/tree/<ref>` and `#<ref>` both name a ref; a trailing path segment is not one we can use.
    const ref = tail === undefined ? undefined : tail.replace(/^tree\//u, '').split('/')[0]
    return { ...pair, ...(ref === undefined || ref === '' ? {} : { ref }) }
  }

  const bare = /^([^/\s]+)\/([^/\s#]+)(?:#(.+))?$/u.exec(text)
  if (bare !== null) {
    const pair = splitRepo(`${bare[1] as string}/${bare[2] as string}`)
    if (pair === undefined) return undefined
    return { ...pair, ...(bare[3] === undefined || bare[3] === '' ? {} : { ref: bare[3] }) }
  }
  return undefined
}

/** The URL of a file in a repository, `HEAD` when no ref was named. */
export function githubRawUrl(source: GithubSource, file = 'package.json'): string {
  const ref = source.ref ?? 'HEAD'
  return `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${ref}/${file}`
}

/** The spec pnpm should be handed for this source. */
export function githubSpec(source: GithubSource): string {
  if (source.tarball !== undefined) return source.tarball
  return `github:${source.owner}/${source.repo}${source.ref === undefined ? '' : `#${source.ref}`}`
}

/** The install-lifecycle scripts a manifest declares. */
export function lifecycleScripts(manifest: unknown): readonly string[] {
  if (manifest === null || typeof manifest !== 'object') return []
  const scripts = (manifest as { scripts?: unknown }).scripts
  if (scripts === null || typeof scripts !== 'object') return []
  const record = scripts as Record<string, unknown>
  return LIFECYCLE_SCRIPTS.filter(name => typeof record[name] === 'string' && (record[name] as string).trim() !== '')
}

/** Why a GitHub source cannot be installed, with a category the caller can hand to pnpm's classifier. */
export interface GithubRejection {
  readonly reason: string
  /** `not-a-plugin` when the repository read fine but is not a DSH plugin; `github` for everything else. */
  readonly kind: 'not-a-plugin' | 'github'
}

/**
 * Turn a repository's `package.json` into an installable plugin, or explain why it is not one.
 *
 * The admission rule is the same one the npm path uses (`rejectReason`), applied to the repository's
 * own manifest instead of a packument's version manifest — the `dsh` field sits at the top level in
 * both, so the check is literally the same code.
 *
 * @param source - Where the manifest came from.
 * @param manifest - Parsed `package.json`.
 * @returns The plugin, or a reason it cannot be installed.
 */
export function readGithubPlugin(source: GithubSource, manifest: unknown): { readonly plugin: GithubPlugin } | GithubRejection {
  if (manifest === null || typeof manifest !== 'object') return { reason: '仓库里的 package.json 不可读', kind: 'github' }
  const record = manifest as Record<string, unknown>
  const name = typeof record.name === 'string' && record.name.trim() !== '' ? record.name.trim() : undefined
  if (name === undefined) return { reason: '仓库的 package.json 没有 name 字段，无法登记为插件', kind: 'not-a-plugin' }
  const reason = rejectReason(name, record)
  if (reason !== undefined) return { reason, kind: 'not-a-plugin' }
  const version = typeof record.version === 'string' && record.version.trim() !== '' ? record.version.trim() : undefined
  return {
    plugin: {
      source,
      name,
      ...(version === undefined ? {} : { version }),
      scripts: lifecycleScripts(record),
      spec: githubSpec(source),
    },
  }
}

/**
 * Read and vet a repository's manifest over the network.
 *
 * Public repositories need no credentials; a private one answers 404 and is reported as such rather
 * than as "not a plugin", because the two need different fixes.
 *
 * @param getJson - Transport (the shell's `fetchJson`, so timeouts and the non-2xx rule apply).
 * @param input - Whatever the user typed or the catalog carried.
 */
export async function inspectGithubPlugin(
  getJson: (url: string) => Promise<unknown>,
  input: string,
): Promise<{ readonly plugin: GithubPlugin } | GithubRejection> {
  const source = parseGithubInput(input)
  if (source === undefined) return { reason: '这不是一个 GitHub 仓库地址（示例：owner/repo 或 https://github.com/owner/repo）', kind: 'github' }
  let manifest: unknown
  try {
    manifest = await getJson(githubRawUrl(source))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      reason: /404|not found/iu.test(message)
        ? `读不到 ${source.owner}/${source.repo} 的 package.json（仓库不存在、是私有的，或 ${source.ref ?? 'HEAD'} 上没有这个文件）`
        : `读取 GitHub 失败：${message}`,
      kind: 'github',
    }
  }
  return readGithubPlugin(source, manifest)
}
