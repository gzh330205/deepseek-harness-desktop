/**
 * Import MCP server definitions written for Codex or Claude Code / Claude Desktop.
 *
 * This is a pure parser: no Electron, no filesystem, no logging. Everything the caller needs to
 * preview an import — normalized `McpServerInput`s, per-entry warnings, existing-name conflicts and
 * fatal errors — comes back in one value. Secrets are never echoed: warnings name fields, never
 * values, because headers commonly carry bearer tokens.
 */

import { parse as parseToml } from 'smol-toml'

import type { McpServerInput, McpTransport } from './dsh-config.ts'

/** One import must stay reviewable; a pasted config with hundreds of servers is not a preview. */
export const MAX_IMPORT_ENTRIES = 100
/**
 * Pasted text / picked files are bounded before parsing (the IPC layer enforces the same limits).
 *
 * Both are 2 MB on purpose: a picked file at the limit must not then be rejected by `importParse` with
 * "choose a file instead" — there is no smaller path for the user at that point.
 */
export const MAX_IMPORT_TEXT_BYTES = 2 * 1024 * 1024
export const MAX_IMPORT_FILE_BYTES = 2 * 1024 * 1024

const MAX_NAME_LENGTH = 80
const MAX_MESSAGE_CHARS = 300

export type McpImportFormat = 'codex' | 'claude' | 'unknown'

/** The existing row this imported name would overwrite. */
export interface McpImportConflict {
  readonly id: string
}

export interface McpImportEntry {
  /** Trimmed server name (the section key in the source document). */
  readonly name: string
  /** What the MCP window would save, before `parseMcpInput` runs again on the write path. */
  readonly input: McpServerInput
  /** Non-fatal notes: ignored source fields, SSE caveats, dropped malformed values. Never secrets. */
  readonly warnings: readonly string[]
  /** Present when a server with this name already exists; `id` is the row to update on overwrite. */
  readonly conflict?: McpImportConflict
}

export interface McpImportResult {
  readonly format: McpImportFormat
  readonly entries: readonly McpImportEntry[]
  /** Fatal or per-entry errors. An entry with an error is not in `entries`. */
  readonly errors: readonly string[]
  /** Document-level warnings (duplicate names, truncation). */
  readonly warnings: readonly string[]
}

type SourceRecord = Record<string, unknown>

const isRecord = (value: unknown): value is SourceRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const messageOf = (error: unknown): string => {
  const message = (error instanceof Error ? error.message : String(error)).trim()
  const text = message === '' ? '未知错误。' : message
  return text.length <= MAX_MESSAGE_CHARS ? text : `${text.slice(0, MAX_MESSAGE_CHARS)}…`
}

/**
 * Parser messages point at the offending line, and those lines can be header assignments — i.e.
 * bearer tokens. Keep only the first line (JSON additionally drops the quoted snippet after the first
 * comma): the position is traded for never echoing configuration values back into the dialog.
 */
function safeParseError(label: 'JSON' | 'TOML', error: unknown): string {
  const message = messageOf(error)
  const firstLine = message.split(/\r?\n/u)[0] ?? message
  const withoutSnippet = label === 'JSON' ? (firstLine.split(',')[0] ?? firstLine) : firstLine
  return `${label} 解析失败：${withoutSnippet.slice(0, MAX_MESSAGE_CHARS)}`
}

/** Fields DSH can represent. Everything else is reported as ignored instead of silently dropped. */
const CODEX_HANDLED = new Set(['command', 'args', 'env', 'cwd', 'url', 'http_headers', 'headers', 'enabled'])
const CLAUDE_HANDLED = new Set(['command', 'args', 'env', 'cwd', 'url', 'headers', 'type', 'disabled', 'enabled'])

/** One field name list, sorted and bounded, for the "已忽略字段" warning. */
function ignoredFields(record: SourceRecord, handled: ReadonlySet<string>): string[] {
  return Object.keys(record).filter((key) => !handled.has(key)).sort()
}

function warnIgnored(record: SourceRecord, handled: ReadonlySet<string>, warnings: string[]): void {
  const ignored = ignoredFields(record, handled)
  if (ignored.length === 0) return
  const shown = ignored.slice(0, 20)
  warnings.push(`已忽略字段：${shown.join('、')}${ignored.length > shown.length ? ' 等' : ''}`)
}

/** A non-empty trimmed string field, or `undefined` for absent/blank/non-string values. */
function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** args: ordered strings only; anything else is reported, not silently dropped. */
function stringArgs(value: unknown, warnings: string[]): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    warnings.push('args 不是数组，已忽略。')
    return undefined
  }
  const out: string[] = []
  let dropped = 0
  for (const item of value) {
    if (typeof item === 'string') out.push(item)
    else dropped += 1
  }
  if (dropped > 0) warnings.push(`args 中有 ${String(dropped)} 个非字符串项已忽略。`)
  return out.length === 0 ? undefined : out
}

/** env / headers: scalar values become strings (TOML numbers and booleans are common). */
function scalarMap(value: unknown, warnings: string[], label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    warnings.push(`${label} 不是键值表，已忽略。`)
    return undefined
  }
  const out: Record<string, string> = {}
  let dropped = 0
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') out[key] = item
    else if (typeof item === 'number' || typeof item === 'boolean') out[key] = String(item)
    else dropped += 1
  }
  if (dropped > 0) warnings.push(`${label} 中有 ${String(dropped)} 个非标量值已忽略。`)
  return Object.keys(out).length === 0 ? undefined : out
}

/** Codex writes `http_headers`; some examples use `headers`. Accept both, `headers` winning. */
function headersOf(record: SourceRecord, warnings: string[]): Record<string, string> | undefined {
  const merged: Record<string, string> = {
    ...(scalarMap(record['http_headers'], warnings, 'http_headers') ?? {}),
    ...(scalarMap(record['headers'], warnings, 'headers') ?? {}),
  }
  return Object.keys(merged).length === 0 ? undefined : merged
}

interface BuiltEntry {
  readonly input?: McpServerInput
  readonly errors: readonly string[]
  readonly warnings: readonly string[]
}

/** The transport is decided by the fields that are present, not by a `type` hint alone. */
function transportOf(hasCommand: boolean, hasUrl: boolean): McpTransport | undefined {
  if (hasCommand === hasUrl) return undefined
  return hasCommand ? 'stdio' : 'streamable-http'
}

function stdioInput(
  name: string,
  command: string,
  raw: SourceRecord,
  warnings: string[],
  enabled: boolean,
): McpServerInput {
  const args = stringArgs(raw['args'], warnings)
  const env = scalarMap(raw['env'], warnings, 'env')
  const cwd = stringField(raw['cwd'])
  return {
    serverName: name,
    transport: 'stdio',
    command,
    enabled,
    ...(args === undefined ? {} : { args }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(env === undefined ? {} : { env }),
  }
}

function httpInput(name: string, url: string, headers: Record<string, string> | undefined, enabled: boolean): McpServerInput {
  return {
    serverName: name,
    transport: 'streamable-http',
    url,
    enabled,
    ...(headers === undefined ? {} : { headers }),
  }
}

/** Codex `[mcp_servers.<name>]`: `command`/`args`/`env`/`cwd` or `url`/`http_headers`. */
function codexEntry(name: string, raw: SourceRecord): BuiltEntry {
  const warnings: string[] = []
  const errors: string[] = []
  warnIgnored(raw, CODEX_HANDLED, warnings)

  const commandRaw = raw['command']
  const urlRaw = raw['url']
  const command = stringField(commandRaw)
  const url = stringField(urlRaw)
  if (commandRaw !== undefined && command === undefined) errors.push('command 必须是非空字符串。')
  if (urlRaw !== undefined && url === undefined) errors.push('url 必须是非空字符串。')

  const transport = transportOf(command !== undefined, url !== undefined)
  if (transport === undefined) {
    errors.push(command !== undefined && url !== undefined
      ? '同时配置了 command 与 url，无法判断传输方式，已跳过。'
      : '既没有 command 也没有 url，已跳过。')
    return { errors, warnings }
  }
  const enabled = raw['enabled'] !== false
  if (transport === 'stdio') {
    // Headers on a stdio server have no consumer; say so rather than leave them unexplained.
    for (const key of ['http_headers', 'headers']) {
      if (raw[key] !== undefined) warnings.push(`stdio 配置中的 ${key} 已忽略。`)
    }
    return { input: stdioInput(name, command as string, raw, warnings, enabled), errors, warnings }
  }
  return { input: httpInput(name, url as string, headersOf(raw, warnings), enabled), errors, warnings }
}

/** Claude Code / Desktop `mcpServers.<name>`: `command` (stdio) or `type`/`url` (remote). */
function claudeEntry(name: string, raw: SourceRecord): BuiltEntry {
  const warnings: string[] = []
  const errors: string[] = []
  warnIgnored(raw, CLAUDE_HANDLED, warnings)

  const commandRaw = raw['command']
  const urlRaw = raw['url']
  const typeRaw = raw['type']
  const command = stringField(commandRaw)
  const url = stringField(urlRaw)
  const type = typeof typeRaw === 'string' ? typeRaw.trim().toLowerCase() : ''
  if (commandRaw !== undefined && command === undefined) errors.push('command 必须是非空字符串。')
  if (urlRaw !== undefined && url === undefined) errors.push('url 必须是非空字符串。')
  if (typeRaw !== undefined && typeof typeRaw !== 'string') warnings.push('type 不是字符串，已按实际字段判断传输方式。')
  if (type === 'sse') warnings.push('DSH 只支持 streamable-http，SSE 配置可能连不上。')
  else if (type !== '' && type !== 'stdio' && type !== 'http' && type !== 'streamable-http') {
    warnings.push(`未知传输类型「${type}」，已按实际字段判断。`)
  }

  const transport = transportOf(command !== undefined, url !== undefined)
  if (transport === undefined) {
    errors.push(command !== undefined && url !== undefined
      ? '同时配置了 command 与 url，无法判断传输方式，已跳过。'
      : '既没有 command 也没有 url，已跳过。')
    return { errors, warnings }
  }
  // `disabled: true` is Claude Desktop's switch; `enabled: false` appears in hand-written files.
  const enabled = !(raw['disabled'] === true || raw['enabled'] === false)
  if (transport === 'stdio') {
    if (type === 'http' || type === 'streamable-http' || type === 'sse') {
      warnings.push(`type 为 ${type} 但存在 command，已按 stdio 导入。`)
    }
    for (const key of ['headers']) {
      if (raw[key] !== undefined) warnings.push(`stdio 配置中的 ${key} 已忽略。`)
    }
    return { input: stdioInput(name, command as string, raw, warnings, enabled), errors, warnings }
  }
  if (type === 'stdio') warnings.push('type 为 stdio 但没有 command，已按 URL 导入为 streamable-http。')
  return { input: httpInput(name, url as string, scalarMap(raw['headers'], warnings, 'headers'), enabled), errors, warnings }
}

interface ParseAttempt {
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: string
}

const tryJson = (text: string): ParseAttempt => {
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

const tryToml = (text: string): ParseAttempt => {
  try {
    return { ok: true, value: parseToml(text) }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

/**
 * Parse a Codex `config.toml` snippet or a Claude `mcpServers` JSON document.
 *
 * @param text - Pasted configuration text (or the content of a picked file).
 * @param existing - Current server rows, used to flag name conflicts with the id to overwrite.
 */
export function parseMcpImport(
  text: string,
  existing: readonly { readonly id: string; readonly serverName: string }[],
): McpImportResult {
  if (typeof text !== 'string') return { format: 'unknown', entries: [], errors: ['导入内容必须是文本。'], warnings: [] }
  const trimmed = text.trim()
  if (trimmed === '') return { format: 'unknown', entries: [], errors: ['导入内容为空。'], warnings: [] }

  // Shape decides the likely format, but the other parser is still tried: a `.mcp.json` saved with a
  // BOM-less TOML fragment, or a JSON document that starts with `[`, should get a real chance.
  const first = trimmed.startsWith('{') ? tryJson(trimmed) : tryToml(trimmed)
  const second = trimmed.startsWith('{') ? tryToml(trimmed) : tryJson(trimmed)
  let format: McpImportFormat
  let document: unknown
  if (first.ok) {
    format = trimmed.startsWith('{') ? 'claude' : 'codex'
    document = first.value
  } else if (second.ok) {
    format = trimmed.startsWith('{') ? 'codex' : 'claude'
    document = second.value
  } else {
    const firstLabel = trimmed.startsWith('{') ? 'JSON' : 'TOML'
    const secondLabel = firstLabel === 'JSON' ? 'TOML' : 'JSON'
    return {
      format: 'unknown',
      entries: [],
      errors: [
        safeParseError(firstLabel, first.error ?? '未知错误。'),
        safeParseError(secondLabel, second.error ?? '未知错误。'),
      ],
      warnings: [],
    }
  }

  if (!isRecord(document)) return { format, entries: [], errors: ['配置顶层必须是对象。'], warnings: [] }

  // Both spellings are accepted (Claude uses camelCase, Codex snake_case); merging keeps copy-pasted
  // mixed files working, and duplicate names are reported below.
  const sections: SourceRecord[] = []
  for (const key of ['mcpServers', 'mcp_servers']) {
    const section = document[key]
    if (isRecord(section)) sections.push(section)
  }
  if (sections.length === 0) {
    return {
      format,
      entries: [],
      errors: [format === 'claude' ? '未找到 mcpServers 配置。' : '未找到 mcp_servers 配置。'],
      warnings: [],
    }
  }
  const section: SourceRecord = Object.assign({}, ...sections)

  const errors: string[] = []
  const warnings: string[] = []
  const entries: McpImportEntry[] = []
  /** Name → index in `entries`, so a later duplicate can replace the earlier one in place. */
  const byName = new Map<string, number>()
  const build = format === 'claude' ? claudeEntry : codexEntry

  for (const [rawName, rawValue] of Object.entries(section)) {
    const name = rawName.trim()
    if (name === '') {
      errors.push('配置中存在空名称的服务，已跳过。')
      continue
    }
    if (name.length > MAX_NAME_LENGTH) {
      errors.push(`服务名超过 ${String(MAX_NAME_LENGTH)} 字符，已跳过：${name.slice(0, 24)}…`)
      continue
    }
    if (!isRecord(rawValue)) {
      errors.push(`${name}：配置必须是键值表，已跳过。`)
      continue
    }
    const built = build(name, rawValue)
    if (built.errors.length > 0) {
      for (const message of built.errors) errors.push(`${name}：${message}`)
      continue
    }
    if (built.input === undefined) {
      errors.push(`${name}：无法解析为 MCP 服务，已跳过。`)
      continue
    }
    const entry: McpImportEntry = { name, input: built.input, warnings: built.warnings }
    const previous = byName.get(name)
    if (previous !== undefined) {
      entries[previous] = entry
      warnings.push(`配置中重复定义「${name}」，后一条覆盖前一条。`)
      continue
    }
    byName.set(name, entries.length)
    entries.push(entry)
  }

  // Conflicts come from the live store list; the UI uses the id for "overwrite this row".
  const existingByName = new Map<string, string>()
  for (const server of existing) existingByName.set(server.serverName.trim(), server.id)
  let annotated: McpImportEntry[] = entries.map((entry) => {
    const id = existingByName.get(entry.name)
    return id === undefined ? entry : { ...entry, conflict: { id } }
  })
  if (annotated.length > MAX_IMPORT_ENTRIES) {
    warnings.push(`一次最多导入 ${String(MAX_IMPORT_ENTRIES)} 条，已只保留前 ${String(MAX_IMPORT_ENTRIES)} 条。`)
    annotated = annotated.slice(0, MAX_IMPORT_ENTRIES)
  }
  return { format, entries: annotated, errors, warnings }
}
