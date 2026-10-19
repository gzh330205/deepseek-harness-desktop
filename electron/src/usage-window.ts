/**
 * The token-usage window (ONE-WAY).
 *
 * A shell window rather than a DSH page plugin: the gateway session cookie, the HTML scraping and
 * the QR login live in this process, so the page only ever receives snapshots over IPC. That is the
 * same split as phone access, and it is why the page has no network access of its own.
 *
 * The IPC handlers are installed once, by this class, and validate that the sender is the usage
 * page — the same sender check the settings/pocket bridge uses. `close` closes the requesting
 * window rather than a singleton (a lesson from the pocket window's dead 关闭 button).
 */

import { BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'

import { IPC, SHELL_PAGE_DOCUMENTS } from './constants.ts'

/** What the window class needs from the main process; all of it is transport. */
export interface UsageWindowHandlers {
  readonly get: () => Promise<unknown>
  readonly refresh: () => Promise<unknown>
  readonly settings: () => unknown
  readonly saveSettings: (input: unknown) => unknown
  readonly loginStart: () => Promise<unknown>
  readonly loginPoll: (key: unknown) => Promise<unknown>
  readonly logout: () => Promise<unknown>
  readonly requests: (query: unknown) => Promise<unknown>
  /**
   * One request's detail. Rejects with a displayable message, which the page catches into the
   * modal's error state — unlike `requests`, there is no degraded "empty" version to return.
   */
  readonly requestDetail: (id: unknown) => Promise<unknown>
}

export interface UsageWindowOptions {
  readonly appRoot: string
  readonly handlers: UsageWindowHandlers
  /** Same predicate the shell uses for its own documents (`isLauncherSender`). */
  readonly isShellDocument: (url: string) => boolean
}

const USAGE_PAGE = '/usage/index.html'

export class UsageWindow {
  private window: BrowserWindow | undefined

  constructor(private readonly options: UsageWindowOptions) {}

  private create(): BrowserWindow {
    const window = new BrowserWindow({
      width: 960,
      height: 780,
      minWidth: 720,
      minHeight: 560,
      resizable: true,
      minimizable: true,
      maximizable: true,
      fullscreenable: false,
      center: true,
      show: false,
      title: 'Token 用量 · ONE-WAY',
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
    void window.loadFile(join(this.options.appRoot, 'dist', 'usage', 'index.html'))
    window.on('closed', () => { this.window = undefined })
    return window
  }

  /** Show the window, creating it on first use. */
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

  /** Whether a window exists and has not been destroyed. Smoke-only. */
  isOpen(): boolean {
    return this.window !== undefined && !this.window.isDestroyed()
  }

  /**
   * Run one expression in the page. Smoke-only: it exists so a rehearsal can drive the bridge the
   * way a click does instead of only checking that the page painted.
   */
  async evaluate<T>(expression: string): Promise<T | undefined> {
    const window = this.window
    if (window === undefined || window.isDestroyed()) return undefined
    return await window.webContents.executeJavaScript(expression) as T
  }

  /**
   * Wait for the page to load, then report whether it painted and whether the usage bridge ran.
   * A page whose preload never loaded still paints, so both are checked separately.
   */
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
        `(() => { const ids = ${JSON.stringify(['statusBar', 'metricH5', 'barH5', 'loginBtn', 'tabLogs', 'tabTrend', 'tabChannels', 'tabModels', 'settingsBox', 'closeBtn'])};`
        + ' const out = { selectors: {}, bridge: typeof window.__DSH_USAGE__ === "object" && window.__DSH_USAGE__ !== null };'
        + ' for (const id of ids) out.selectors[id] = document.getElementById(id) !== null; return out })()',
      ) as { readonly selectors: Record<string, boolean>; readonly bridge: boolean }
      return { loaded: true, bridge: result.bridge, selectors: result.selectors }
    } catch {
      return { loaded: true, bridge: false, selectors: {} }
    }
  }

  /** Register the IPC bridge once. Any shell-owned usage page may use it; the sender is checked. */
  install(): void {
    const owned = (url: string): boolean => {
      if (!this.options.isShellDocument(url)) return false
      return SHELL_PAGE_DOCUMENTS.some((document) => url.includes(document)) && url.includes(USAGE_PAGE)
    }
    const guard = (event: Electron.IpcMainInvokeEvent): void => {
      if (!owned(event.senderFrame?.url ?? '')) {
        throw new Error('dsh desktop: rejected usage IPC from an unowned renderer')
      }
    }
    const handlers = this.options.handlers

    ipcMain.handle(IPC.usageGet, (event) => { guard(event); return handlers.get() })
    ipcMain.handle(IPC.usageRefresh, (event) => { guard(event); return handlers.refresh() })
    ipcMain.handle(IPC.usageSettings, (event) => { guard(event); return handlers.settings() })
    ipcMain.handle(IPC.usageSettingsSave, (event, input: unknown) => { guard(event); return handlers.saveSettings(input) })
    ipcMain.handle(IPC.usageLoginStart, (event) => { guard(event); return handlers.loginStart() })
    ipcMain.handle(IPC.usageLoginPoll, (event, key: unknown) => { guard(event); return handlers.loginPoll(key) })
    ipcMain.handle(IPC.usageLogout, (event) => { guard(event); return handlers.logout() })
    ipcMain.handle(IPC.usageRequests, (event, query: unknown) => { guard(event); return handlers.requests(query) })
    ipcMain.handle(IPC.usageRequestDetail, (event, id: unknown) => { guard(event); return handlers.requestDetail(id) })
    ipcMain.handle(IPC.usageClose, (event) => {
      guard(event)
      // Same deferral as the settings/pocket close: closing the sender inline destroys the renderer
      // before the invoke reply gets back, so the page's `await close()` would never settle.
      const requesting = BrowserWindow.fromWebContents(event.sender)
      setImmediate(() => {
        if (requesting !== null && !requesting.isDestroyed()) requesting.close()
      })
      return true
    })
  }
}
