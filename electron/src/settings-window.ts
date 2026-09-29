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
  titleBarPalette,
} from './constants.ts'
import type { SettingsInput } from './settings-shape.ts'

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
  }
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

export interface SettingsWindowOptions {
  readonly appRoot: string
  readonly snapshot: () => SettingsSnapshot
  readonly save: (input: SettingsInput) => SettingsSaveResult
  readonly restart: () => void
  readonly isShellDocument: (url: string) => boolean
}

export class SettingsWindow {
  private window: BrowserWindow | undefined

  constructor(private readonly options: SettingsWindowOptions) {}

  private create(): BrowserWindow {
    const palette = titleBarPalette(nativeTheme.shouldUseDarkColors)
    const window = new BrowserWindow({
      width: SETTINGS_WINDOW_WIDTH,
      height: SETTINGS_WINDOW_HEIGHT,
      minWidth: SETTINGS_WINDOW_WIDTH,
      minHeight: SETTINGS_WINDOW_HEIGHT,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      center: true,
      show: false,
      title: `${PRODUCT_NAME} 设置`,
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
    void window.loadFile(join(this.options.appRoot, 'dist', 'settings', 'index.html'))
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

  install(): void {
    const owned = (url: string): boolean => {
      if (!this.options.isShellDocument(url)) return false
      return url.includes('/settings/')
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
      this.close()
      return true
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
