/**
 * Narrow preload for shell-owned documents (launcher and update windows).
 *
 * This is the Electron answer to `withGlobalTauri: true`: the page gets exactly one
 * frozen object with two subscriptions and nothing else — no ipcRenderer, no Node, no
 * filesystem.
 *
 * The product page (the DSH web app) loads in the main window, so the object is
 * exposed only for shell-owned documents; otherwise the DSH page would inherit the
 * bridge on navigation.
 */

import { contextBridge, ipcRenderer } from 'electron'

import {
  IPC,
  type ShellMenuName,
  PANEL_EMIT_EVENTS,
  PANEL_LISTEN_EVENTS,
  type LauncherStatus,
  type UpdateAction,
  type UpdateState,
} from './constants.ts'

/** `file://` for shell windows, `dsh-app://shell` for shell-owned documents. */
function isShellDocument(): boolean {
  return location.protocol === 'file:' || (location.protocol === 'dsh-app:' && location.hostname === 'shell')
}

/** The DSH web app: loopback HTTP, the only origin that gets the panel bridge. */
function isProductDocument(): boolean {
  return (location.protocol === 'http:' || location.protocol === 'https:')
    && ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)
}

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handle = (_event: Electron.IpcRendererEvent, value: T): void => { listener(value) }
  ipcRenderer.on(channel, handle)
  return () => { ipcRenderer.off(channel, handle) }
}

/**
 * The shell's own title bar. Kept separate from the launcher API: that one drives a status
 * page, this one only opens menus.
 */
function isTitleBarDocument(): boolean {
  return location.protocol === 'file:' && location.pathname.replace(/\\/gu, '/').endsWith('/titlebar/index.html')
}

if (isTitleBarDocument()) {
  contextBridge.exposeInMainWorld('__DSH_TITLEBAR__', Object.freeze({
    state: () => ipcRenderer.invoke(IPC.titlebarState) as Promise<{ productName: string; version: string }>,
    menu: (name: ShellMenuName, anchor: { x: number; y: number; height: number }) =>
      ipcRenderer.invoke(IPC.titlebarMenu, name, anchor) as Promise<boolean>,
  }))
}

/**
 * The shell's own settings window: read a snapshot, submit values, restart. Same discipline
 * as the other shell APIs — one frozen object, no ipcRenderer.
 */
function isSettingsDocument(): boolean {
  return location.protocol === 'file:' && location.pathname.replace(/\\/gu, '/').endsWith('/settings/index.html')
}

if (isSettingsDocument()) {
  contextBridge.exposeInMainWorld('__DSH_SETTINGS__', Object.freeze({
    get: () => ipcRenderer.invoke(IPC.settingsGet) as Promise<unknown>,
    save: (input: unknown) => ipcRenderer.invoke(IPC.settingsSave, input) as Promise<{ ok: boolean; reason?: string; changed?: string[]; restartRequired?: boolean }>,
    close: () => ipcRenderer.invoke(IPC.settingsClose) as Promise<boolean>,
    restart: () => ipcRenderer.invoke(IPC.settingsRestart) as Promise<boolean>,
  }))
}

if (isShellDocument()) {
  contextBridge.exposeInMainWorld('__DSH_SHELL__', Object.freeze({
    launcher: {
      status: (): Promise<LauncherStatus> => ipcRenderer.invoke(IPC.launcherSubscribe) as Promise<LauncherStatus>,
      subscribe: (listener: (status: LauncherStatus) => void): (() => void) => subscribe(IPC.launcherStatus, listener),
      // The status page is also reachable from the menu, so it must not be a dead end.
      enter: (): Promise<boolean> => ipcRenderer.invoke(IPC.launcherEnter) as Promise<boolean>,
    },
    updates: {
      status: (): Promise<UpdateState> => ipcRenderer.invoke(IPC.updateSubscribe) as Promise<UpdateState>,
      subscribe: (listener: (state: UpdateState) => void): (() => void) => subscribe(IPC.updateStatus, listener),
      action: (action: UpdateAction): Promise<UpdateState> =>
        ipcRenderer.invoke(IPC.updateAction, action) as Promise<UpdateState>,
    },
  }))
}

/**
 * The Tauri event bridge the bundled DSH panel plugin already speaks.
 *
 * `dsh-desktop-shell`'s client half (`resources/dsh-desktop-shell/client.js`) notifies
 * the shell through `globalThis.__TAURI__.event.emit('dsh-desktop-shell', {action})`
 * and refreshes on `event.listen('dsh-desktop-state')`; the notification plugin emits its
 * `tauriEventName` (default `dsh-notify`) the same way. Rather than fork that plugin, this shell
 * provides the two methods it uses — and nothing else. There is no `core.invoke`, no path API, no
 * filesystem: a page that can reach this object still cannot ask the shell to do
 * anything beyond the allowlists below.
 */
if (isProductDocument()) {
  const emit = (name: string, payload?: unknown): Promise<void> => {
    if ((PANEL_EMIT_EVENTS as readonly string[]).includes(name)) {
      ipcRenderer.send(IPC.panelEvent, name, payload)
    } else {
      // Telling the shell matters: a plugin whose event name drifted gets no error from `emit`
      // (Tauri resolves), so it believes the shell handled it and never falls back.
      ipcRenderer.send(IPC.panelDropped, typeof name === 'string' ? name : String(name))
    }
    return Promise.resolve()
  }

  const listen = (name: string, handler: (event: { payload: unknown }) => void): Promise<() => void> => {
    if (!(PANEL_LISTEN_EVENTS as readonly string[]).includes(name)) return Promise.resolve(() => {})
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown): void => { handler({ payload }) }
    ipcRenderer.on(IPC.panelState, wrapped)
    return Promise.resolve(() => { ipcRenderer.off(IPC.panelState, wrapped) })
  }

  contextBridge.exposeInMainWorld('__TAURI__', Object.freeze({ event: Object.freeze({ emit, listen }) }))

  /**
   * The sidebar browser's panel bridge.
   *
   * Deliberately one opaque `command` plus two subscriptions: the command names, their
   * payloads and the geometry are validated in the main process (the panel is a renderer,
   * and this bridge can move a native surface). Guests loaded into the browser view get no
   * preload at all, so nothing here is reachable from a visited page — an element pick
   * reaches this bridge only after the main process checked its nonce.
   */
  contextBridge.exposeInMainWorld('__DSH_DESKTOP_BROWSER__', Object.freeze({
    command: (command: unknown): Promise<unknown> => ipcRenderer.invoke(IPC.browserCommand, command),
    subscribe: (listener: (state: unknown) => void): (() => void) => subscribe(IPC.browserState, listener),
    onPick: (listener: (pick: unknown) => void): (() => void) => subscribe(IPC.browserPick, listener),
    onDownloads: (listener: (payload: unknown) => void): (() => void) => subscribe(IPC.browserDownloads, listener),
    /** The shell asks the page to open the browser tab in DSH's right sidebar (client-side op). */
    onOpenPane: (listener: (request: unknown) => void): (() => void) => subscribe(IPC.browserOpenPane, listener),
  }))
}
