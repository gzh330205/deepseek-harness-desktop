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

import { parseDocument, parse as parseYaml, type Document } from 'yaml'

import { DESKTOP_PROFILE_NAME, PROFILE_ENV } from './constants.ts'

/** Row name of the native MCP client; the install-time overlay uses the same name. */
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
      log(`DSH 配置：读取 ${paths.patchPath} 失败（${String(error)}）`)
      return undefined
    }
  }

  /** Rows of the patch file as plain objects, in file order. */
  const rows = (doc: Document): unknown[] => Array.isArray(doc.toJS()) ? doc.toJS() as unknown[] : []

  const rowIndex = (doc: Document, id: string): number => rows(doc).findIndex((row) => itemId(row) === id)

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
    for (const row of rows(doc)) {
      const record = asRecord(row)
      if (record === undefined) continue
      const id = typeof record.id === 'string' ? record.id : undefined
      if (id === undefined) continue
      if (record.name === MCP_CLIENT) {
        const server = readMcpRow(id, record.config, record.disabled === true)
        if (server !== undefined) out.push(server)
        continue
      }
      if (id === LEGACY_MCP_SKILL_ROW) {
        // The legacy plugin kept an array under its own config; show those servers until migration.
        const legacy = asRecord(record.config)?.mcpServers
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
    const root = doc.contents
    if (!Array.isArray((root as { items?: unknown[] }).items)) return { ok: false, reason: 'DSH 配置的根节点不是补丁列表，未做修改。' }
    const items = (root as unknown as { items: unknown[] }).items
    const id = input.id !== undefined && input.id !== '' ? input.id : mcpRowId(serverName)
    const existing = rowIndex(doc, id)
    const node = {
      id,
      name: MCP_CLIENT,
      config: mcpRowConfig({ ...input, serverName }),
      ...(input.enabled === false ? { disabled: true } : {}),
    }
    const created = doc.createNode(node) as unknown
    if (existing >= 0) items[existing] = created
    else items.push(created)
    return persist(doc)
  }

  const removeMcpServer = (id: string): ConfigResult => {
    const doc = load()
    if (doc === undefined) return { ok: false, reason: 'DSH 配置文件不可解析，未做修改。' }
    const items = (doc.contents as unknown as { items?: unknown[] } | null)?.items
    if (items === undefined) return { ok: false, reason: 'DSH 配置的根节点不是补丁列表，未做修改。' }
    const index = rowIndex(doc, id)
    if (index < 0) return { ok: false, reason: '找不到这条 MCP 记录（可能已被移除）。' }
    items.splice(index, 1)
    return persist(doc)
  }

  const setMcpEnabled = (id: string, enabled: boolean): ConfigResult => {
    const doc = load()
    if (doc === undefined) return { ok: false, reason: 'DSH 配置文件不可解析，未做修改。' }
    const items = (doc.contents as unknown as { items?: unknown[] } | null)?.items
    const index = rowIndex(doc, id)
    if (items === undefined || index < 0) return { ok: false, reason: '找不到这条 MCP 记录。' }
    const item = items[index] as { set?: (key: string, value: unknown) => void; delete?: (key: string) => void } | undefined
    if (item === undefined) return { ok: false, reason: '找不到这条 MCP 记录。' }
    if (enabled) item.delete?.('disabled')
    else item.set?.('disabled', true)
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
    const doc = load()
    if (doc === undefined) return { ok: false, reason: 'DSH 配置文件不可解析，未做迁移。', servers: 0, skills: 0, alreadyDone: false }
    const all = rows(doc)
    const legacyRow = all.find((row) => itemId(row) === LEGACY_MCP_SKILL_ROW)
    const legacyConfig = asRecord(asRecord(legacyRow)?.config)
    const legacyServers = Array.isArray(legacyConfig?.mcpServers) ? legacyConfig.mcpServers : []
    const legacyLinks = Array.isArray(legacyConfig?.skillLinks)
      ? legacyConfig.skillLinks.filter((item): item is Record<string, unknown> => asRecord(item) !== undefined && asRecord(item)?.enabled !== false)
      : []
    if (legacyRow === undefined) return { ok: true, servers: 0, skills: 0, alreadyDone: true }

    const items = (doc.contents as unknown as { items?: unknown[] } | null)?.items
    if (items === undefined) return { ok: false, reason: 'DSH 配置的根节点不是补丁列表，未做迁移。', servers: 0, skills: 0, alreadyDone: false }
    const existingNames = new Set(listMcpServers().filter((server) => server.legacy !== true).map((server) => server.serverName))
    let servers = 0
    for (const entry of legacyServers) {
      const record = asRecord(entry)
      if (record === undefined) continue
      const serverName = typeof record.serverName === 'string' && record.serverName !== '' ? record.serverName : undefined
      if (serverName === undefined || existingNames.has(serverName)) continue
      const id = mcpRowId(serverName)
      if (rowIndex(doc, id) >= 0) continue
      items.push(doc.createNode({ id, name: MCP_CLIENT, config: mcpRowConfig(legacyToInput(record)) }))
      existingNames.add(serverName)
      servers += 1
    }
    // Remove the legacy row: keeping it would load the plugin's own MCP clients next to the native
    // rows once the package is injected, and the servers would appear twice.
    const legacyIndex = rowIndex(doc, LEGACY_MCP_SKILL_ROW)
    if (legacyIndex >= 0) items.splice(legacyIndex, 1)
    const persisted = persist(doc)
    if (!persisted.ok) return { ...persisted, servers: 0, skills: 0, alreadyDone: false }
    log(`DSH 配置：已把 ${String(servers)} 个 MCP 服务从旧插件迁移为原生配置，并移除旧插件行；技能链接 ${String(legacyLinks.length)} 个保持原样`)
    return { ok: true, servers, skills: legacyLinks.length, alreadyDone: false }
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
