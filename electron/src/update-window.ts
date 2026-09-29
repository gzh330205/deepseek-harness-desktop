/**
 * The update window: a small always-centred shell-owned document.
 *
 * It is the only UI that can start a download or an install, and it renders state the
 * main process owns. The page itself can do nothing but ask.
 */

import { BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'

import { IPC, PRODUCT_NAME, type UpdateAction, type UpdateState } from './constants.ts'

export interface UpdateWindowOptions {
  readonly appRoot: string
  readonly state: () => UpdateState
  readonly onAction: (action: UpdateAction) => void
  readonly isShellDocument: (url: string) => boolean
}

export class UpdateWindow {
  private window: BrowserWindow | undefined

  constructor(private readonly options: UpdateWindowOptions) {}

  private create(): BrowserWindow {
    const window = new BrowserWindow({
      width: 440,
      height: 300,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      center: true,
      show: false,
      title: `${PRODUCT_NAME} 更新`,
      backgroundColor: '#141821',
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
    void window.loadFile(join(this.options.appRoot, 'dist', 'update', 'index.html'))
    window.once('ready-to-show', () => {
      window.webContents.send(IPC.updateStatus, this.options.state())
    })
    window.on('closed', () => { this.window = undefined })
    return window
  }

  /** Show the window, creating it on first use. */
  open(): void {
    const existing = this.window
    const window = existing === undefined || existing.isDestroyed() ? this.create() : existing
    this.window = window
    window.show()
    window.focus()
  }

  close(): void {
    if (this.window !== undefined && !this.window.isDestroyed()) this.window.close()
  }

  publish(state: UpdateState): void {
    if (this.window === undefined || this.window.isDestroyed()) return
    this.window.webContents.send(IPC.updateStatus, state)
  }

  /** Register the IPC handlers this window's preload uses. */
  install(): void {
    ipcMain.handle(IPC.updateSubscribe, (event) => {
      if (!this.options.isShellDocument(event.senderFrame?.url ?? '')) {
        throw new Error('dsh desktop: rejected update IPC from an unowned renderer')
      }
      return this.options.state()
    })
    ipcMain.handle(IPC.updateAction, (event, action: unknown) => {
      if (!this.options.isShellDocument(event.senderFrame?.url ?? '')) {
        throw new Error('dsh desktop: rejected update IPC from an unowned renderer')
      }
      if (action !== 'check' && action !== 'download' && action !== 'install' && action !== 'dismiss') {
        throw new Error('dsh desktop: unknown update action')
      }
      this.options.onAction(action)
      return this.options.state()
    })
  }
}
