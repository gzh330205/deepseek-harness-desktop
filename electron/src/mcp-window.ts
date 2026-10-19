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
import { join } from 'node:path'

import { IPC, SHELL_PAGE_DOCUMENTS } from './constants.ts'
import type { DshConfigStore, McpServerInput, McpTransport } from './dsh-config.ts'

/** Where the Node executable offered to MCP stdio servers came from. */
export type McpNodeSource = 'bundled' | 'environment' | 'missing'

/** What the page's `node` bridge method reports: a path plus enough provenance for its hint. */
export interface McpNodeInfo {
  readonly path: string
  readonly source: McpNodeSource
  readonly exists: boolean
}

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

  constructor(options: McpWindowOptions) {
    this.options = options
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
      return { patchPath: store.patchPath, skillsRoot: store.skillsRoot, servers: store.listMcpServers() }
    })
    ipcMain.handle(IPC.mcpSaveServer, (event, input: unknown) => {
      guard(event)
      const parsed = parseMcpInput(input)
      if ('reason' in parsed) return { ok: false, reason: parsed.reason }
      // Backend fallback for the page's prefill: another caller (or an older page) may still hand us
      // an empty / bare `node` command, and DSH would then spawn whatever PATH resolves.
      return store.saveMcpServer(resolveStdioCommand(parsed, this.options.nodeExecutable))
    })
    ipcMain.handle(IPC.mcpRemoveServer, (event, id: unknown) => {
      guard(event)
      return typeof id === 'string' ? store.removeMcpServer(id) : { ok: false, reason: '记录 id 无效。' }
    })
    ipcMain.handle(IPC.mcpSetEnabled, (event, id: unknown, enabled: unknown) => {
      guard(event)
      return typeof id === 'string' ? store.setMcpEnabled(id, enabled === true) : { ok: false, reason: '记录 id 无效。' }
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
