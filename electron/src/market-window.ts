/**
 * The market window: a shell-owned surface for finding and installing plugins.
 *
 * Why a window of our own instead of the plugin market that lives inside the DSH page: installing a
 * plugin is what you do when the harness is **not** working, so the surface that does it must not
 * depend on the DSH page rendering. It also lets the install run through the path the shell owns
 * (`bin/node.exe` + `pnpm.cjs`, `cwd` = profile, `shell: false`), whose failures we can classify and
 * show — instead of a single `ENOENT` relayed from someone else's child process.
 *
 * Security posture mirrors the settings window exactly: `sandbox: true`, `contextIsolation: true`,
 * `nodeIntegration: false`, a page that cannot reach the network (`CSP default-src 'none'`), and the
 * main process refuses any message whose sender is not this window's own renderer.
 */

import { BrowserWindow, clipboard, ipcMain } from 'electron'
import { join } from 'node:path'

import { MARKET_IPC, type MarketActionResultResponse, type MarketSearchResponse } from './market-ipc.ts'
import type { MarketService } from './market-service.ts'
import type { MarketAction } from './market-install.ts'

/** How the window is built and where its service comes from. */
export interface MarketWindowOptions {
  /** Directory holding `dist/` (the built shell). */
  readonly appRoot: string
  /** The market operations, already bound to a profile and a runtime. */
  readonly service: MarketService
  /** Log sink, so window-level refusals end up in `shell.log` like every other shell decision. */
  readonly log: (line: string) => void
}

/**
 * Owns one market window and the IPC that only it may use.
 *
 * `open()` is idempotent: a second call focuses the existing window rather than stacking another one
 * (the menu item is a normal thing to click twice).
 */
export class MarketWindow {
  readonly #options: MarketWindowOptions
  #window: BrowserWindow | undefined
  #registered = false

  constructor(options: MarketWindowOptions) {
    this.#options = options
  }

  /** Show the window, creating it on first use. */
  open(): void {
    this.#register()
    const existing = this.#window
    if (existing !== undefined && !existing.isDestroyed()) {
      existing.show()
      existing.focus()
      return
    }
    const window = this.#create()
    this.#window = window
    window.on('closed', () => { this.#window = undefined })
  }

  /** Close the window if it exists. */
  close(): void {
    const window = this.#window
    if (window !== undefined && !window.isDestroyed()) window.close()
  }

  #create(): BrowserWindow {
    const window = new BrowserWindow({
      width: 760,
      height: 680,
      minWidth: 620,
      minHeight: 480,
      title: 'DSH Desktop 插件市场',
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#0f1115',
      webPreferences: {
        preload: join(this.#options.appRoot, 'dist', 'preload.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    })
    window.setMenuBarVisibility(false)
    window.once('ready-to-show', () => { window.show() })
    void window.loadFile(join(this.#options.appRoot, 'dist', 'market', 'index.html'))
    return window
  }

  /** True when the message came from this window's own top-level frame. */
  #owned(event: { readonly sender: unknown; readonly senderFrame?: { readonly url?: string } | null }): boolean {
    const window = this.#window
    if (window === undefined || window.isDestroyed()) return false
    if (event.sender !== window.webContents) return false
    const url = event.senderFrame?.url ?? ''
    return url === '' || url.startsWith('file://')
  }

  /** Register the handlers once; every one of them validates the sender first. */
  #register(): void {
    if (this.#registered) return
    this.#registered = true
    const { service, log } = this.#options

    const guard = <T>(event: { readonly sender: unknown; readonly senderFrame?: { readonly url?: string } | null }, run: () => T): T => {
      if (!this.#owned(event)) {
        log('插件市场：拒绝了一条不属于该窗口的 IPC 请求')
        throw new Error('dsh desktop: rejected market IPC from an unowned renderer')
      }
      return run()
    }

    ipcMain.handle(MARKET_IPC.search, (event, query: unknown): Promise<MarketSearchResponse> | MarketSearchResponse =>
      guard(event, async () => {
        const text = typeof query === 'string' ? query : ''
        try {
          const result = await service.search(text)
          return { ok: true, packages: result.packages, skipped: result.skipped }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          log(`插件市场：查询失败 ${message}`)
          return { ok: false, packages: [], skipped: [], output: message, failure: { kind: 'network', message: 'registry 查询失败', hint: message } }
        }
      }))

    ipcMain.handle(MARKET_IPC.installed, (event) =>
      guard(event, () => ({ items: service.installed() })))

    ipcMain.handle(MARKET_IPC.act, (event, action: unknown, name: unknown, version: unknown): Promise<MarketActionResultResponse> | MarketActionResultResponse =>
      guard(event, async () => {
        if (action !== 'install' && action !== 'update' && action !== 'uninstall') {
          return { ok: false, action: 'install', name: '', spec: '', code: null, output: '未知操作', failure: { kind: 'unknown', message: '未知操作' }, bundleRegistered: false }
        }
        if (typeof name !== 'string' || name === '') {
          return { ok: false, action, name: '', spec: '', code: null, output: '缺少插件名', failure: { kind: 'unknown', message: '缺少插件名' }, bundleRegistered: false }
        }
        const wanted = typeof version === 'string' && version !== '' ? version : undefined
        // Install and update are the same pnpm call with a different label; only the wording and the
        // default (the catalog's version) differ, so the window may pass either.
        if (action === 'uninstall') return await service.uninstall(name)
        if (action === 'update') return await service.update(name, wanted ?? '')
        return await service.install(name, wanted ?? '')
      }))

    ipcMain.handle(MARKET_IPC.profileDir, (event) => guard(event, () => service.profileDir))

    ipcMain.handle(MARKET_IPC.copyDiagnostics, (event, text: unknown) =>
      guard(event, () => {
        const value = typeof text === 'string' ? text : ''
        clipboard.writeText(value)
        return { ok: true }
      }))

    ipcMain.handle(MARKET_IPC.close, (event) => guard(event, () => {
      this.close()
      return true
    }))
  }
}
