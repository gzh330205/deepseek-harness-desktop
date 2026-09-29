/**
 * Windows tray icon. Ported from the Tauri shell: hover text is the product name,
 * a click shows and focuses the window, and the context menu offers show/about/quit.
 */

import { Menu, Tray, nativeImage } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'


/** The whale icon shipped with the repository; packaged builds get a copy beside resources. */
export function resolveIconPath(): string | undefined {
  // The .ico first: it carries 16/24/32/48/64/256 variants, so Windows picks a real
  // 16 px image for the notification area. A 512 px PNG scaled down there looks soft.
  const candidates = [
    join(process.resourcesPath, 'tray.ico'),
    join(process.resourcesPath, 'icon.png'),
    join(process.resourcesPath, '..', 'src-tauri', 'icons', 'icon.ico'),
    join(process.resourcesPath, '..', 'src-tauri', 'icons', 'whale-original.png'),
    join(process.cwd(), '..', 'src-tauri', 'icons', 'whale-original.png'),
  ]
  return candidates.find(candidate => existsSync(candidate))
}

export interface TrayActions {
  readonly show: () => void
  readonly about: () => void
  readonly quit: () => void
}

export function createTray(actions: TrayActions, productName: string): Tray | undefined {
  const iconPath = resolveIconPath()
  if (iconPath === undefined) return undefined
  const image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) return undefined
  const tray = new Tray(image)
  tray.setToolTip(productName)
  // Keep it short: the tooltip already names the product, so repeating it in every item
  // just makes the menu wider than it needs to be.
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开', click: () => { actions.show() } },
    { label: '关于', click: () => { actions.about() } },
    { type: 'separator' },
    { label: '退出', click: () => { actions.quit() } },
  ]))
  tray.on('click', () => { actions.show() })
  return tray
}
