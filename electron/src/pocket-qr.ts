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

/** URL scheme the phone client registers for a link that carries a whole connection. */
export const POCKET_CONNECT_SCHEME = 'dshpocket'

export interface PocketQrOptions {
  readonly cellSize?: number
  readonly margin?: number
}

/**
 * Build the `dshpocket://connect?...` link a phone can turn back into a connection.
 *
 * The QR code carries this instead of the bare address so one scan hands over **the address and the
 * password**, rather than making the user read the password off the desktop screen. Both values are
 * `encodeURIComponent`-encoded because everything after `?` is a query string: an IPv6 literal
 * (`[fe80::1]`), a `&` or a `=` would otherwise split the payload the phone decodes.
 *
 * @param url - The gateway address, as the page shows it.
 * @param password - The password for that door; omitted (or empty) links the address alone.
 * @returns The deep link to encode in the QR code.
 */
export function pocketConnectLink(url: string, password?: string): string {
  const query = [`url=${encodeURIComponent(url)}`]
  // An empty password is not a password, and leaving the parameter out keeps the link readable by a
  // client that only knows `url`.
  if (password !== undefined && password !== '') query.push(`password=${encodeURIComponent(password)}`)
  return `${POCKET_CONNECT_SCHEME}://connect?${query.join('&')}`
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
