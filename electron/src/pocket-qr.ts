/**
 * The QR code the phone scans.
 *
 * The code is rendered here rather than in the page for one reason: the settings page builds its DOM
 * with `createElement` and never touches `innerHTML`, and it should stay that way. A PNG data URL
 * goes into an `<img>` (the page's CSP already allows `data:` images), so nothing markup-shaped ever
 * crosses that boundary.
 *
 * Error correction level M is chosen deliberately: a phone camera at an angle on a screen with a
 * reflection still decodes, and the code stays small enough to sit in a settings panel.
 */

import qrcode from 'qrcode-generator'

/** Pixels per module and quiet zone (in modules) of the generated PNG. */
const DEFAULT_CELL_SIZE = 6
const DEFAULT_MARGIN = 2

export interface PocketQrOptions {
  readonly cellSize?: number
  readonly margin?: number
}

/**
 * Build the module matrix for a payload.
 *
 * Exported so tests can decode exactly what the settings page would display, instead of trusting the
 * library's own output.
 *
 * @param url - Address the phone should open.
 * @returns Module count and a darkness lookup.
 */
export function pocketQrMatrix(url: string): { readonly count: number; readonly dark: (row: number, column: number) => boolean } {
  const code = qrcode(0, 'M')
  code.addData(url)
  code.make()
  const count = code.getModuleCount()
  return { count, dark: (row, column) => code.isDark(row, column) }
}

/**
 * Render the code as a PNG data URL.
 *
 * @param url - Address the phone should open.
 * @param options - Cell size and quiet zone.
 * @returns A `data:image/gif;base64,…` URL, ready for an `<img>`.
 */
export function pocketQrDataUrl(url: string, options: PocketQrOptions = {}): string {
  const code = qrcode(0, 'M')
  code.addData(url)
  code.make()
  return code.createDataURL(options.cellSize ?? DEFAULT_CELL_SIZE, options.margin ?? DEFAULT_MARGIN)
}
