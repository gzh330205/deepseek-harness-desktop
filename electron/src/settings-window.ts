/**
 * The shell's own settings window.
 *
 * These settings used to live only in a DSH settings page, rendered by a panel plugin that
 * wrote `shell-settings.json` itself and then told the shell to re-read it. But every one of
 * them is about the *shell* — the port it binds, how its window closes, the proxy it exports
 * to the dsh child, whether it checks for updates — so the shell owns them directly now: no
 * DSH page, no plugin, no bridge round trip.
 *
 * The page can do nothing but read a snapshot and submit values; the main process validates
 * and writes.
 */

import { BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { join } from 'node:path'

import {
  IPC,
  PRODUCT_NAME,
  SETTINGS_WINDOW_HEIGHT,
  SETTINGS_WINDOW_WIDTH,
  SHELL_PAGE_DOCUMENTS,
  titleBarPalette,
} from './constants.ts'
import { parsePocketAction, type PocketAction, type PocketSnapshot } from './pocket-action.ts'
import type { SettingsInput } from './settings-shape.ts'

// The phone-access vocabulary lives in `pocket-action.ts` (no Electron import, so the bridge can be
// unit-tested); it is re-exported here for the main process, which already imports from this module.
export type { PocketAction, PocketSnapshot } from './pocket-action.ts'

/** What the settings page renders. */
export interface SettingsSnapshot {
  readonly values: {
    readonly servicePort: number
    readonly closeBehavior: 'minimizeToTray' | 'exit'
    readonly proxyEnabled: boolean
    readonly httpProxy: string
    readonly httpsProxy: string
    readonly noProxy: string
    readonly checkDesktopOnStart: boolean
    readonly checkDshOnStart: boolean
    readonly browserEnabled: boolean
    readonly pocketEnabled: boolean
    readonly pocketPort: number
    readonly pocketTunnelEnabled: boolean
    readonly pocketTunnelPort: number
    readonly pocketTunnelMode: 'quick' | 'named'
    readonly pocketTunnelDomain: string
  }
  /** Live phone-access state; `values` above is what the document says, this is what is running. */
  readonly pocket: PocketSnapshot
  readonly facts: {
    readonly desktopVersion: string
    readonly dshVersion: string | null
    readonly runtimeVersion: string
    readonly runtimeSource: string
    readonly effectivePort: number | null
    readonly profileName: string
    readonly settingsPath: string
    readonly defaultPort: number
  }
}

export interface SettingsSaveResult {
  readonly ok: boolean
  readonly reason?: string
  readonly changed?: readonly string[]
  /** Port and proxy are inputs to the dsh child, so they only take effect on a restart. */
  readonly restartRequired?: boolean
}

/*
 * All shell-owned pages live in `SHELL_PAGE_DOCUMENTS` (constants.ts), shared with the preload: a page
 * the shell loads is allowed to talk to the shell, anything else is not. (This class is older than the
 * second page — it is really "a window showing a page the shell owns".)
 */

export interface SettingsWindowOptions {
  readonly appRoot: string
  /** Which shell page this window shows, and what to call it. Settings when omitted. */
  readonly page?: { readonly directory: string; readonly title: string; readonly width: number; readonly height: number }
  readonly snapshot: () => SettingsSnapshot
  readonly save: (input: SettingsInput) => SettingsSaveResult
  readonly restart: () => void
  readonly pocket: (action: PocketAction) => PocketSnapshot | Promise<PocketSnapshot>
  readonly isShellDocument: (url: string) => boolean
}

export class SettingsWindow {
  private window: BrowserWindow | undefined

  constructor(private readonly options: SettingsWindowOptions) {}

  private create(): BrowserWindow {
    const palette = titleBarPalette(nativeTheme.shouldUseDarkColors)
    const page = this.options.page
      ?? { directory: 'settings', title: `${PRODUCT_NAME} 设置`, width: SETTINGS_WINDOW_WIDTH, height: SETTINGS_WINDOW_HEIGHT }
    const window = new BrowserWindow({
      width: page.width,
      height: page.height,
      minWidth: page.width,
      minHeight: Math.min(560, page.height),
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      center: true,
      show: false,
      title: page.title,
      backgroundColor: palette.background,
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
    void window.loadFile(join(this.options.appRoot, 'dist', page.directory, 'index.html'))
    window.on('closed', () => { this.window = undefined })
    return window
  }

  /** Show the window, creating it on first use. */
  open(): void {
    const existing = this.window
    const created = existing === undefined || existing.isDestroyed()
    const window = created ? this.create() : existing
    this.window = window
    // A re-open shows current values; a freshly created window is already loading the page.
    if (!created) void window.webContents.reload()
    window.show()
    window.focus()
  }

  close(): void {
    if (this.window !== undefined && !this.window.isDestroyed()) this.window.close()
  }

  /**
   * Wait until the page has loaded, then report what is on it.
   *
   * Used by the smoke run: a window whose page never painted (wrong path, CSP that blocks its own
   * script, a preload that threw) looks exactly like a window that works until someone clicks it.
   *
   * @param timeoutMs - How long to wait.
   * @returns Whether the document finished and which of the given selectors exist.
   */
  async probe(timeoutMs = 8_000): Promise<{ readonly loaded: boolean; readonly selectors: Record<string, boolean>; readonly bridge: boolean }> {
    const window = this.window
    if (window === undefined || window.isDestroyed()) return { loaded: false, selectors: {}, bridge: false }
    const contents = window.webContents
    const loaded = contents.isLoading()
      ? await new Promise<boolean>(resolve => {
          const timer = setTimeout(() => { resolve(false) }, timeoutMs)
          contents.once('did-finish-load', () => { clearTimeout(timer); resolve(true) })
          contents.once('did-fail-load', () => { clearTimeout(timer); resolve(false) })
        })
      : true
    if (!loaded) return { loaded: false, selectors: {}, bridge: false }
    try {
      // `bridge` is checked separately from the elements: a page whose preload never ran still paints
      // its markup, so every control would be dead while the window looked perfectly healthy.
      const result = await contents.executeJavaScript(
        `(() => { const ids = ${JSON.stringify(['status', 'lanQr', 'wanState', 'apkToggle', 'lanEnabled'])};`
        + ' const out = { selectors: {}, bridge: typeof window.__DSH_SETTINGS__ === "object" && window.__DSH_SETTINGS__ !== null };'
        + ' for (const id of ids) out.selectors[id] = document.getElementById(id) !== null; return out })()',
      ) as { readonly selectors: Record<string, boolean>; readonly bridge: boolean }
      return { loaded: true, selectors: result.selectors, bridge: result.bridge }
    } catch {
      return { loaded: true, selectors: {}, bridge: false }
    }
  }

  /**
   * Run one expression in the window's page. Smoke-only: it exists so a rehearsal can drive the
   * bridge the way a click does instead of only checking that the page painted.
   *
   * @param expression - Source evaluated in the page's main world.
   * @returns The expression's value, or undefined when the window is gone.
   */
  async evaluate<T>(expression: string): Promise<T | undefined> {
    const window = this.window
    if (window === undefined || window.isDestroyed()) return undefined
    return await window.webContents.executeJavaScript(expression) as T
  }

  /** Whether a window exists and has not been destroyed. Smoke-only. */
  isOpen(): boolean {
    return this.window !== undefined && !this.window.isDestroyed()
  }

  install(): void {
    const owned = (url: string): boolean => {
      if (!this.options.isShellDocument(url)) return false
      return SHELL_PAGE_DOCUMENTS.some(document => url.includes(document))
    }

    ipcMain.handle(IPC.settingsGet, (event) => {
      if (!owned(event.senderFrame?.url ?? '')) {
        throw new Error('dsh desktop: rejected settings IPC from an unowned renderer')
      }
      return this.options.snapshot()
    })

    ipcMain.handle(IPC.settingsSave, (event, input: unknown) => {
      if (!owned(event.senderFrame?.url ?? '')) {
        throw new Error('dsh desktop: rejected settings IPC from an unowned renderer')
      }
      if (typeof input !== 'object' || input === null) return { ok: false, reason: '设置内容无效' }
      return this.options.save(input as SettingsInput)
    })

    ipcMain.handle(IPC.settingsClose, (event) => {
      if (!owned(event.senderFrame?.url ?? '')) {
        throw new Error('dsh desktop: rejected settings IPC from an unowned renderer')
      }
      // Close the window that asked, not "the window this instance owns". The handlers are installed
      // once and both shell pages (settings, phone access) share the bridge, so `this.close()` made
      // the phone-access window's 关闭 button close the settings window instead — reported as
      // "右下角的关闭按钮不能关闭弹窗".
      //
      // Deferred by one turn of the loop: closing the sender synchronously destroys the renderer
      // before the invoke reply gets back, so the page's `await api.close()` never settles (the
      // smoke rehearsal hung on exactly this). The user sees the same window close either way.
      const requesting = BrowserWindow.fromWebContents(event.sender)
      setImmediate(() => {
        if (requesting !== null && !requesting.isDestroyed()) requesting.close()
      })
      return true
    })

    ipcMain.handle(IPC.pocketAction, (event, action: unknown) => {
      if (!owned(event.senderFrame?.url ?? '')) {
        throw new Error('dsh desktop: rejected settings IPC from an unowned renderer')
      }
      // Pass the action through; `parsePocketAction` is the only validator. This used to be a
      // hand-written whitelist from the LAN-only version, and every action added later (startTunnel,
      // stopTunnel, the firewall pair, the public passwords) fell into a silent `refresh` — the form
      // saved, so 「开启公网访问」 looked like a button that does nothing.
      return this.options.pocket(parsePocketAction(action))
    })

    ipcMain.handle(IPC.settingsRestart, (event) => {
      if (!owned(event.senderFrame?.url ?? '')) {
        throw new Error('dsh desktop: rejected settings IPC from an unowned renderer')
      }
      this.options.restart()
      return true
    })
  }
}
