/**
 * Read and edit the parts of the DSH profile that belong to the user, from the shell.
 *
 * Two features need this and neither should become a DSH plugin: MCP servers and Skills are *DSH
 * configuration*, not UI that runs inside the conversation page. The profile patch
 * (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`) is the real store:
 *
 * - MCP servers are ordinary `@deepseek-ai/dsh-mcp-client` loader rows. The old
 *   `dsh-mcp-skill-manager` plugin kept them inside its own settings record; the migration below
 *   turns those records into native rows so the plugin (and its aggregator) can go away.
 * - Skills are directory bundles / flat Markdown files the filesystem provider discovers under
 *   `$DSH_HOME/skills`; the shell manages that directory (links are junctions, never copies).
 *
 * Edits preserve the rest of the file — comments, ordering, unrelated rows — by mutating the YAML
 * document in place instead of round-tripping through a plain JS object. A user's patch file is
 * hand-written data; losing its comments once is enough to make people stop trusting the feature.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'

import { isMap, isSeq, parseDocument, parse as parseYaml, type Document, type YAMLMap, type YAMLSeq } from 'yaml'

import { DESKTOP_PROFILE_NAME, PROFILE_ENV } from './constants.ts'

/**
 * Row name of the native MCP client; the install-time overlay uses the same name.
 *
 * New rows MUST be written inside a top-level `- insert: [...]` container. In the DSH loader's
 * patch semantics (`applyEntryPatches`), a top-level patch with a `name` but no `insert` is only an
 * assertion on an existing row: it never adds one, it warns `patch: entry "…" not found` and is
 * skipped. The old shell wrote new MCP rows as top-level entries, so none of them ever mounted.
 * The container also has to come first in the file: patches apply in order, and only rows inserted
 * before a top-level override can be found (and overridden) by it.
 */
const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'
/** Id of the legacy plugin's row; its config carries the servers from before the migration. */
const LEGACY_MCP_SKILL_ROW = 'mcp-skill-manager'
const LEGACY_ONEWAY_ROW = 'oneway-usage-monitor'

export type McpTransport = 'stdio' | 'streamable-http'

export interface McpServer {
  /** Loader row id — also the stable key the window edits and deletes by. */
  readonly id: string
  readonly serverName: string
  readonly transport: McpTransport
  readonly command?: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly failOnStartupError?: boolean
  readonly enabled: boolean
  /** True when this came from the legacy plugin row and has not been migrated yet. */
  readonly legacy?: boolean
}

/** What the window submits. `id` absent means "create a new row". */
export interface McpServerInput {
  readonly id?: string
  readonly serverName: string
  readonly transport: McpTransport
  readonly command?: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly failOnStartupError?: boolean
  readonly enabled?: boolean
}

export type SkillKind = 'bundle' | 'file'

export interface SkillEntry {
  readonly name: string
  readonly description: string
  readonly path: string
  readonly kind: SkillKind
  /** True when the entry is a link the shell created (removable); real directories are not. */
  readonly linked: boolean
  readonly target?: string
}

export interface ConfigResult {
  readonly ok: boolean
  readonly reason?: string
}

export interface MigrationResult extends ConfigResult {
  readonly servers: number
  readonly skills: number
  /** True when there was nothing to migrate (already clean or never used the plugin). */
  readonly alreadyDone: boolean
  /** Top-level MCP rows the old shell wrote by mistake and this run moved into the insert container. */
  readonly repaired: number
}

export interface LegacyUsageConfig {
  readonly baseUrl?: string
  readonly refreshSeconds?: number
  readonly sessionCookie?: string
}

/** Everything the store needs; injected so the module is testable without Electron. */
export interface DshConfigOptions {
  /** `$DSH_HOME`. */
  readonly home: string
  /** Profile name; defaults to the desktop profile. */
  readonly profileName?: string
  readonly log?: (line: string) => void
}

export interface DshConfigStore {
  readonly patchPath: string
  readonly skillsRoot: string
  listMcpServers(): readonly McpServer[]
  saveMcpServer(input: McpServerInput): ConfigResult
  removeMcpServer(id: string): ConfigResult
  setMcpEnabled(id: string, enabled: boolean): ConfigResult
  listSkills(): readonly SkillEntry[]
  addSkillLink(directory: string, name?: string): ConfigResult
  removeSkillLink(name: string): ConfigResult
  /** One-shot migration of the legacy plugin's MCP records and links. Idempotent. */
  migrateLegacy(): MigrationResult
  /** The QR-login cookie/settings the ONE-WAY plugin stored in its row, for the usage window. */
  readLegacyUsageConfig(): LegacyUsageConfig | undefined
  /** Remove patch rows whose `id` or `name` is in `names` (used when the shell owns the feature). */
  removeRows(names: readonly string[]): ConfigResult & { readonly removed: number }
}

/** Home directory plus the profile the desktop shell boots. */
export function resolveProfilePaths(options: DshConfigOptions): { readonly home: string; readonly profileDir: string; readonly patchPath: string; readonly skillsRoot: string } {
  const profileName = options.profileName ?? process.env[PROFILE_ENV] ?? DESKTOP_PROFILE_NAME
  const profileDir = join(options.home, 'profiles', profileName)
  return {
    home: options.home,
    profileDir,
    patchPath: join(profileDir, 'cordis.patch.yml'),
    skillsRoot: join(options.home, 'skills'),
  }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

const stringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined

const stringRecord = (value: unknown): Record<string, string> | undefined => {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'string') out[key] = item
    else if (typeof item === 'number' || typeof item === 'boolean') out[key] = String(item)
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/** Filesystem-safe row id; human-readable enough to find in the patch file. */
export function mcpRowId(serverName: string): string {
  const slug = serverName.trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '')
  return `mcp-${slug === '' ? 'server' : slug}`
}

/** Map a row's `config` to the window's shape; undefined when the row is not a usable MCP row. */
export function readMcpRow(id: string, config: unknown, disabled: boolean): McpServer | undefined {
  const record = asRecord(config)
  if (record === undefined) return undefined
  const serverName = typeof record.serverName === 'string' && record.serverName !== '' ? record.serverName : id
  const transport: McpTransport = record.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
  if (transport === 'stdio') {
    const command = typeof record.command === 'string' ? record.command : undefined
    if (command === undefined || command === '') return undefined
    return {
      id,
      serverName,
      transport,
      command,
      ...(() => { const args = stringArray(record.args); return args === undefined ? {} : { args } })(),
      ...(() => { const cwd = typeof record.cwd === 'string' && record.cwd !== '' ? record.cwd : undefined; return cwd === undefined ? {} : { cwd } })(),
      ...(() => { const env = stringRecord(record.env); return env === undefined ? {} : { env } })(),
      ...(record.failOnStartupError === true ? { failOnStartupError: true } : {}),
      enabled: !disabled,
    }
  }
  const url = typeof record.url === 'string' ? record.url : undefined
  if (url === undefined || url === '') return undefined
  return {
    id,
    serverName,
    transport,
    url,
    ...(() => { const headers = stringRecord(record.headers); return headers === undefined ? {} : { headers } })(),
    ...(record.failOnStartupError === true ? { failOnStartupError: true } : {}),
    enabled: !disabled,
  }
}

/** Build the native `@deepseek-ai/dsh-mcp-client` config from a window input. */
export function mcpRowConfig(input: McpServerInput): Record<string, unknown> {
  const base: Record<string, unknown> = {
    serverName: input.serverName.trim(),
    transport: input.transport,
    failOnStartupError: input.failOnStartupError === true,
  }
  if (input.transport === 'streamable-http') {
    base.url = input.url?.trim() ?? ''
    if (input.headers !== undefined && Object.keys(input.headers).length > 0) base.headers = { ...input.headers }
    return base
  }
  base.command = input.command?.trim() ?? ''
  if (input.args !== undefined && input.args.length > 0) base.args = [...input.args]
  if (input.cwd !== undefined && input.cwd.trim() !== '') base.cwd = input.cwd.trim()
  if (input.env !== undefined && Object.keys(input.env).length > 0) base.env = { ...input.env }
  return base
}

/** Copy of a YAML document item's `toJS` value, with a string id when present. */
function itemId(item: unknown): string | undefined {
  const map = asRecord(item)
  const id = map?.id
  return typeof id === 'string' ? id : undefined
}

/* --- patch document shape ------------------------------------------------------------------ */

interface PatchRow {
  /** Array that owns the row: the document's top-level entry list or an insert container's list. */
  readonly seq: unknown[]
  readonly index: number
  readonly map: YAMLMap
  /** True when the row lives inside an `- insert: [...]` container (the only mounted position). */
  readonly inserted: boolean
}

/** The document root as a patch list, or undefined when the file is not a top-level array. */
function patchItems(doc: Document): unknown[] | undefined {
  const root = doc.contents as unknown as { items?: unknown[] } | null
  return Array.isArray(root?.items) ? root.items : undefined
}

const asMapNode = (node: unknown): YAMLMap | undefined => (isMap(node) ? node : undefined)

const asSeqNode = (node: unknown): YAMLSeq | undefined => (isSeq(node) ? node : undefined)

/** A top-level `- insert: [...]` container: an entry whose only key is `insert`. */
function insertContainer(node: unknown): YAMLMap | undefined {
  const map = asMapNode(node)
  if (map === undefined || map.items.length !== 1 || !map.has('insert')) return undefined
  return map
}

const mapString = (map: YAMLMap, key: string): string | undefined => {
  const value = map.get(key)
  return typeof value === 'string' ? value : undefined
}

const rowId = (row: PatchRow): string | undefined => mapString(row.map, 'id')
const rowName = (row: PatchRow): string | undefined => mapString(row.map, 'name')

/** Plain (JSON-safe) view of one node; undefined for values that are not mappings. */
function nodeRecord(node: unknown): Record<string, unknown> | undefined {
  if (typeof node !== 'object' || node === null) return undefined
  try {
    const toJSON = (node as { toJSON?: () => unknown }).toJSON
    return asRecord(typeof toJSON === 'function' ? toJSON.call(node) : node)
  } catch {
    return undefined
  }
}

/** Every patch row in file order: top-level entries and the children of insert containers. */
function patchRows(doc: Document): PatchRow[] {
  const items = patchItems(doc)
  if (items === undefined) return []
  const rows: PatchRow[] = []
  for (let index = 0; index < items.length; index += 1) {
    const node = items[index]
    const container = insertContainer(node)
    if (container !== undefined) {
      const seq = asSeqNode(container.get('insert'))
      if (seq !== undefined) {
        for (let child = 0; child < seq.items.length; child += 1) {
          const map = asMapNode(seq.items[child])
          if (map !== undefined) rows.push({ seq: seq.items, index: child, map, inserted: true })
        }
        continue
      }
    }
    const map = asMapNode(node)
    if (map !== undefined) rows.push({ seq: items, index, map, inserted: false })
  }
  return rows
}

/**
 * The list new loader rows go in: the first `- insert: [...]` container, moved to the top of the
 * patch list, or a freshly created container there.
 *
 * Creating it transfers the first entry's `commentBefore` to the container, so the file's leading
 * comment stays at the top instead of moving down with an unrelated row.
 */
function ensureInsertRows(doc: Document, items: unknown[]): unknown[] {
  let container: YAMLMap | undefined
  let at = -1
  for (let index = 0; index < items.length; index += 1) {
    const candidate = insertContainer(items[index])
    if (candidate !== undefined) {
      container = candidate
      at = index
      break
    }
  }
  if (container === undefined) {
    const created = doc.createNode({ insert: [] }) as unknown as YAMLMap
    const first = items[0] as { commentBefore?: string | null } | undefined
    if (first?.commentBefore !== undefined && first.commentBefore !== null) {
      created.commentBefore = first.commentBefore
      first.commentBefore = null
    }
    items.unshift(created)
    container = created
    at = 0
  }
  // The container must be applied before any top-level patch: only rows that already exist can be
  // found by a later override.
  if (at !== 0) {
    items.splice(at, 1)
    items.unshift(container)
    // Keep the file's leading comment at the top: it was attached to the entry that used to be first.
    const displacedFirst = items[1] as { commentBefore?: string | null } | undefined
    if ((container.commentBefore === undefined || container.commentBefore === null)
      && displacedFirst?.commentBefore !== undefined && displacedFirst.commentBefore !== null) {
      container.commentBefore = displacedFirst.commentBefore
      displacedFirst.commentBefore = null
    }
  }
  const existing = asSeqNode(container.get('insert'))
  if (existing !== undefined) return existing.items
  const created = doc.createNode([]) as unknown as YAMLSeq
  container.set('insert', created)
  return created.items
}

/**
 * Move every top-level `@deepseek-ai/dsh-mcp-client` row into the insert container.
 *
 * Those rows are what the old shell wrote; a top-level patch with a `name` is only an assertion, so
 * they never mounted and the loader warns `patch: entry "mcp-…" not found` for each of them. Moving
 * the original node keeps its fields and comments, and the id stays the key the window edits by.
 * Returns how many rows were moved; idempotent once they are all inside the container.
 */
function normalizeMcpRows(doc: Document, items: unknown[]): number {
  const targets = patchRows(doc).filter((row) => !row.inserted && rowName(row) === MCP_CLIENT)
  if (targets.length === 0) return 0
  const inserted = ensureInsertRows(doc, items)
  let moved = 0
  for (const row of targets) {
    const at = items.indexOf(row.map)
    if (at < 0) continue
    items.splice(at, 1)
    inserted.push(row.map)
    moved += 1
  }
  return moved
}

/** Locate an MCP row by id: container children always, top-level rows only when they are MCP rows. */
function findMcpRow(doc: Document, id: string): PatchRow | undefined {
  const rows = patchRows(doc)
  return rows.find((row) => row.inserted && rowId(row) === id)
    ?? rows.find((row) => !row.inserted && rowId(row) === id && rowName(row) === MCP_CLIENT)
}

/** Write the window's input into an existing row, keeping its position and unrelated keys. */
function setMcpRow(doc: Document, map: YAMLMap, id: string, config: Record<string, unknown>, enabled: boolean | undefined): void {
  map.set('id', doc.createNode(id))
  map.set('name', doc.createNode(MCP_CLIENT))
  map.set('config', doc.createNode(config))
  if (enabled === false) map.set('disabled', doc.createNode(true))
  else map.delete('disabled')
}

/**
 * Read a skill frontmatter block.
 *
 * Only `name` and `description` are needed for the list; unknown keys are ignored on purpose so a
 * richer SKILL.md still lists correctly. A malformed frontmatter is not an error: the directory name
 * is a perfectly good skill name.
 */
export function readSkillMeta(directory: string): { name: string; description: string } {
  const fallback = { name: basename(directory), description: '' }
  try {
    const text = readFileSync(join(directory, 'SKILL.md'), 'utf8')
    const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text)
    if (match === null) {
      const heading = /^#\s+(.+)$/mu.exec(text)
      return { name: fallback.name, description: heading?.[1]?.trim() ?? '' }
    }
    const meta = asRecord(parseYaml(match[1] ?? ''))
    return {
      name: typeof meta?.name === 'string' && meta.name !== '' ? meta.name : fallback.name,
      description: typeof meta?.description === 'string' ? meta.description : '',
    }
  } catch {
    return fallback
  }
}

export function createDshConfigStore(options: DshConfigOptions): DshConfigStore {
  const paths = resolveProfilePaths(options)
  const log = options.log ?? (() => {})
  let document: Document | undefined
  let documentText = ''

  const load = (): Document | undefined => {
    try {
      const text = readFileSync(paths.patchPath, 'utf8')
      if (document !== undefined && text === documentText) return document
      const parsed = parseDocument(text)
      if (parsed.errors.length > 0) {
        log(`DSH 配置：无法解析 ${paths.patchPath}（${parsed.errors[0]?.message ?? '未知错误'}）`)
        return undefined
      }
      document = parsed
      documentText = text
      return document
    } catch (error) {
      // A missing patch is normal, not a failure: the first start of a fresh profile runs the
      // provisioning pass before `ensureDesktopProfile` has seeded the file. Logging "读取失败"
      // there was pure noise — the same confusing line the MCP window used to print on first run.
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
      log(`DSH 配置：读取 ${paths.patchPath} 失败（${String(error)}）`)
      return undefined
    }
  }

  /** Top-level rows of the patch file as plain objects, in file order (container children excluded). */
  const rows = (doc: Document): unknown[] => Array.isArray(doc.toJS()) ? doc.toJS() as unknown[] : []

  const persist = (doc: Document): ConfigResult => {
    try {
      const next = doc.toString()
      if (next === documentText) return { ok: true }
      // Back up the previous file before the first write of this process; keep the five newest.
      if (existsSync(paths.patchPath)) {
        const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
        const backup = `${paths.patchPath}.bak-shell-${stamp}`
        writeFileSync(backup, documentText, 'utf8')
        pruneBackups(paths.patchPath)
      }
      mkdirSync(paths.profileDir, { recursive: true })
      const temporary = `${paths.patchPath}.tmp-${String(process.pid)}`
      writeFileSync(temporary, next, 'utf8')
      renameSync(temporary, paths.patchPath)
      document = doc
      documentText = next
      return { ok: true }
    } catch (error) {
      log(`DSH 配置：写入 ${paths.patchPath} 失败（${String(error)}）`)
      return { ok: false, reason: `写入 DSH 配置失败：${String(error)}` }
    }
  }

  const listMcpServers = (): readonly McpServer[] => {
    const doc = load()
    if (doc === undefined) return []
    const out: McpServer[] = []
    const seen = new Set<string>()
    for (const row of patchRows(doc)) {
      const id = rowId(row)
      if (id === undefined || seen.has(id)) continue
      if (rowName(row) === MCP_CLIENT) {
        const record = nodeRecord(row.map)
        const server = readMcpRow(id, record?.config, record?.disabled === true)
        if (server !== undefined) {
          seen.add(id)
          out.push(server)
        }
        continue
      }
      if (id === LEGACY_MCP_SKILL_ROW) {
        seen.add(id)
        // The legacy plugin kept an array under its own config; show those servers until migration.
        const legacy = asRecord(nodeRecord(row.map)?.config)?.mcpServers
        if (Array.isArray(legacy)) {
          for (const entry of legacy) {
            const recordEntry = asRecord(entry)
            if (recordEntry === undefined) continue
            const serverName = typeof recordEntry.serverName === 'string' ? recordEntry.serverName : 'legacy'
            const server = readMcpRow(mcpRowId(serverName), recordEntry, false)
            if (server !== undefined) out.push({ ...server, legacy: true })
          }
        }
      }
    }
    return out
  }

  const saveMcpServer = (input: McpServerInput): ConfigResult => {
    const serverName = input.serverName.trim()
    if (serverName === '') return { ok: false, reason: '服务名不能为空。' }
    if (input.transport === 'stdio' && (input.command === undefined || input.command.trim() === '')) {
      return { ok: false, reason: 'stdio 传输必须填写启动命令。' }
    }
    if (input.transport === 'streamable-http' && (input.url === undefined || input.url.trim() === '')) {
      return { ok: false, reason: 'HTTP 传输必须填写 URL。' }
    }
    const doc = load()
    if (doc === undefined) return { ok: false, reason: 'DSH 配置文件不可解析，未做修改。' }
    const items = patchItems(doc)
    if (items === undefined) return { ok: false, reason: 'DSH 配置的根节点不是补丁列表，未做修改。' }
    const id = input.id !== undefined && input.id !== '' ? input.id : mcpRowId(serverName)
    const config = mcpRowConfig({ ...input, serverName })
    const existing = findMcpRow(doc, id)
    // Always go through the container: creating it when absent, pulling it to the front when an
    // older file has it later. Only rows in a first-position insert container are actually mounted.
    const inserted = ensureInsertRows(doc, items)
    if (existing !== undefined) {
      if (!existing.inserted) {
        // An old top-level row: move the row itself into the insert container first (a top-level
        // entry would never mount), then write the edit into it so comments and extra keys survive.
        const at = items.indexOf(existing.map)
        if (at >= 0) items.splice(at, 1)
        inserted.push(existing.map)
      }
      setMcpRow(doc, existing.map, id, config, input.enabled)
    } else {
      inserted.push(doc.createNode({
        id,
        name: MCP_CLIENT,
        config,
        ...(input.enabled === false ? { disabled: true } : {}),
      }))
    }
    return persist(doc)
  }

  const removeMcpServer = (id: string): ConfigResult => {
    const doc = load()
    if (doc === undefined) return { ok: false, reason: 'DSH 配置文件不可解析，未做修改。' }
    if (patchItems(doc) === undefined) return { ok: false, reason: 'DSH 配置的根节点不是补丁列表，未做修改。' }
    // Both positions count: an old top-level row and a correct container child can coexist after a
    // partial repair, and leaving the top-level one behind would resurrect the row on the next repair.
    const matches = patchRows(doc).filter((row) => rowId(row) === id)
    if (matches.length === 0) return { ok: false, reason: '找不到这条 MCP 记录（可能已被移除）。' }
    for (const row of matches.sort((left, right) => right.index - left.index)) row.seq.splice(row.index, 1)
    return persist(doc)
  }

  const setMcpEnabled = (id: string, enabled: boolean): ConfigResult => {
    const doc = load()
    if (doc === undefined) return { ok: false, reason: 'DSH 配置文件不可解析，未做修改。' }
    if (patchItems(doc) === undefined) return { ok: false, reason: 'DSH 配置的根节点不是补丁列表，未做修改。' }
    const rowsOfId = patchRows(doc).filter((row) => rowId(row) === id)
    // Prefer the mounted row when a stray top-level duplicate is still around.
    const row = rowsOfId.find((entry) => entry.inserted) ?? rowsOfId[0]
    if (row === undefined) return { ok: false, reason: '找不到这条 MCP 记录。' }
    if (enabled) row.map.delete('disabled')
    else row.map.set('disabled', doc.createNode(true))
    return persist(doc)
  }

  const listSkills = (): readonly SkillEntry[] => {
    const out: SkillEntry[] = []
    let entries: string[]
    try {
      entries = readdirSync(paths.skillsRoot)
    } catch {
      return out
    }
    for (const name of entries.sort()) {
      const path = join(paths.skillsRoot, name)
      try {
        const info = lstatSync(path)
        if (info.isSymbolicLink()) {
          let target = ''
          try { target = resolve(paths.skillsRoot, readLink(path)) } catch { target = '' }
          const meta = target === '' ? { name, description: '' } : readSkillMeta(target)
          out.push({ name: meta.name === '' ? name : meta.name, description: meta.description, path, kind: 'bundle', linked: true, ...(target === '' ? {} : { target }) })
          continue
        }
        if (info.isDirectory()) {
          if (!existsSync(join(path, 'SKILL.md'))) continue
          const meta = readSkillMeta(path)
          out.push({ name: meta.name === '' ? name : meta.name, description: meta.description, path, kind: 'bundle', linked: false })
          continue
        }
        if (info.isFile() && name.toLowerCase().endsWith('.md')) {
          out.push({ name: name.replace(/\.md$/iu, ''), description: '', path, kind: 'file', linked: false })
        }
      } catch {
        // A disappearing entry is not worth failing the list for.
      }
    }
    return out
  }

  const addSkillLink = (directory: string, name?: string): ConfigResult => {
    const target = isAbsolute(directory) ? resolve(directory) : resolve(directory)
    if (!existsSync(join(target, 'SKILL.md'))) return { ok: false, reason: '所选目录里没有 SKILL.md，不是 DSH Skill 目录。' }
    const meta = readSkillMeta(target)
    const skillName = (name ?? meta.name ?? basename(target)).trim()
    if (skillName === '' || /[\\/:*?"<>|]/u.test(skillName) || skillName === '.' || skillName === '..') {
      return { ok: false, reason: 'Skill 名称非法。' }
    }
    const destination = join(paths.skillsRoot, skillName)
    if (existsSync(destination)) return { ok: false, reason: `Skills 目录里已有同名条目：${skillName}` }
    try {
      mkdirSync(paths.skillsRoot, { recursive: true })
      symlinkSync(target, destination, 'junction')
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: `创建链接失败：${String(error)}` }
    }
  }

  const removeSkillLink = (name: string): ConfigResult => {
    const path = join(paths.skillsRoot, name)
    try {
      const info = lstatSync(path)
      if (!info.isSymbolicLink()) return { ok: false, reason: '这不是壳创建的链接；为避免误删内容，请手动处理。' }
      unlinkSync(path)
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: `移除链接失败：${String(error)}` }
    }
  }

  const migrateLegacy = (): MigrationResult => {
    // Nothing to migrate in a profile that has no patch yet (the shell seeds it on first run).
    if (!existsSync(paths.patchPath)) {
      return { ok: true, servers: 0, skills: 0, alreadyDone: true, repaired: 0 }
    }
    const doc = load()
    if (doc === undefined) return { ok: false, reason: 'DSH 配置文件不可解析，未做迁移。', servers: 0, skills: 0, alreadyDone: false, repaired: 0 }
    const items = patchItems(doc)
    if (items === undefined) return { ok: false, reason: 'DSH 配置的根节点不是补丁列表，未做迁移。', servers: 0, skills: 0, alreadyDone: false, repaired: 0 }

    // Repair first, and even when there is no legacy row to migrate: real profiles already contain
    // MCP rows written the broken way by the old shell, so "already done" can still need this fix.
    const repaired = normalizeMcpRows(doc, items)
    const legacyRow = patchRows(doc).find((row) => rowId(row) === LEGACY_MCP_SKILL_ROW)
    if (legacyRow === undefined && repaired === 0) {
      return { ok: true, servers: 0, skills: 0, alreadyDone: true, repaired: 0 }
    }

    const legacyConfig = legacyRow === undefined ? undefined : asRecord(nodeRecord(legacyRow.map.get('config')))
    const legacyServers = Array.isArray(legacyConfig?.mcpServers) ? legacyConfig.mcpServers : []
    const legacyLinks = Array.isArray(legacyConfig?.skillLinks)
      ? legacyConfig.skillLinks.filter((item): item is Record<string, unknown> => asRecord(item) !== undefined && asRecord(item)?.enabled !== false)
      : []
    let servers = 0
    if (legacyRow !== undefined) {
      const existingNames = new Set(listMcpServers().filter((server) => server.legacy !== true).map((server) => server.serverName))
      const existingIds = new Set(patchRows(doc).map((row) => rowId(row)).filter((id): id is string => id !== undefined))
      for (const entry of legacyServers) {
        const record = asRecord(entry)
        if (record === undefined) continue
        const serverName = typeof record.serverName === 'string' && record.serverName !== '' ? record.serverName : undefined
        if (serverName === undefined || existingNames.has(serverName)) continue
        const id = mcpRowId(serverName)
        if (existingIds.has(id)) continue
        ensureInsertRows(doc, items).push(doc.createNode({ id, name: MCP_CLIENT, config: mcpRowConfig(legacyToInput(record)) }))
        existingNames.add(serverName)
        existingIds.add(id)
        servers += 1
      }
      // Remove the legacy row: keeping it would load the plugin's own MCP clients next to the native
      // rows once the package is injected, and the servers would appear twice.
      const at = legacyRow.seq.indexOf(legacyRow.map)
      if (at >= 0) legacyRow.seq.splice(at, 1)
    }
    const persisted = persist(doc)
    if (!persisted.ok) return { ...persisted, servers: 0, skills: 0, alreadyDone: false, repaired: 0 }
    if (repaired > 0) log(`DSH 配置：已把 ${String(repaired)} 条 MCP 行改为 insert 补丁（旧写法不会挂载）`)
    if (legacyRow !== undefined) {
      log(`DSH 配置：已把 ${String(servers)} 个 MCP 服务从旧插件迁移为原生配置，并移除旧插件行；技能链接 ${String(legacyLinks.length)} 个保持原样`)
    }
    return { ok: true, servers, skills: legacyLinks.length, alreadyDone: legacyRow === undefined, repaired }
  }

  const readLegacyUsageConfig = (): LegacyUsageConfig | undefined => {
    const doc = load()
    if (doc === undefined) return undefined
    const row = rows(doc).find((entry) => itemId(entry) === LEGACY_ONEWAY_ROW)
    const config = asRecord(asRecord(row)?.config)
    if (config === undefined) return undefined
    return {
      ...(typeof config.baseUrl === 'string' ? { baseUrl: config.baseUrl } : {}),
      ...(typeof config.refreshSeconds === 'number' ? { refreshSeconds: config.refreshSeconds } : {}),
      ...(typeof config.sessionCookie === 'string' && config.sessionCookie !== '' ? { sessionCookie: config.sessionCookie } : {}),
    }
  }

  const removeRows = (names: readonly string[]): ConfigResult & { readonly removed: number } => {
    const doc = load()
    if (doc === undefined) return { ok: false, reason: 'DSH 配置文件不可解析，未做修改。', removed: 0 }
    if (patchItems(doc) === undefined) return { ok: false, reason: 'DSH 配置的根节点不是补丁列表，未做修改。', removed: 0 }
    const wanted = new Set(names)
    // Container children and top-level rows alike: plugin rows may be written either way.
    const matches = patchRows(doc).filter((row) => {
      const id = rowId(row)
      const name = rowName(row)
      return (id !== undefined && wanted.has(id)) || (name !== undefined && wanted.has(name))
    })
    if (matches.length === 0) return { ok: true, removed: 0 }
    for (const row of matches.sort((left, right) => right.index - left.index)) row.seq.splice(row.index, 1)
    const persisted = persist(doc)
    return { ...persisted, removed: persisted.ok ? matches.length : 0 }
  }

  return {
    patchPath: paths.patchPath,
    skillsRoot: paths.skillsRoot,
    listMcpServers,
    saveMcpServer,
    removeMcpServer,
    setMcpEnabled,
    listSkills,
    addSkillLink,
    removeSkillLink,
    migrateLegacy,
    readLegacyUsageConfig,
    removeRows,
  }
}

/** Turn one legacy plugin record into the window's input shape. */
function legacyToInput(record: Record<string, unknown>): McpServerInput {
  const transport: McpTransport = record.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
  const envRecord = stringRecord(record.env)
  const headerRecord = stringRecord(record.headers)
  return {
    serverName: typeof record.serverName === 'string' ? record.serverName : 'legacy',
    transport,
    ...(typeof record.command === 'string' ? { command: record.command } : {}),
    ...(() => { const args = stringArray(record.args); return args === undefined ? {} : { args } })(),
    ...(typeof record.cwd === 'string' && record.cwd !== '' ? { cwd: record.cwd } : {}),
    ...(envRecord === undefined ? {} : { env: envRecord }),
    ...(typeof record.url === 'string' ? { url: record.url } : {}),
    ...(headerRecord === undefined ? {} : { headers: headerRecord }),
    failOnStartupError: record.failOnStartupError === true,
  }
}

/** `readlinkSync` returns the absolute target for a junction created by `symlinkSync(…, 'junction')`. */
function readLink(path: string): string {
  return readlinkSync(path)
}

/** Keep the last five shell-written backups; the user's own `.bak-*` files are never touched. */
function pruneBackups(patchPath: string): void {
  try {
    const directory = resolve(patchPath, '..')
    const prefix = `${basename(patchPath)}.bak-shell-`
    const backups = readdirSync(directory)
      .filter((name) => name.startsWith(prefix))
      .sort()
    for (const name of backups.slice(0, Math.max(0, backups.length - 5))) {
      rmSync(join(directory, name), { force: true })
    }
  } catch {
    // Backups are a courtesy; never fail a save because old ones could not be pruned.
  }
}
