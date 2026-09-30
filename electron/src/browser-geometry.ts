/**
 * Geometry and address rules for the shell-owned sidebar browser.
 *
 * The browser is a native `WebContentsView` owned by this process, but it is *placed* by a
 * React panel that lives inside the DSH page (a remote, untrusted-ish renderer). Everything
 * that comes back from that renderer therefore crosses a trust boundary and is parsed here
 * before it can move a native surface: a malformed rect must never be able to place a view
 * outside the window or resize the page's own view.
 *
 * Kept free of Electron imports so it can be unit tested with `node --test`.
 *
 * Adapted from OneCode (`apps/desktop/src/main/browser/BrowserManager.ts`, MIT): the
 * offscreen-parking bounds and the "no scheme means HTTPS" address rule.
 */

/** A rectangle in window-content coordinates (what `WebContentsView.setBounds` takes). */
export interface BrowserRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface BrowserSize {
  readonly width: number
  readonly height: number
}

/**
 * Where a hidden browser view is parked.
 *
 * Hiding by `setVisible(false)` is not available on `WebContentsView`, and removing the
 * child view destroys focus/scroll state, so the view is moved far off-screen instead —
 * the same technique OneCode uses.
 */
export const BROWSER_HIDDEN_RECT: BrowserRect = { x: -9999, y: -9999, width: 1, height: 1 }

/** Below this the panel is treated as collapsed and the view stays parked. */
export const BROWSER_MIN_EDGE = 24

/**
 * Who asked for the native view to be shown.
 *
 * The distinction is load-bearing: the panel measures itself, so it knows it is on screen; the
 * agent does not, and honouring its request from a remembered rect painted the page over the rest
 * of the UI — an "incomplete sidebar that is not the browser tab", which then could not be
 * dismissed, and which reappeared every time the user collapsed the sidebar during agent work.
 */
export type SurfaceRequest = 'panel' | 'agent'

/** Whether a native surface may be placed at the remembered rect. */
export function mayPlaceSurface(requestedBy: SurfaceRequest, panelVisible: boolean): boolean {
  return requestedBy === 'panel' || panelVisible
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Parse a rect sent by the panel. Returns `undefined` for anything that is not four finite
 * numbers, so a hostile or broken payload degrades to "no bounds" rather than to NaN bounds.
 */
export function parseBrowserRect(input: unknown): BrowserRect | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const raw = input as Record<string, unknown>
  const x = finiteNumber(raw.x)
  const y = finiteNumber(raw.y)
  const width = finiteNumber(raw.width)
  const height = finiteNumber(raw.height)
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined
  return { x, y, width, height }
}

/**
 * Clamp a viewport rect into the window's content area.
 *
 * A panel that reports a rect larger than the window (stale measurement during a resize, or
 * a page that simply lies) must not produce a native surface that covers the rest of the UI.
 * The top-left corner is authoritative — the panel's anchor — and the size shrinks to fit.
 */
export function clampBrowserRect(rect: BrowserRect, content: BrowserSize): BrowserRect {
  const bounds = { width: Math.max(0, Math.floor(content.width)), height: Math.max(0, Math.floor(content.height)) }
  const x = Math.max(0, Math.min(Math.floor(rect.x), bounds.width))
  const y = Math.max(0, Math.min(Math.floor(rect.y), bounds.height))
  return {
    x,
    y,
    width: Math.max(0, Math.min(Math.floor(rect.width), bounds.width - x)),
    height: Math.max(0, Math.min(Math.floor(rect.height), bounds.height - y)),
  }
}

/**
 * Translate a rect measured in the DSH page's viewport into window-content coordinates.
 *
 * The page is served in a child view that starts below the shell's own title strip, so every
 * rect it reports is offset by that strip. Getting this wrong places the browser under the
 * title bar, which is the classic "the panel is 36px too high" bug.
 */
export function toWindowRect(viewportRect: BrowserRect, titleBarHeight: number, content: BrowserSize): BrowserRect {
  const shifted: BrowserRect = {
    x: viewportRect.x,
    y: viewportRect.y + titleBarHeight,
    width: viewportRect.width,
    height: viewportRect.height,
  }
  // The strip belongs to the window, not to the page, so a view that starts above it is
  // pulled down rather than clipped away.
  return clampBrowserRect(shifted, { width: content.width, height: Math.max(0, content.height) })
}

/** Whether a clamped rect is big enough to show a page. */
export function isUsableBrowserRect(rect: BrowserRect): boolean {
  return rect.width >= BROWSER_MIN_EDGE && rect.height >= BROWSER_MIN_EDGE
}

export type AddressResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: string }

const SCHEME = /^[a-z][a-z0-9+.-]*:/iu

/**
 * Turn whatever the user typed into a URL the browser view may load.
 *
 * Rules (mirroring OneCode's address bar): a bare host means HTTPS; only HTTP(S) is
 * accepted; embedded credentials are refused because they end up in history and logs; and
 * this document's own origin is refused so the panel can never be pointed at the DSH UI.
 */
export function normalizeAddress(raw: string, applicationOrigin?: string): AddressResult {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: false, reason: '请输入网址' }

  let candidate = trimmed
  if (!SCHEME.test(candidate)) candidate = `https://${candidate}`

  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return { ok: false, reason: '无法解析这个网址' }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: '只支持 http/https 地址' }
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: '地址里不能带用户名或密码' }
  }
  if (url.hostname === '') return { ok: false, reason: '地址缺少主机名' }
  if (applicationOrigin !== undefined && applicationOrigin !== '' && url.origin === applicationOrigin) {
    return { ok: false, reason: '不能在这个面板里打开 DSH 自身界面' }
  }
  return { ok: true, url: url.href }
}

/** Navigation policy for the browser view: HTTP(S) only, everything else is cancelled. */
export function isAllowedBrowserNavigation(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Whether a `did-fail-load` report deserves a visible error.
 *
 * `ERR_ABORTED` (-3) is what every superseded navigation reports, and sub-frame failures
 * have their own error surface inside the page; neither is worth replacing the page with a
 * failure card.
 */
export function shouldReportLoadFailure(errorCode: number, isMainFrame: boolean): boolean {
  return isMainFrame && errorCode !== -3
}

/** Human-readable failure text for the panel's error line. */
export function describeLoadFailure(errorCode: number, errorDescription: string): string {
  if (errorCode === -105 || errorCode === -106) return '无法解析这个域名'
  if (errorCode === -102) return '连接被拒绝'
  if (errorCode === -118) return '连接超时'
  if (errorCode === -201 || errorCode === -200) return 'HTTPS 证书有问题，无法安全访问'
  return errorDescription === '' ? `加载失败（${String(errorCode)}）` : `${errorDescription}（${String(errorCode)}）`
}
