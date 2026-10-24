/**
 * Wires the copy/paste context menu into the shell's own windows.
 *
 * Registered once, before any window exists. The handler checks the sender's
 * URL instead of the window identity: the DSH product window and future
 * non-shell windows must keep Electron's default (no menu).
 */

import { app, BrowserWindow, Menu } from 'electron'

import { copyMenuTemplate, isCopyableShellUrl } from './context-menu.ts'

export function installCopyContextMenus(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('context-menu', (_contextEvent, params) => {
      if (!isCopyableShellUrl(contents.getURL())) return
      const window = BrowserWindow.fromWebContents(contents)
      if (window === null) return
      Menu.buildFromTemplate(copyMenuTemplate(params)).popup({ window })
    })
  })
}
