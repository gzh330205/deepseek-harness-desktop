/**
 * The 用量 button's hover card.
 *
 * A glance, not a workspace: hovering the title bar's 用量 button shows the three token numbers the
 * user actually looks at (近 5 小时 / 今日 / 本周) without opening the usage window or a menu. Clicking
 * the button still opens the existing 用量 menu — the card itself never swallows a click.
 *
 * Three properties drive the design, and each of them is a way this could have been wrong:
 *
 * 1. **It must not take the mouse.** The card is `focusable: false`, ignores mouse events (with
 *    forwarding, so moving across it behaves like moving across empty space) and is shown with
 *    `showInactive()`. Otherwise hovering the button would steal focus from the DSH page mid-typing.
 * 2. **It is a display, not a window.** The gateway cookie, the scraping and the login live in the
 *    usage service; the page gets one frozen object with `get()` and `onState()` and no network of its
 *    own (`CSP default-src 'none'`). Same split as the usage window, for the same reason.
 * 3. **It must disappear.** A floating card left behind is worse than no card at all, so every
 *    hide path (menu click, mouse leave, owner blur/minimize/move) funnels through {@link hide}.
 *
 * The token units mirror the usage window's `fmtTokens` (亿 / M / K) with 万 added for the range where
 * a M value reads oddly in Chinese. Keeping the popover in step with the window matters: two surfaces
 * showing the same number in different units reads like two different numbers.
 *
 * Electron is imported lazily inside the methods that need a real window or `ipcMain`. That is not
 * style for its own sake: the pure placement/state helpers below are unit-tested with plain Node,
 * which cannot load the `electron` module at all.
 */

import { join } from 'node:path'

import {
  IPC,
  USAGE_POPOVER_HEIGHT,
  USAGE_POPOVER_PAGE,
  USAGE_POPOVER_WIDTH,
} from './constants.ts'
import type { BrowserWindow, WebContents } from 'electron'

/** The three periods the card shows. `null` means the gateway did not report a number. */
export interface UsagePopoverTokens {
  readonly h5: number | null
  readonly today: number | null
  readonly week: number | null
}

/** What the page renders. Deliberately smaller than a usage snapshot: channels/logs are not a glance. */
export interface UsagePopoverState {
  readonly loggedIn: boolean
  /** The fix is "sign in again", so the page offers the usage window instead of a retry loop. */
  readonly needsLogin: boolean
  /** Degraded reason, shown verbatim; never a credential or raw gateway output. */
  readonly error?: string
  /** When the numbers were fetched, for the "更新于" line. */
  readonly fetchedAt?: number
  readonly user?: string
  readonly tokens: UsagePopoverTokens
}

/**
 * The part of `UsageSnapshot` this module reads.
 *
 * Structural rather than an import of the service's type on purpose: the popover consumes a handful of
 * fields, and importing the service type would drag the whole scraping module into the static test.
 */
export interface UsageSnapshotLike {
  readonly loggedIn?: boolean
  readonly needsLogin?: boolean
  readonly error?: string
  readonly fetchedAt?: number
  readonly user?: string
  readonly tokens?: {
    readonly h5?: number | null
    readonly today?: number | null
    readonly week?: number | null
  }
}

const finiteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/** Keep only what the card draws, and turn every absent value into an explicit `null`. */
export function toUsagePopoverState(snapshot: UsageSnapshotLike): UsagePopoverState {
  const tokens = snapshot.tokens ?? {}
  return {
    loggedIn: snapshot.loggedIn === true,
    needsLogin: snapshot.needsLogin === true,
    ...(typeof snapshot.error === 'string' && snapshot.error !== '' ? { error: snapshot.error } : {}),
    ...(typeof snapshot.fetchedAt === 'number' && Number.isFinite(snapshot.fetchedAt) ? { fetchedAt: snapshot.fetchedAt } : {}),
    ...(typeof snapshot.user === 'string' && snapshot.user !== '' ? { user: snapshot.user } : {}),
    tokens: {
      h5: finiteNumber(tokens.h5),
      today: finiteNumber(tokens.today),
      week: finiteNumber(tokens.week),
    },
  }
}

/** The button rectangle the title bar sends: view-relative (`getBoundingClientRect`). */
export interface UsagePopoverAnchor {
  readonly x: number
  readonly y: number
  readonly height: number
}

/** Everything placement needs. `contentBounds` is the main window's client area in screen coordinates. */
export interface UsagePopoverPlacement {
  readonly anchor: UsagePopoverAnchor
  readonly contentBounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly workArea: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  /** Defaults to the constants; passed explicitly by the tests. */
  readonly size?: { readonly width: number; readonly height: number }
}

/**
 * Validate an anchor coming over IPC.
 *
 * `null` (mouse left) and anything malformed both answer `undefined`; the caller hides the card. A
 * hover message is the one place a renderer could otherwise send NaN and move a native window off
 * every display.
 */
export function parseUsagePopoverAnchor(value: unknown): UsagePopoverAnchor | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const rect = value as Record<string, unknown>
  if (typeof rect.x !== 'number' || typeof rect.y !== 'number' || typeof rect.height !== 'number') return undefined
  if (![rect.x, rect.y, rect.height].every(number => Number.isFinite(number))) return undefined
  // A button always has a positive height; anything else is a renderer bug, not a position.
  if (rect.height <= 0) return undefined
  return { x: rect.x, y: rect.y, height: rect.height }
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), Math.max(min, max))

/**
 * Where to put the card: aligned with the button's left edge, right below the strip, clamped into the
 * display's work area (not the screen: the taskbar is not usable space). A window dragged near the
 * right/bottom edge would otherwise open a card the user cannot read.
 */
export function usagePopoverPosition(placement: UsagePopoverPlacement): { readonly x: number; readonly y: number } {
  const width = placement.size?.width ?? USAGE_POPOVER_WIDTH
  const height = placement.size?.height ?? USAGE_POPOVER_HEIGHT
  const { anchor, contentBounds, workArea } = placement
  const x = clamp(
    Math.round(contentBounds.x + anchor.x),
    workArea.x,
    workArea.x + workArea.width - width,
  )
  const y = clamp(
    Math.round(contentBounds.y + anchor.y + anchor.height),
    workArea.y,
    workArea.y + workArea.height - height,
  )
  return { x, y }
}

/** Whether a URL is the popover document itself. The only sender the read bridge accepts. */
export function isUsagePopoverUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:') return false
    return parsed.pathname.replace(/\\/gu, '/').endsWith(USAGE_POPOVER_PAGE)
  } catch {
    return false
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Wait until a renderer is no longer loading.
 *
 * Polling rather than `once('did-finish-load')`: `loadFile()` resolves around the same tick as that
 * event, so a listener attached just afterwards waits forever for a load that already happened. The
 * hover card's smoke probe reported `loaded: false` exactly that way, and a card shown during the same
 * transient window would paint as a blank sliver.
 */
async function waitForLoad(contents: WebContents, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (contents.isLoading()) {
    if (contents.isDestroyed() || Date.now() >= deadline) return false
    await new Promise<void>((resolve) => { setTimeout(resolve, 25) })
  }
  return !contents.isDestroyed()
}

export interface UsagePopoverWindowOptions {
  readonly appRoot: string
  /** Chrome colour from the OS theme; the page's CSS still handles its own light/dark palette. */
  readonly backgroundColor: string
  /** The fresh snapshot to render. Called once per show; the service caches, so this is cheap. */
  readonly snapshot: () => Promise<UsagePopoverState>
  readonly log?: (line: string) => void
}

export class UsagePopoverWindow {
  private window: BrowserWindow | undefined
  /** Bumped on every show/hide so a slow snapshot can never paint after the card is gone. */
  private generation = 0
  private readonly options: UsagePopoverWindowOptions

  // A plain field rather than a constructor parameter property: Node's test runner strips types
  // without transforming syntax, and parameter properties are not supported there — the pure helpers
  // live in this module, so the test has to be able to import it.
  constructor(options: UsagePopoverWindowOptions) {
    this.options = options
  }

  private log(line: string): void {
    this.options.log?.(line)
  }

  /**
   * Register the read-only bridge.
   *
   * Only the popover page may call it: the preload object exists there and nowhere else, and the main
   * process repeats the check on the sender frame rather than trusting that.
   */
  async install(): Promise<void> {
    const { ipcMain } = await import('electron')
    ipcMain.handle(IPC.usagePopoverGet, async (event) => {
      if (!isUsagePopoverUrl(event.senderFrame?.url ?? '')) {
        throw new Error('dsh desktop: rejected usage popover IPC from an unowned renderer')
      }
      return await this.options.snapshot()
    })
  }

  /** Show the card at a screen position (already clamped by {@link usagePopoverPosition}). */
  async show(position: { readonly x: number; readonly y: number }): Promise<void> {
    const window = await this.ensureWindow()
    if (window === undefined || window.isDestroyed()) return
    const generation = ++this.generation
    window.setBounds({
      x: Math.round(position.x),
      y: Math.round(position.y),
      width: USAGE_POPOVER_WIDTH,
      height: USAGE_POPOVER_HEIGHT,
    })
    if (!window.isVisible()) window.showInactive()
    await this.push(window, generation)
  }

  /** Hide the card. Safe to call at any time; the common branch is "was never shown". */
  hide(): void {
    this.generation += 1
    const window = this.window
    if (window === undefined || window.isDestroyed() || !window.isVisible()) return
    window.hide()
  }

  isVisible(): boolean {
    const window = this.window
    return window !== undefined && !window.isDestroyed() && window.isVisible()
  }

  /** Create the window on first use. Undefined means the card stays hidden rather than throwing. */
  private async ensureWindow(): Promise<BrowserWindow | undefined> {
    const existing = this.window
    if (existing !== undefined && !existing.isDestroyed()) return existing
    this.window = undefined
    try {
      const { BrowserWindow: BrowserWindowClass } = await import('electron')
      const window = new BrowserWindowClass({
        width: USAGE_POPOVER_WIDTH,
        height: USAGE_POPOVER_HEIGHT,
        frame: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        // A card that cannot take focus is the whole point: hovering a title bar button must not pull
        // focus out of the DSH page while the user is typing.
        focusable: false,
        show: false,
        hasShadow: true,
        roundedCorners: true,
        backgroundColor: this.options.backgroundColor,
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
      this.window = window
      window.setMenuBarVisibility(false)
      // Above normal windows, but below a real context menu: the hover card must never cover the menu
      // the same button opens.
      window.setAlwaysOnTop(true, 'pop-up-menu')
      // Clicks pass through to whatever is underneath, like a tooltip. Without this the card would
      // sit over the DSH page and swallow clicks until the pointer left it.
      window.setIgnoreMouseEvents(true, { forward: true })
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.on('closed', () => {
        if (this.window === window) this.window = undefined
      })
      await window.loadFile(join(this.options.appRoot, 'dist', 'usage-popover', 'index.html'))
      // `loadFile` resolves in the same tick as `did-finish-load`, and `isLoading()` can still report
      // true for a moment afterwards. Showing the card at that instant paints a blank sliver, so wait
      // the transient out before returning.
      await waitForLoad(window.webContents, 2_000)
      return window.isDestroyed() ? undefined : window
    } catch (error) {
      const broken = this.window
      this.window = undefined
      if (broken !== undefined && !broken.isDestroyed()) broken.destroy()
      this.log(`用量浮窗：创建失败（${messageOf(error)}）`)
      return undefined
    }
  }

  /**
   * Fetch a snapshot and push it to the page.
   *
   * Delivery is best-effort: the page also calls `get()` on load, so a push that lands before its
   * listener is attached costs nothing. What must not happen is a *stale* push after the card was
   * hidden or moved to a newer snapshot — hence the generation check.
   */
  private async push(window: BrowserWindow, generation: number): Promise<void> {
    let state: UsagePopoverState
    try {
      state = await this.options.snapshot()
    } catch (error) {
      state = {
        loggedIn: false,
        needsLogin: false,
        error: `用量读取失败：${messageOf(error)}`,
        tokens: { h5: null, today: null, week: null },
      }
    }
    if (generation !== this.generation || window.isDestroyed()) return
    const contents = window.webContents
    if (contents.isDestroyed() || contents.isCrashed()) return
    try {
      contents.send(IPC.usagePopoverState, state)
    } catch {
      // The renderer may have gone away between the checks; the card is disposable by design.
    }
  }

  /** Wait for the page, then report paint state, bridge presence and the three metric elements. */
  async probe(timeoutMs = 8_000): Promise<{ readonly loaded: boolean; readonly bridge: boolean; readonly selectors: Record<string, boolean> }> {
    const window = this.window
    if (window === undefined || window.isDestroyed()) return { loaded: false, bridge: false, selectors: {} }
    const contents = window.webContents
    const loaded = await waitForLoad(contents, timeoutMs)
    if (!loaded) return { loaded: false, bridge: false, selectors: {} }
    try {
      const result = await contents.executeJavaScript(
        `(() => { const ids = ${JSON.stringify(['metricH5', 'metricToday', 'metricWeek'])};`
        + ' const out = { selectors: {}, bridge: typeof window.__DSH_USAGE_POPOVER__ === "object" && window.__DSH_USAGE_POPOVER__ !== null };'
        + ' for (const id of ids) out.selectors[id] = document.getElementById(id) !== null; return out })()',
      ) as { readonly selectors: Record<string, boolean>; readonly bridge: boolean }
      return { loaded: true, bridge: result.bridge, selectors: result.selectors }
    } catch {
      return { loaded: true, bridge: false, selectors: {} }
    }
  }
}
