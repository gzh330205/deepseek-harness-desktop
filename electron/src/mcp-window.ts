/**
 * The MCP & Skills window.
 *
 * These two are DSH *configuration*, not conversation UI: the shell edits the profile patch and the
 * `$DSH_HOME/skills` directory directly, and the change takes effect after DSH restarts (the window
 * offers that button). No DSH plugin is involved, which is what lets the market-installed
 * `dsh-mcp-skill-manager` (and its aggregator) go away.
 */

import { BrowserWindow, dialog, ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { IPC, SHELL_PAGE_DOCUMENTS } from './constants.ts'
import type { DshConfigStore, McpServer, McpServerInput, McpTransport } from './dsh-config.ts'
import {
  MAX_IMPORT_ENTRIES,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_TEXT_BYTES,
  parseMcpImport,
  type McpImportResult,
} from './mcp-import.ts'
import { probeMcpServer, type McpProbeResult } from './mcp-probe.ts'

/** Where the Node executable offered to MCP stdio servers came from. */
export type McpNodeSource = 'bundled' | 'environment' | 'missing'

/** What the page's `node` bridge method reports: a path plus enough provenance for its hint. */
export interface McpNodeInfo {
  readonly path: string
  readonly source: McpNodeSource
  readonly exists: boolean
}

/** Outcome of writing a preview selection from the import dialog. */
export interface McpImportApplyResult {
  readonly ok: boolean
  readonly imported: number
  readonly skipped: number
  readonly failed: readonly { readonly name: string; readonly reason: string }[]
}

/** Result of picking a configuration file: its text, or a displayable reason it was not read. */
export type McpImportPickResult =
  | { readonly ok: true; readonly fileName: string; readonly text: string }
  | { readonly ok: false; readonly reason: string }

export interface McpWindowOptions {
  readonly appRoot: string
  readonly store: DshConfigStore
  /** Same predicate the shell uses for its own documents (`isLauncherSender`). */
  readonly isShellDocument: (url: string) => boolean
  /** Restart the shell (and its DSH child) so the edited config takes effect. */
  readonly restart: () => void
  /**
   * Node executable to prefill for stdio servers: the runtime bundled with the shell first, then
   * `DSH_DESKTOP_NODE_EXECUTABLE`. Only set when the main process confirmed the file exists.
   */
  readonly nodeExecutable?: string
  /** Provenance of {@link nodeExecutable}, used only by the page's hint. */
  readonly nodeSource?: McpNodeSource
  /**
   * Real availability check. Defaults to {@link probeMcpServer}; tests inject a fake so the window's
   * cache/dedupe rules can be exercised without spawning anything.
   */
  readonly probe?: (server: McpServer) => Promise<McpProbeResult>
}

const MCP_PAGE = '/mcp/index.html'

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)

const stringList = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined

const stringMap = (value: unknown): Record<string, string> | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') out[key] = item
  }
  return Object.keys(out).length === 0 ? undefined : out
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Best-effort name for a failed import item, so the failure list can say which one it was. */
function importNameOf(input: unknown): string {
  if (!isRecord(input)) return ''
  const name = input['serverName']
  return typeof name === 'string' ? name.trim().slice(0, 80) : ''
}

/** One renderer message → a store input; unknown shapes become validation errors, never crashes. */
export function parseMcpInput(value: unknown): McpServerInput | { readonly reason: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { reason: 'MCP 记录格式无效。' }
  const request = value as Record<string, unknown>
  const serverName = text(request.serverName)
  if (serverName === undefined) return { reason: '服务名不能为空。' }
  const transport: McpTransport = request.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
  const enabled = request.enabled !== false
  const failOnStartupError = request.failOnStartupError === true
  const args = stringList(request.args)
  const env = stringMap(request.env)
  const headers = stringMap(request.headers)
  const command = text(request.command)
  const cwd = text(request.cwd)
  const url = text(request.url)
  const id = text(request.id)
  return {
    ...(id === undefined ? {} : { id }),
    serverName,
    transport,
    ...(command === undefined ? {} : { command }),
    ...(args === undefined ? {} : { args }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(env === undefined ? {} : { env }),
    ...(url === undefined ? {} : { url }),
    ...(headers === undefined ? {} : { headers }),
    failOnStartupError,
    enabled,
  }
}

/**
 * Pick the Node executable the MCP page should offer, without touching the filesystem when `exists`
 * is supplied (the unit tests rely on that).
 *
 * Order: the runtime bundled with the shell — the one the app itself ships and validated for this
 * platform — then an explicitly configured `DSH_DESKTOP_NODE_EXECUTABLE`. Anything else, including
 * `process.execPath`, would be the GUI-subsystem Electron binary: it cannot run a server as Node.
 */
export function resolveNodeExecutable(input: {
  readonly bundledBinDir?: string | undefined
  readonly environment?: string | undefined
  readonly exists?: (path: string) => boolean
}): { readonly path: string; readonly source: McpNodeSource } {
  const exists = input.exists ?? existsSync
  if (input.bundledBinDir !== undefined && input.bundledBinDir !== '') {
    const bundled = join(input.bundledBinDir, 'node.exe')
    if (exists(bundled)) return { path: bundled, source: 'bundled' }
  }
  const environment = input.environment === undefined ? '' : input.environment.trim()
  if (environment !== '' && exists(environment)) return { path: environment, source: 'environment' }
  return { path: '', source: 'missing' }
}

/**
 * Normalize a stdio server's command before it is written.
 *
 * An empty command (or a bare `node` / `node.exe`) means "use the Node the shell shipped". Leaving
 * it alone made DSH spawn whatever `node` PATH happened to resolve — the hand-written path users
 * complained about. A real command (absolute path, another launcher) is never rewritten.
 */
export function resolveStdioCommand(input: McpServerInput, nodePath?: string): McpServerInput {
  if (input.transport !== 'stdio') return input
  const detected = nodePath === undefined ? '' : nodePath.trim()
  if (detected === '') return input
  const current = input.command === undefined ? '' : input.command.trim()
  if (current === '' || /^(?:node|node\.exe)$/iu.test(current)) return { ...input, command: detected }
  return input
}

export class McpWindow {
  private window: BrowserWindow | undefined
  /**
   * Explicit field rather than a constructor parameter property: `node --test` strips TypeScript and
   * cannot compile parameter properties, and the pure helpers above are unit-tested through this
   * module (the electron import is stubbed by the test's module hook).
   */
  private readonly options: McpWindowOptions
  /** Last check per server id, and the check currently in flight (a double click shares one run). */
  private readonly probeResults = new Map<string, McpProbeResult>()
  private readonly probeInFlight = new Map<string, Promise<McpProbeResult>>()
  /** Bumped when a save/remove invalidates an id, so a check that resolves later cannot repopulate. */
  private readonly probeEpoch = new Map<string, number>()

  constructor(options: McpWindowOptions) {
    this.options = options
  }

  private async runProbe(server: McpServer): Promise<McpProbeResult> {
    const running = this.probeInFlight.get(server.id)
    if (running !== undefined) return running
    const epoch = this.probeEpoch.get(server.id) ?? 0
    const started = (async (): Promise<McpProbeResult> => {
      let result: McpProbeResult
      try {
        result = await (this.options.probe ?? probeMcpServer)(server)
      } catch (error) {
        // The probe contract is "never throw"; an injected probe that does still must not break IPC.
        result = {
          ok: false,
          transport: server.transport,
          error: error instanceof Error ? error.message : String(error),
          durationMs: 0,
          checkedAt: Date.now(),
        }
      }
      if ((this.probeEpoch.get(server.id) ?? 0) === epoch) this.probeResults.set(server.id, result)
      return result
    })()
    this.probeInFlight.set(server.id, started)
    try {
      return await started
    } finally {
      if (this.probeInFlight.get(server.id) === started) this.probeInFlight.delete(server.id)
    }
  }

  /** A changed or removed server's old verdict no longer describes it; an in-flight check is orphaned. */
  private clearProbe(id: string): void {
    this.probeResults.delete(id)
    this.probeInFlight.delete(id)
    this.probeEpoch.set(id, (this.probeEpoch.get(id) ?? 0) + 1)
  }

  /** The list the page renders: each configured server plus its last check, when there is one. */
  private serversWithProbe(): Array<McpServer & { readonly probe?: McpProbeResult }> {
    return this.options.store.listMcpServers().map((server) => {
      const probe = this.probeResults.get(server.id)
      return probe === undefined ? server : { ...server, probe }
    })
  }

  /** Parse pasted text against the live server list so previews can flag name conflicts. */
  private parseImportText(text: unknown): McpImportResult {
    if (typeof text !== 'string') return { format: 'unknown', entries: [], errors: ['导入内容必须是文本。'], warnings: [] }
    if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_TEXT_BYTES) {
      return { format: 'unknown', entries: [], errors: ['导入内容超过 2 MB，请缩小配置后重试。'], warnings: [] }
    }
    const existing = this.options.store.listMcpServers().map((server) => ({ id: server.id, serverName: server.serverName }))
    return parseMcpImport(text, existing)
  }

  /**
   * Write a preview selection.
   *
   * Every item is re-validated here (the renderer is not trusted) and goes through the same
   * `resolveStdioCommand` normalization as the normal save path. A name conflict is skipped unless
   * the item explicitly asks to overwrite, in which case the existing row id is reused.
   */
  private applyImport(items: unknown): McpImportApplyResult {
    try {
      if (!Array.isArray(items)) return { ok: false, imported: 0, skipped: 0, failed: [{ name: '', reason: '导入列表格式无效。' }] }
      if (items.length === 0) return { ok: false, imported: 0, skipped: 0, failed: [{ name: '', reason: '没有选中要导入的服务。' }] }
      if (items.length > MAX_IMPORT_ENTRIES) {
        return {
          ok: false,
          imported: 0,
          skipped: 0,
          failed: [{ name: '', reason: `一次最多导入 ${String(MAX_IMPORT_ENTRIES)} 条。` }],
        }
      }
      let imported = 0
      let skipped = 0
      const failed: Array<{ readonly name: string; readonly reason: string }> = []
      const invalidated = new Set<string>()
      for (const item of items) {
        const record = isRecord(item) ? item : {}
        const overwrite = record['overwrite'] === true
        const parsed = parseMcpInput(record['input'])
        if ('reason' in parsed) {
          failed.push({ name: importNameOf(record['input']), reason: parsed.reason })
          continue
        }
        const input = resolveStdioCommand(parsed, this.options.nodeExecutable)
        // Looked up per item: an earlier item in the same batch may have created this name, and a
        // stale snapshot would then write a duplicate instead of updating it.
        const conflicting = this.options.store.listMcpServers().find((server) => server.serverName === input.serverName)
        if (conflicting !== undefined && !overwrite) {
          skipped += 1
          continue
        }
        const write: McpServerInput = conflicting === undefined ? input : { ...input, id: conflicting.id }
        const saved = this.options.store.saveMcpServer(write)
        if (!saved.ok) {
          failed.push({ name: input.serverName, reason: saved.reason ?? '保存失败。' })
          continue
        }
        imported += 1
        if (conflicting !== undefined) invalidated.add(conflicting.id)
      }
      for (const id of invalidated) this.clearProbe(id)
      return { ok: true, imported, skipped, failed }
    } catch (error) {
      return {
        ok: false,
        imported: 0,
        skipped: 0,
        failed: [{ name: '', reason: `导入失败：${error instanceof Error ? error.message : String(error)}` }],
      }
    }
  }

  private create(): BrowserWindow {
    const window = new BrowserWindow({
      width: 900,
      height: 720,
      minWidth: 720,
      minHeight: 520,
      resizable: true,
      minimizable: true,
      maximizable: true,
      fullscreenable: false,
      center: true,
      show: false,
      title: 'MCP 与 Skills · DSH Desktop',
      backgroundColor: '#ffffff',
      webPreferences: {
        preload: join(this.options.appRoot, 'dist', 'preload.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        devTools: true,
      },
    })
    window.setMenuBarVisibility(false)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    void window.loadFile(join(this.options.appRoot, 'dist', 'mcp', 'index.html'))
    window.on('closed', () => { this.window = undefined })
    return window
  }

  open(): void {
    const existing = this.window
    const created = existing === undefined || existing.isDestroyed()
    const window = created ? this.create() : existing
    this.window = window
    if (!created) void window.webContents.reload()
    window.show()
    window.focus()
  }

  close(): void {
    if (this.window !== undefined && !this.window.isDestroyed()) this.window.close()
  }

  isOpen(): boolean {
    return this.window !== undefined && !this.window.isDestroyed()
  }

  async evaluate<T>(expression: string): Promise<T | undefined> {
    const window = this.window
    if (window === undefined || window.isDestroyed()) return undefined
    return await window.webContents.executeJavaScript(expression) as T
  }

  /** Load report for the menu smoke: painted, bridge present, and the tab controls exist. */
  async probe(timeoutMs = 8_000): Promise<{ readonly loaded: boolean; readonly bridge: boolean; readonly selectors: Record<string, boolean> }> {
    const window = this.window
    if (window === undefined || window.isDestroyed()) return { loaded: false, bridge: false, selectors: {} }
    const contents = window.webContents
    const loaded = contents.isLoading()
      ? await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => { resolve(false) }, timeoutMs)
        contents.once('did-finish-load', () => { clearTimeout(timer); resolve(true) })
        contents.once('did-fail-load', () => { clearTimeout(timer); resolve(false) })
      })
      : true
    if (!loaded) return { loaded: false, bridge: false, selectors: {} }
    try {
      const result = await contents.executeJavaScript(
        `(() => { const ids = ${JSON.stringify(['statusBar', 'tabMcp', 'tabSkills', 'serverList', 'skillList', 'restartButton', 'closeButton'])};`
        + ' const out = { selectors: {}, bridge: typeof window.__DSH_MCP__ === "object" && window.__DSH_MCP__ !== null };'
        + ' for (const id of ids) out.selectors[id] = document.getElementById(id) !== null; return out })()',
      ) as { readonly selectors: Record<string, boolean>; readonly bridge: boolean }
      return { loaded: true, bridge: result.bridge, selectors: result.selectors }
    } catch {
      return { loaded: true, bridge: false, selectors: {} }
    }
  }

  install(): void {
    const owned = (url: string): boolean => {
      if (!this.options.isShellDocument(url)) return false
      return SHELL_PAGE_DOCUMENTS.some((document) => url.includes(document)) && url.includes(MCP_PAGE)
    }
    const guard = (event: Electron.IpcMainInvokeEvent): void => {
      if (!owned(event.senderFrame?.url ?? '')) {
        throw new Error('dsh desktop: rejected mcp IPC from an unowned renderer')
      }
    }
    const store = this.options.store

    ipcMain.handle(IPC.mcpList, (event) => {
      guard(event)
      return { patchPath: store.patchPath, skillsRoot: store.skillsRoot, servers: this.serversWithProbe() }
    })
    ipcMain.handle(IPC.mcpSaveServer, (event, input: unknown) => {
      guard(event)
      const parsed = parseMcpInput(input)
      if ('reason' in parsed) return { ok: false, reason: parsed.reason }
      // Backend fallback for the page's prefill: another caller (or an older page) may still hand us
      // an empty / bare `node` command, and DSH would then spawn whatever PATH resolves.
      const saved = store.saveMcpServer(resolveStdioCommand(parsed, this.options.nodeExecutable))
      // The old verdict described the old configuration. A newly created row has no cached verdict
      // (the store does not return its generated id), so only updates need clearing.
      if (saved.ok && parsed.id !== undefined) this.clearProbe(parsed.id)
      return saved
    })
    ipcMain.handle(IPC.mcpImportParse, (event, text: unknown) => {
      guard(event)
      return this.parseImportText(text)
    })
    ipcMain.handle(IPC.mcpImportPick, async (event) => {
      guard(event)
      try {
        const owner = BrowserWindow.fromWebContents(event.sender)
        const options: Electron.OpenDialogOptions = {
          title: '选择 MCP 配置文件',
          properties: ['openFile'],
          filters: [
            // JSON with comments (`.jsonc`) is not parsed: the parser is standard JSON, and offering
            // the extension would only turn a supported-looking file into a parse error.
            { name: 'MCP 配置（.toml / .json / .txt）', extensions: ['toml', 'json', 'txt'] },
            { name: '所有文件', extensions: ['*'] },
          ],
        }
        const picked = owner === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(owner, options)
        const file = picked.filePaths[0]
        if (picked.canceled || file === undefined) return { ok: false, reason: '已取消。' } satisfies McpImportPickResult
        const info = await stat(file)
        if (info.size > MAX_IMPORT_FILE_BYTES) {
          const megabytes = (info.size / 1024 / 1024).toFixed(1)
          return { ok: false, reason: `文件过大（${megabytes} MB），请选择小于 2 MB 的配置文件。` } satisfies McpImportPickResult
        }
        const text = await readFile(file, 'utf8')
        if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_FILE_BYTES) {
          return { ok: false, reason: '文件超过 2 MB，请缩小配置后重试。' } satisfies McpImportPickResult
        }
        return { ok: true, fileName: basename(file), text } satisfies McpImportPickResult
      } catch (error) {
        return { ok: false, reason: `读取文件失败：${error instanceof Error ? error.message : String(error)}` } satisfies McpImportPickResult
      }
    })
    ipcMain.handle(IPC.mcpImportApply, (event, items: unknown) => {
      guard(event)
      return this.applyImport(items)
    })
    ipcMain.handle(IPC.mcpRemoveServer, (event, id: unknown) => {
      guard(event)
      if (typeof id !== 'string') return { ok: false, reason: '记录 id 无效。' }
      const removed = store.removeMcpServer(id)
      if (removed.ok) this.clearProbe(id)
      return removed
    })
    ipcMain.handle(IPC.mcpSetEnabled, (event, id: unknown, enabled: unknown) => {
      guard(event)
      // Deliberately does not clear the probe cache: pausing a row does not change whether the server
      // would connect, and the user can still check a disabled server.
      return typeof id === 'string' ? store.setMcpEnabled(id, enabled === true) : { ok: false, reason: '记录 id 无效。' }
    })
    ipcMain.handle(IPC.mcpCheck, async (event, id: unknown) => {
      guard(event)
      const server = typeof id === 'string' ? store.listMcpServers().find((entry) => entry.id === id) : undefined
      if (server === undefined) return { ok: false, error: '找不到这个 MCP 服务' }
      // Probe-only normalization: an empty / bare `node` command means "the shell's Node", exactly
      // like the save path, but a check must never rewrite the stored configuration.
      const target: McpServer = { ...server, ...resolveStdioCommand(server, this.options.nodeExecutable) }
      return this.runProbe(target)
    })
    ipcMain.handle(IPC.mcpNode, (event) => {
      guard(event)
      const path = this.options.nodeExecutable === undefined ? '' : this.options.nodeExecutable
      const info: McpNodeInfo = {
        path,
        source: path === '' ? 'missing' : (this.options.nodeSource ?? 'bundled'),
        // Re-checked at call time: the window may outlive a runtime directory that was moved.
        exists: path !== '' && existsSync(path),
      }
      return info
    })
    ipcMain.handle(IPC.mcpSkills, (event) => {
      guard(event)
      return { skillsRoot: store.skillsRoot, items: store.listSkills() }
    })
    ipcMain.handle(IPC.mcpAddSkill, async (event) => {
      guard(event)
      const owner = BrowserWindow.fromWebContents(event.sender)
      const options: Electron.OpenDialogOptions = {
        title: '选择包含 SKILL.md 的目录',
        properties: ['openDirectory'],
      }
      const result = owner === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(owner, options)
      const directory = result.filePaths[0]
      if (result.canceled || directory === undefined) return { ok: false, reason: '已取消。' }
      return store.addSkillLink(directory)
    })
    ipcMain.handle(IPC.mcpRemoveSkill, (event, name: unknown) => {
      guard(event)
      return typeof name === 'string' ? store.removeSkillLink(name) : { ok: false, reason: 'Skill 名称无效。' }
    })
    ipcMain.handle(IPC.mcpRestart, (event) => {
      guard(event)
      this.options.restart()
      return { ok: true }
    })
    ipcMain.handle(IPC.mcpClose, (event) => {
      guard(event)
      // Deferred: closing the sender inline would destroy the renderer before the invoke reply.
      const requesting = BrowserWindow.fromWebContents(event.sender)
      setImmediate(() => {
        if (requesting !== null && !requesting.isDestroyed()) requesting.close()
      })
      return true
    })
  }
}
