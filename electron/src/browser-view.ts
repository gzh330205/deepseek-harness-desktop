/**
 * The shell-owned sidebar browser: one native `WebContentsView` driven by the DSH page.
 *
 * Why a native view instead of DSH's own browser tab: this surface, its session, its
 * navigation policy and (in the next milestone) its agent tools are all ours, so a DSH
 * upgrade cannot take the feature away. The panel UI is a DSH client plugin that registers
 * into the right sidebar; it only *measures* and *drives* this view.
 *
 * Layout contract with the panel:
 *   - the panel reports its stage rect in DSH viewport coordinates;
 *   - `toWindowRect` shifts it below the shell title strip and clamps it to the window;
 *   - a collapsed or hidden panel parks the view off-screen (`BROWSER_HIDDEN_RECT`), since
 *     `WebContentsView` has no `setVisible(false)` and removing the child view would throw
 *     away focus, scroll position and media state.
 *
 * One document, one view: `multiple` instances are deliberately out of scope for this
 * milestone, so closing the last panel tab destroys the view.
 *
 * Adapted from OneCode (`apps/desktop/src/main/browser/BrowserManager.ts`, MIT): view
 * creation/offscreen parking, the navigation event -> state push, `setWindowOpenHandler`
 * and the `will-navigate` policy shape (its multi-tab, device-emulation, picker, download
 * and certificate handling are intentionally not carried over yet).
 */

import { WebContentsView, session, type BrowserWindow, type Session } from 'electron'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  BROWSER_HIDDEN_RECT,
  mayPlaceSurface,
  clampBrowserRect,
  describeLoadFailure,
  isAllowedBrowserNavigation,
  isUsableBrowserRect,
  normalizeAddress,
  parseBrowserRect,
  shouldReportLoadFailure,
  toWindowRect,
  type BrowserRect,
} from './browser-geometry.ts'
import { dispatchBrowserClick, dispatchBrowserKeys } from './browser-input.ts'
import {
  DEFAULT_BROWSER_PREFS,
  mergeBrowserPrefs,
  type BrowserPrefs,
} from './browser-prefs.ts'
import {
  PICKER_ALREADY_ACTIVE,
  PICKER_REMOVE_SCRIPT,
  PICK_OFF_MARKER,
  asPickedElement,
  buildPickerScript,
  parseConsolePick,
  pickSignature,
  type PickedElement,
} from './browser-picker.ts'
import {
  SNAPSHOT_SCRIPT,
  buildClickScript,
  buildElementCenterScript,
  buildFindScript,
  buildScrollScript,
  buildSelectScript,
  buildTypeScript,
  buildWaitScript,
} from './browser-snapshot.ts'
import type {
  BrowserToolHost,
  FindInput,
  FindMatch,
  FindOutput,
  HostResult,
  ScrollOutput,
  SelectOptionEntry,
  SelectOutput,
  SnapshotData,
} from './browser-tools.ts'

/**
 * A dedicated persistent partition: the browser keeps its own cookies and storage, so a
 * third-party site can never see (or be handed) the DSH session cookie, and logging into a
 * site in the panel survives a restart.
 */
export const BROWSER_PARTITION = 'persist:dsh-desktop-browser'

// Device emulation presets/specs/bounds live in `browser-device.ts` (pure, so it is unit-tested).
export {
  DEVICE_PRESETS,
  DEVICE_SPECS,
  MAX_DEVICE_HEIGHT,
  MAX_DEVICE_WIDTH,
  MIN_DEVICE_HEIGHT,
  MIN_DEVICE_WIDTH,
  clampDeviceSize,
  effectiveDeviceSize,
  isDevicePreset,
  presetSize,
} from './browser-device.ts'
export type { DevicePreset } from './browser-device.ts'
import { DEVICE_SPECS, chromeLikeUserAgent, clampDeviceSize, effectiveDeviceSize, isDevicePreset, presetSize } from './browser-device.ts'
import { FREEZE_IDLE, beginFreeze, blocksSurfaceShow, clearFreeze, endFreeze, type FreezeState } from './browser-freeze.ts'
import { withTimeout } from './async-timeout.ts'
import {
  ACTIVITY_PROBE_SCRIPT,
  CONTROL_WAIT_SECONDS,
  DEFAULT_AUTO_RELEASE_SECONDS,
  clampAutoReleaseSeconds,
  isActivityMessage,
  nextAutoReleaseAt,
  type ControlWaitOutcome,
} from './browser-control.ts'
import { AGENT_VEIL_MAX_MS, MIN_VEIL_MS, VEIL_LINGER_MS, isTakeoverMessage, overlayUrl, shouldShowAgentVeil, veilLabel } from './browser-overlay.ts'
import type { DevicePreset } from './browser-device.ts'

export interface BrowserViewState {
  /** The page URL the panel should show in its address bar. */
  readonly url: string
  readonly title: string
  readonly loading: boolean
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  /** Current device-emulation preset, for the panel's selector. */
  readonly device: DevicePreset
  /** Effective emulated viewport (0 = "no override, the real window size"). */
  readonly deviceWidth: number
  readonly deviceHeight: number
  readonly deviceRotated: boolean
  /** Whether element picking is armed on this view. */
  readonly picking: boolean
  /** Whether an agent tool call is driving this view right now (the veil is up). */
  readonly agentActive: boolean
  /** Whether the user took over by clicking the browser (waiting calls park until released). */
  readonly userDriving: boolean
  /** Epoch ms when control is handed back automatically (0 while the agent has it). */
  readonly autoReleaseAt: number
  /** Non-null while the last main-frame navigation failed. */
  readonly error: { readonly code: number; readonly description: string; readonly message: string } | null
}

export interface BrowserCommandResult {
  readonly ok: boolean
  readonly reason?: string
  readonly state?: BrowserViewState
  /**
   * Whether the panel is on screen right now (`panelVisible`).
   *
   * The page asks instead of guessing: a kept-mounted panel body from another session makes any
   * DOM lookup a false positive (that guess cost us one broken auto-open attempt).
   */
  readonly visible?: boolean
  /** Address-bar history, newest first (`history`). */
  readonly entries?: readonly BrowserHistoryEntry[]
  /** Browser-owned preferences (`prefs` / `setPrefs`). */
  readonly prefs?: BrowserPrefs
  /** Frozen snapshot of the page as a data URL (`freeze`), for DOM menus over the view. */
  readonly frame?: string
  /**
   * Whether {@link frame}'s freeze actually parked a native surface (`freeze`). `false` means
   * "there was nothing on screen to cover", so the panel must not draw a placeholder.
   */
  readonly frozen?: boolean
}

export interface BrowserHistoryEntry {
  readonly url: string
  readonly title: string
  /** Unix ms of the visit. */
  readonly at: number
}

export interface BrowserViewManagerOptions {
  /** The window the view attaches to; read lazily because the window outlives no one. */
  readonly window: () => BrowserWindow | undefined
  /** Where state changes are pushed (the DSH page). */
  readonly notify: (state: BrowserViewState) => void
  /** Shell log line, for the support bundle. */
  readonly log: (line: string) => void
  /** Height of the shell's own title strip; viewport rects start below it. */
  readonly titleBarHeight: number
  /** The DSH page's own origin, refused as a browser target. */
  readonly applicationOrigin: () => string | undefined
  /** Where `browser_screenshot` writes its PNG (the shell's userData directory). */
  readonly screenshotDir: () => string
  /** A picked element, already validated against the injection nonce. */
  readonly onPick: (element: PickedElement) => void
  /** Browser-owned preferences (homepage, bookmarks) and their persistence. */
  readonly prefs: {
    readonly read: () => BrowserPrefs
    readonly write: (prefs: BrowserPrefs) => void
    readonly directory: () => string
  }
  /**
   * Browser control changed hands (the user took over, or it was handed back).
   *
   * The panel learns through the normal state push; this hook exists for the *agent*: the shell
   * uses it to append a note to the session, so the model is told instead of having to probe.
   */
  readonly onControlChange?: (change: ControlChange) => void
}

/** One control-handover transition, as reported to the shell. */
export interface ControlChange {
  readonly state: 'taken' | 'released'
  readonly reason: 'user-click' | 'panel' | 'auto-idle'
  readonly autoReleaseSeconds: number
  /**
   * Whether a tool call was in flight at this moment.
   *
   * The shell uses it to decide whether the *agent* needs a session note: a call in flight will be
   * held and its result carries the explanation, and writing a note as well is what made a real
   * agent stop and end its turn (see shouldWriteControlNote).
   */
  readonly agentActive: boolean
}

type Modifier = 'control' | 'shift' | 'alt' | 'meta'

/** Accepted key names, normalised to the names the CDP dispatcher knows. */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  escape: 'Esc',
  esc: 'Esc',
  delete: 'Del',
  del: 'Del',
  insert: 'Ins',
  ins: 'Ins',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  home: 'Home',
  end: 'End',
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  space: 'Space',
  backspace: 'Backspace',
}

/**
 * Parse one accelerator ("Enter", "Control+a", "Shift+Enter") into the CDP dispatcher's
 * shape. Chromium normalises the letters/digits/f-keys itself, so only aliases are mapped.
 */
export function parseAccelerator(input: string): { key: string; modifiers: Modifier[] } | undefined {
  const parts = input.split('+').map((part) => part.trim()).filter((part) => part !== '')
  if (parts.length === 0) return undefined
  const rawKey = parts[parts.length - 1] ?? ''
  const modifiers: Modifier[] = []
  for (const part of parts.slice(0, -1)) {
    const lower = part.toLowerCase()
    if (lower === 'control' || lower === 'ctrl') modifiers.push('control')
    else if (lower === 'shift') modifiers.push('shift')
    else if (lower === 'alt' || lower === 'option') modifiers.push('alt')
    else if (lower === 'meta' || lower === 'cmd' || lower === 'command' || lower === 'super') modifiers.push('meta')
    else return undefined
  }
  const alias = KEY_ALIASES[rawKey.toLowerCase()]
  if (alias !== undefined) return { key: alias, modifiers }
  if (/^[a-z0-9]$/iu.test(rawKey)) return { key: rawKey, modifiers }
  if (/^f\d{1,2}$/iu.test(rawKey)) return { key: rawKey.toUpperCase(), modifiers }
  return undefined
}

/** Electron's own key names for the no-CDP fallback (named keys and single characters). */
function fallbackKeyCode(key: string): string | undefined {
  const named: Readonly<Record<string, string>> = {
    Enter: 'Return',
    Tab: 'Tab',
    Esc: 'Escape',
    Space: 'Space',
    Backspace: 'Backspace',
    Del: 'Delete',
    Ins: 'Insert',
    Up: 'Up',
    Down: 'Down',
    Left: 'Left',
    Right: 'Right',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Home: 'Home',
    End: 'End',
  }
  const mapped = named[key]
  if (mapped !== undefined) return mapped
  return /^[a-z0-9]$/iu.test(key) ? key.toUpperCase() : undefined
}

/** How many visits one tab remembers for the address-bar dropdown. */
const MAX_VISITS = 200

/**
 * How long a page script may take before the tool reports "the page looks stuck".
 *
 * Generous on purpose (a heavy page can take seconds to walk), but finite: without it a wedged
 * renderer holds the model's turn open with no way for it to find out why.
 */
const SCRIPT_TIMEOUT_MS = 20_000

/** Internal visit record; the title is patched when `page-title-updated` arrives. */
interface MutableVisit {
  url: string
  title: string
  at: number
}

const EMPTY_STATE: BrowserViewState = {
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  device: 'desktop',
  deviceWidth: 0,
  deviceHeight: 0,
  deviceRotated: false,
  picking: false,
  agentActive: false,
  userDriving: false,
  autoReleaseAt: 0,
  error: null,
}

/**
 * Owns the single browser view. All methods are safe to call before the view exists.
 */
/**
 * Sessions whose cookie diagnostics are already installed.
 *
 * Every browser tab shares one persistent partition; without this the `changed` listener would be
 * registered once per tab and every cookie would be logged N times.
 */
const cookieDiagnosticsInstalled = new WeakSet<Session>()

export class BrowserViewManager {
  private view: WebContentsView | undefined
  private lastRect: BrowserRect = BROWSER_HIDDEN_RECT
  private visibleState = false
  /**
   * Whether the panel is on screen right now.
   *
   * Set by the panel's own `bounds` (a usable rect means it is there) and cleared by its `hide`
   * (collapsed sidebar, another tab selected, panel gone). The agent must never place the view
   * without it: that is what painted a stale page over the UI and made the sidebar look broken.
   */
  private panelVisible = false
  /** Set once by {@link shutdown}: the window is going away, so no new view may be built. */
  private retired = false
  private error: BrowserViewState['error'] = null
  private device: DevicePreset = 'desktop'
  /** Custom emulated viewport; absent means "use the preset's own size". */
  private customDeviceSize: { width: number; height: number } | undefined
  private deviceRotated = false
  /** Nonce of the armed pick session; `undefined` while picking is off. */
  private pickNonce: string | undefined
  /** Picks already handed to the panel for the current arming (de-dupes the two transports). */
  private readonly deliveredPicks = new Set<string>()
  /** Address-bar history for this tab, newest last; bounded. */
  private readonly visits: MutableVisit[] = []
  /** Set while a DOM menu in the panel is covering the view (see {@link freeze}). */
  private freezeState: FreezeState = FREEZE_IDLE
  /** The last frozen snapshot, so a repeated freeze still has something to draw. */
  private lastFrame: string | undefined
  /** The "the agent is driving" veil, layered over this view. Created on first use. */
  private veil: WebContentsView | undefined
  private veilReady: Promise<WebContentsView | undefined> | undefined
  /**
   * The veil's layer is currently **shown**.
   *
   * It stays true while the view is merely parked (another tab/conversation is on screen): parking is
   * not "the agent stopped", so the marker comes back with the view instead of being lost.
   */
  private veilUp = false
  /** When the veil went up in this stretch (the anti-blink minimum is measured from here). */
  private veilShownAt = 0
  /**
   * Whether the agent's turn in this conversation is running, per DSH's own session status.
   *
   * `undefined` = not known (the panel cannot read it): the marker then falls back to the per-call
   * signal plus {@link VEIL_LINGER_MS}. This is what keeps the marker steady for a whole turn instead
   * of blinking it on every tool call — see {@link veilShouldBeUp}.
   */
  private turnRunning: boolean | undefined
  /** True once a tool call has touched this browser during the current turn. */
  private turnTouched = false
  /** Until this moment the marker stays up after the last call ended (anti-flicker). */
  private lingerUntil = 0
  private lingerTimer: ReturnType<typeof setTimeout> | undefined
  /** How many agent tool calls are in flight right now (they can overlap). */
  private agentCalls = 0
  /**
   * Safety net for a call that never settles (see {@link AGENT_VEIL_MAX_MS}).
   *
   * Not the normal path: the shell lowers the veil when a call returns. This only exists so a
   * hung call cannot leave the marker up forever.
   */
  private veilWatchdog: ReturnType<typeof setTimeout> | undefined
  /** The label of the call currently holding the veil (re-shown after a menu freeze). */
  private veilLabelText = ''
  /** True once the user clicked the veil: the agent stops driving until released. */
  private userDriving = false
  /** Tool calls parked on "the user has control"; resolved by {@link releaseToAgent}. */
  private controlWaiters: (() => void)[] = []
  /** Auto-release window, its deadline, and the last panel push about it. */
  private autoReleaseSeconds = DEFAULT_AUTO_RELEASE_SECONDS
  private autoReleaseAt = 0
  private autoReleaseTimer: ReturnType<typeof setTimeout> | undefined
  private lastAutoReleasePush = 0
  /** The UA to restore when emulation is cleared (captured at view creation). */
  private defaultUserAgent = ''
  /**
   * Assigned in the body rather than as a parameter property: Node's strip-only TypeScript
   * (used by the tests and by probes that drive this class inside a real Electron process)
   * rejects parameter properties outright.
   */
  private options: BrowserViewManagerOptions

  constructor(options: BrowserViewManagerOptions) {
    this.options = options
  }

  /**
   * Point this live view at another tab occurrence.
   *
   * Adoption moves a view between our ids ("the sidebar tab that just opened *is* this browser"),
   * and three options are closures that **name** the tab they report about. Re-binding keeps the
   * page, its history and any running load untouched while state pushes, picks and control notes
   * start naming the tab that now owns the view. Not a rebuild: nothing is re-navigated.
   */
  rebind(patch: Partial<Pick<BrowserViewManagerOptions, 'notify' | 'onPick' | 'onControlChange'>>): void {
    this.options = { ...this.options, ...patch }
    // The panel may be showing an empty stage: tell it this view already has a page, so its next
    // claim places the native surface instead of leaving the sidebar blank.
    this.push()
  }

  /** Whether a live view exists (the panel renders "not created yet" without it). */
  get created(): boolean {
    return this.view !== undefined && !this.view.webContents.isDestroyed()
  }  /** The guest contents, for the agent tools landing in the next milestone. */
  get contents(): Electron.WebContents | undefined {
    return this.created ? this.view?.webContents : undefined
  }

  private browserSession(): Session {
    return session.fromPartition(BROWSER_PARTITION)
  }

  /** Create the view on first use; subsequent calls are no-ops that return current state. */
  ensureCreated(): BrowserCommandResult {
    if (this.retired) return { ok: false, reason: '浏览器已关闭' }
    if (this.created) return { ok: true, state: this.state() }

    const window = this.options.window()
    if (window === undefined || window.isDestroyed()) return { ok: false, reason: '主窗口未就绪' }

    const view = new WebContentsView({
      webPreferences: {
        session: this.browserSession(),
        // The page gets no preload, no Node and no shell bridge: everything the browser
        // needs is driven from this process.
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
      },
    })
    view.setBackgroundColor('#ffffff')
    view.setBounds(BROWSER_HIDDEN_RECT)
    window.contentView.addChildView(view)
    // Before the first load: a Chrome-shaped UA (Electron's own token makes risk control treat the
    // session as untrusted, which shows up as a login that never sticks).
    view.webContents.setUserAgent(chromeLikeUserAgent(view.webContents.getUserAgent()))
    this.view = view
    this.defaultUserAgent = view.webContents.getUserAgent()
    this.attach(view)
    this.options.log('侧边栏浏览器视图已创建')
    return { ok: true, state: this.state() }
  }

  private attach(view: WebContentsView): void {
    const contents = view.webContents

    contents.on('did-start-loading', () => { this.push() })
    contents.on('did-stop-loading', () => { this.push() })
    contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) { this.error = null; this.push() }
    })
    contents.on('did-navigate', (_event, url) => {
      this.error = null
      this.recordVisit(url)
      // The navigation chain is the only way to see a site bounce back to its login page: the
      // shell logs one line per committed main-frame navigation, redirects included.
      this.options.log(`侧边栏浏览器导航：${url}`)
      this.push()
    })
    contents.on('did-redirect-navigation', (_event, url, _inPlace, mainFrame) => {
      if (mainFrame) this.options.log(`侧边栏浏览器重定向：${url}`)
    })
    contents.on('did-navigate-in-page', (_event, url, mainFrame) => {
      if (!mainFrame) return
      // A single-page app "redirects to the login page" with a route change, not a navigation: without
      // this line a login that bounces back leaves no trace in the log at all.
      this.options.log(`侧边栏浏览器页面内跳转：${url}`)
      this.push()
    })
    contents.on('page-title-updated', () => {
      // The title usually arrives after the navigation: patch the visit we just recorded
      // rather than adding a second entry for the same page.
      const last = this.visits.at(-1)
      const title = contents.getTitle()
      if (last !== undefined && last.url === contents.getURL() && title !== '') last.title = title
      this.push()
    })
    contents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (!shouldReportLoadFailure(errorCode, isMainFrame)) return
      this.error = {
        code: errorCode,
        description: errorDescription,
        message: describeLoadFailure(errorCode, errorDescription),
      }
      // A failed page keeps its error card: park the view so the panel's own message shows.
      view.setBounds(BROWSER_HIDDEN_RECT)
      this.options.log(`侧边栏浏览器加载失败：${String(errorCode)} ${errorDescription}`)
      this.push()
    })
    contents.on('render-process-gone', (_event, details) => {
      this.error = { code: 0, description: details.reason, message: `页面进程已退出（${details.reason}）` }
      this.push()
    })

    // Only HTTP(S) navigations inside this view; everything else (file:, dsh-app:, custom
    // schemes) is cancelled. This is the view's own policy — the main window's stricter
    // allow-list must not be reused here.
    contents.on('will-navigate', (event, url) => {
      if (!isAllowedBrowserNavigation(url)) {
        event.preventDefault()
        this.options.log(`侧边栏浏览器已阻止导航：${url}`)
      }
    })

    // `window.open` / target=_blank stay in the panel: a popup window would float over the
    // shell with no panel chrome and no way back. Only real page navigations are followed.
    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedBrowserNavigation(url)) void contents.loadURL(url).catch(() => {})
      return { action: 'deny' }
    })

    // The picker's backup transport: a marked console line. (Its primary transport is the
    // promise the injected script returns, which `setPickMode` awaits.) Our views have no
    // preload, so a page can reach the shell only through markers carrying the armed nonce.
    contents.on('console-message', (details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>) => {
      const message = details.message
      if (typeof message !== 'string') return
      // "The user is touching the page": the only mouse-visible signal we have (see
      // ACTIVITY_PROBE_SCRIPT). It keeps a user takeover alive while they keep working.
      if (isActivityMessage(message)) {
        this.noteUserActivity()
        return
      }
      if (message === PICK_OFF_MARKER) {
        this.disarmPick()
        return
      }
      this.acceptPick(parseConsolePick(message, this.pickNonce ?? ''))
    })

    // Which cookies a login actually sets — names and domains only, never values.
    //
    // The browser shares one persistent partition, so this is registered once per session rather
    // than once per tab. It is the difference between "the site never stored its session" and "it
    // stored it and something removed it", which is otherwise invisible from the shell.
    const browserSession = contents.session
    if (!cookieDiagnosticsInstalled.has(browserSession)) {
      cookieDiagnosticsInstalled.add(browserSession)
      browserSession.cookies.on('changed', (_event, cookie, cause, removed) => {
        this.options.log(`浏览器 Cookie ${removed ? '删除' : '写入'}：${cookie.name}（${cookie.domain}，${cause}）`)
      })
    }

    // Page-side diagnostics for *auth* failures. A site that quietly bounces back to its login page
    // (rejected cookie, blocked third-party storage, failing API call) says why in its own console —
    // and until this existed, none of it reached shell.log, so such a loop left no trace at all.
    contents.on('console-message', (details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>) => {
      if (details.level !== 'error' && details.level !== 'warning') return
      const message = typeof details.message === 'string' ? details.message.replace(/\s+/gu, ' ').slice(0, 300) : ''
      if (message === '') return
      // Errors are few and always relevant; warnings are noisy, so only the storage/auth family.
      const interesting = details.level === 'error'
        || /cookie|storage|partition|blocked|SameSite|CORS|401|403|session|token|login/i.test(message)
      if (!interesting) return
      this.options.log(`[页面${details.level === 'error' ? '错误' : '警告'}] ${message}`)
    })

    // Keyboard input needs no page script: Electron reports it here.
    contents.on('before-input-event', () => { this.noteUserActivity() })

    // Re-install the activity listener after every navigation (it dies with the document).
    contents.on('did-finish-load', () => { void this.installActivityProbe() })

    // M1 has no consent UI, so every capability request is refused rather than silently
    // granted: geolocation, camera, notifications, clipboard, and so on.
    contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => { callback(false) })
  }

  /** Re-place the view from a rect the panel measured, or park it when unusable. */
  setBounds(input: unknown): BrowserCommandResult {
    const rect = parseBrowserRect(input)
    if (rect === undefined) return { ok: false, reason: 'bounds 参数不合法' }
    const window = this.options.window()
    if (window === undefined || window.isDestroyed()) return { ok: false, reason: '主窗口未就绪' }

    const content = window.getContentBounds()
    const placed = toWindowRect(rect, this.options.titleBarHeight, { width: content.width, height: content.height })
    this.lastRect = placed
    // A usable rect can only come from a panel that is actually laid out.
    this.panelVisible = isUsableBrowserRect(placed)
    if (!this.visibleState) return { ok: true }
    this.applyBounds(placed)
    return { ok: true }
  }

  /**
   * Show the view at the last reported rect (re-clamped against the current window).
   *
   * `requestedBy` matters, and getting it wrong produced two real bugs:
   *
   * - the panel asks for `'panel'`: it just measured itself, so it is on screen — place it;
   * - the **agent** asks for `'agent'` (a `navigate` with `show: true`): it has no idea whether
   *   the sidebar is open. Honouring it from the last known rect painted the page at a stale
   *   position over the rest of the UI — an "incomplete sidebar that isn't the browser tab" that
   *   covered the real sidebar and could not be dismissed. And because every later call re-showed
   *   it, collapsing the sidebar during agent work appeared to do nothing.
   *
   * So: an agent-requested show only takes effect while the panel is actually visible. Otherwise
   * the page keeps running in the background and the caller is told the truth (`state().visible`).
   */
  show(requestedBy: 'panel' | 'agent' = 'panel'): BrowserCommandResult {
    // While a panel menu is open the surface must stay parked: the panel keeps reporting
    // bounds on resize, and re-showing here would paint the page over the open menu.
    if (blocksSurfaceShow(this.freezeState)) return { ok: true, state: this.state() }
    const created = this.ensureCreated()
    if (!created.ok) return created
    const window = this.options.window()
    if (window === undefined || window.isDestroyed()) return { ok: false, reason: '主窗口未就绪' }
    if (!mayPlaceSurface(requestedBy, this.panelVisible)) {
      this.visibleState = false
      this.applyBounds(BROWSER_HIDDEN_RECT)
      this.options.log('助手请求显示页面，但侧边栏浏览器面板当前不可见：页面继续在后台运行（可见性由面板决定）')
      return { ok: true, state: this.state() }
    }
    const content = window.getContentBounds()
    const placed = clampBrowserRect(this.lastRect, { width: content.width, height: content.height })
    this.visibleState = isUsableBrowserRect(placed)
    this.applyBounds(this.visibleState ? placed : BROWSER_HIDDEN_RECT)
    return { ok: true, state: this.state() }
  }

  /** Hide without tearing the page down: media keeps playing, state is kept. */
  hide(): BrowserCommandResult {
    // A hidden tab must be showable again: a freeze only means "a panel menu is covering this
    // view right now". Leaving it set here would make every later show() a no-op — the page
    // would never come back after switching tabs with a menu open. (Freezing parks the surface
    // through its own path for exactly that reason.)
    this.freezeState = clearFreeze()
    this.visibleState = false
    this.panelVisible = false
    // Park the surface **and its veil**, but keep the marker's intent: parking happens whenever the
    // user looks at another tab or conversation, and that must not read as "the agent stopped
    // working". `syncVeil` parks the layer; showing the view again brings the marker straight back.
    this.applyBounds(BROWSER_HIDDEN_RECT)
    return { ok: true }
  }

  private applyBounds(rect: BrowserRect): void {
    if (!this.created) return
    try {
      this.view?.setBounds(rect)
    } catch (error) {
      this.options.log(`侧边栏浏览器定位失败：${error instanceof Error ? error.message : String(error)}`)
    }
    // The veil is a sibling native view, so it has to follow every move — and it may only be up
    // while the browser view itself is up (`syncVeil` is the one place that decides that).
    this.syncVeil(rect)
  }

  /**
   * The single place that decides where the veil goes.
   *
   * The veil belongs to *this* view: it is up exactly when the marker is wanted and the view is
   * placed, and parked (`BROWSER_HIDDEN_RECT`) otherwise. Putting that rule here — rather than at each
   * call site — is what keeps a session switch from leaving a stray veil behind or dropping one that
   * should be showing: parking the view parks its veil in the same call, and showing it again brings
   * the veil back (the marker itself was never dropped).
   */
  private syncVeil(rect: BrowserRect): void {
    const wanted = this.veilShouldBeUp() && isUsableBrowserRect(rect) ? rect : BROWSER_HIDDEN_RECT
    this.placeVeil(wanted)
  }

  /**
   * Whether the "the assistant is driving" marker should be up right now.
   *
   * One rule, computed from state instead of toggled from each call site:
   *   - a call is in flight → up;
   *   - the conversation's turn is still running **and** it has touched this browser → up. This is the
   *     part that stops the blinking: between two tool calls the model thinks for seconds, and
   *     showing/hiding the marker around every single call made the whole page flicker;
   *   - the turn just ended, or its status is unknown → hold it for a moment, so back-to-back turns do
   *     not blink either;
   *   - the user took over → never (the panel offers the hand-back button instead).
   */
  private veilShouldBeUp(): boolean {
    if (this.userDriving) return false
    if (this.agentCalls > 0) return true
    if (this.turnRunning === true && this.turnTouched) return true
    return Date.now() < this.lingerUntil
  }

  /** Make the veil match {@link veilShouldBeUp}: show it, or take it down. */
  private refreshVeil(): void {
    if (!this.veilShouldBeUp()) {
      this.hideVeil()
      return
    }
    void this.showVeil(this.veilLabelText === '' ? veilLabel('') : this.veilLabelText)
  }

  /**
   * The conversation's agent turn started or ended (DSH's own session status, relayed by the panel).
   *
   * This is what makes the marker follow the **turn**: up while the agent works on this browser, down
   * the moment the turn is over — instead of guessing from call boundaries.
   */
  setAgentTurn(running: boolean): void {
    if (running) {
      if (this.turnRunning !== true) {
        // A fresh turn: nothing has touched this browser in it yet, and any pending drop is void.
        this.turnTouched = false
        this.clearLinger()
      }
      this.turnRunning = true
    } else {
      this.turnRunning = false
      this.turnTouched = false
      this.clearLinger()
    }
    this.refreshVeil()
  }

  // ── 「助手正在操作」遮罩 ─────────────────────────────────────────────────────
  //
  // 为什么是原生视图：浏览器内容是一个 WebContentsView，永远画在 DOM 之上，所以面板里的
  // 任何 DOM 遮罩都盖不住它（同 §4.5 的冻结方案）。做法是再加一层**背景透明的
  // WebContentsView**，铺在浏览器视图正上方；页面本身不受任何影响（不进 snapshot、
  // 不进截图、拾取也看不到它）。
  //
  // 用户点一下就接管：遮罩页在 pointerdown（捕获阶段）打一条 console 标记，
  // 主进程据此判定「用户接管」，随即撤下遮罩并让后续工具调用停手。

  /**
   * One agent tool call starts.
   *
   * It does **not** decide on its own whether the marker shows: the marker follows the whole turn
   * ({@link veilShouldBeUp}), so consecutive calls never blink it. All this does is record the call,
   * refresh the label and (re)arm the safety net.
   */
  beginAgentActivity(toolName: string): void {
    if (!shouldShowAgentVeil(toolName)) return
    this.turnTouched = true
    this.agentCalls += 1
    this.veilLabelText = veilLabel(toolName)
    this.clearLinger()
    this.armVeilWatchdog()
    this.refreshVeil()
  }

  /**
   * One agent tool call ended.
   *
   * The marker is *not* lowered here — see {@link veilShouldBeUp}. This only decides how long to hold
   * it when nothing else does: the anti-blink minimum for a very short call, plus a linger for the case
   * where DSH's turn status is unavailable.
   */
  endAgentActivity(): void {
    if (this.agentCalls > 0) this.agentCalls -= 1
    if (this.agentCalls > 0) return
    this.clearVeilWatchdog()
    // A running turn that has touched this browser keeps the marker exactly as it is.
    if (this.turnRunning === true && this.turnTouched) return
    const minimum = Math.max(0, MIN_VEIL_MS - (Date.now() - this.veilShownAt))
    const hold = this.turnRunning === undefined ? VEIL_LINGER_MS : 0
    this.startLinger(Math.max(minimum, hold))
  }

  /**
   * Keep the marker up for `ms`, then re-evaluate.
   *
   * A new call cancels it (`beginAgentActivity`), which is why this replaces the old per-call hide
   * timer: consecutive calls must not blink the marker.
   */
  private startLinger(ms: number): void {
    this.clearLinger()
    if (ms <= 0) {
      this.refreshVeil()
      return
    }
    this.lingerUntil = Date.now() + ms
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = undefined
      this.lingerUntil = 0
      this.refreshVeil()
    }, ms)
  }

  private clearLinger(): void {
    if (this.lingerTimer !== undefined) {
      clearTimeout(this.lingerTimer)
      this.lingerTimer = undefined
    }
    this.lingerUntil = 0
  }

  /**
   * Arm the "a call may not be in flight any more" timer.
   *
   * Re-armed on every `begin`, so it measures "no new call for AGENT_VEIL_MAX_MS" rather than the
   * length of one call: a long `wait`/`snapshot` sequence keeps its marker, while a marker whose
   * call vanished (process killed, transport aborted before the `finally` ran) is dropped.
   */
  private armVeilWatchdog(): void {
    this.clearVeilWatchdog()
    this.veilWatchdog = setTimeout(() => {
      this.veilWatchdog = undefined
      if (this.agentCalls === 0) return
      this.options.log(`遮罩已持续 ${String(Math.round(AGENT_VEIL_MAX_MS / 1000))} 秒没有新的调用：判定调用已中断，自动撤下遮罩`)
      this.agentCalls = 0
      this.turnTouched = false
      this.clearLinger()
      this.hideVeil()
    }, AGENT_VEIL_MAX_MS)
  }

  private clearVeilWatchdog(): void {
    if (this.veilWatchdog !== undefined) {
      clearTimeout(this.veilWatchdog)
      this.veilWatchdog = undefined
    }
  }

  /** The user clicked the page area: stop driving, hide the veil, tell the panel. */
  takeoverByUser(): BrowserCommandResult {
    // Always make sure the veil is down — even when the takeover already happened, because
    // anything (a finishing navigate, a resize) could have put it back on screen meanwhile, and
    // the click that reaches us is the user telling us they still cannot see the page.
    const wasDriving = this.userDriving
    this.agentCalls = 0
    this.turnTouched = false
    this.clearLinger()
    this.clearVeilWatchdog()
    this.userDriving = true
    this.hideVeil()
    if (wasDriving) {
      // A click that reaches the veil while already taken over still counts as the user working.
      this.noteUserActivity()
      return { ok: true, state: this.state() }
    }
    this.scheduleAutoRelease()
    this.options.log(`用户点击浏览器：已接管，助手正在等待（${String(this.autoReleaseSeconds)} 秒无操作后自动交还）`)
    this.options.onControlChange?.({ state: 'taken', reason: 'user-click', autoReleaseSeconds: this.autoReleaseSeconds, agentActive: this.agentCalls > 0 })
    this.push()
    return { ok: true, state: this.state() }
  }

  /**
   * Hand the browser back to the agent — from the panel button, or automatically once the user
   * stopped working. Any tool call waiting for control continues from here.
   */
  releaseToAgent(reason: 'panel' | 'auto-idle' = 'panel'): BrowserCommandResult {
    if (!this.userDriving) return { ok: true, state: this.state() }
    this.userDriving = false
    this.clearAutoRelease()
    const waiters = this.controlWaiters
    this.controlWaiters = []
    if (reason === 'auto-idle') {
      this.options.log(`用户已停止操作 ${String(this.autoReleaseSeconds)} 秒：控制权自动交还给助手`)
    } else {
      this.options.log('用户已把浏览器控制权交还给助手')
    }
    this.options.onControlChange?.({
      state: 'released',
      reason: reason === 'auto-idle' ? 'auto-idle' : 'panel',
      autoReleaseSeconds: this.autoReleaseSeconds,
      // Same rule as the native marker itself, so the panel's「助手正在操作」bar and the veil agree:
      // both follow the *turn*, and neither blinks between two calls.
      agentActive: this.veilShouldBeUp(),
    })
    for (const notifyWaiter of waiters) notifyWaiter()
    // The agent may still be mid-call (it was parked on the user): put the marker back so the user can
    // see that it resumed.
    this.refreshVeil()
    this.push()
    return { ok: true, state: this.state() }
  }

  /**
   * Wait until the user hands control back.
   *
   * Called by the tool layer instead of failing immediately: the agent should not have to notice a
   * refusal and repeat itself. Resolves `'released'` on hand-back, `'timeout'` after the cap (so a
   * call can still answer the model), or `'aborted'` when the transport cancels.
   */
  async waitForControl(signal?: AbortSignal, timeoutSeconds: number = CONTROL_WAIT_SECONDS): Promise<ControlWaitOutcome> {
    if (!this.userDriving) return 'released'
    if (signal?.aborted === true) return 'aborted'
    return await new Promise<ControlWaitOutcome>((resolve) => {
      let settled = false
      const finish = (outcome: ControlWaitOutcome): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(outcome)
      }
      const onAbort = (): void => { finish('aborted') }
      const timer = setTimeout(() => { finish('timeout') }, Math.max(1, timeoutSeconds) * 1000)
      signal?.addEventListener('abort', onAbort, { once: true })
      this.controlWaiters.push(() => { finish('released') })
    })
  }

  /** The user is working in the browser: push the auto-release deadline out. */
  noteUserActivity(): void {
    if (!this.userDriving) return
    this.scheduleAutoRelease()
  }

  /** Whether the panel is on screen right now (the authority on placing the native view). */
  get panelVisibleNow(): boolean {
    return this.panelVisible
  }

  /** Epoch ms when control is handed back automatically (0 while the agent has it). */
  get controlAutoReleaseAt(): number {
    return this.autoReleaseAt
  }

  setAutoReleaseSeconds(seconds: unknown): void {
    this.autoReleaseSeconds = clampAutoReleaseSeconds(seconds)
    if (this.userDriving) this.scheduleAutoRelease()
  }

  private scheduleAutoRelease(): void {
    this.clearAutoRelease()
    this.autoReleaseAt = nextAutoReleaseAt(Date.now(), this.autoReleaseSeconds)
    this.autoReleaseTimer = setTimeout(() => {
      this.autoReleaseTimer = undefined
      this.releaseToAgent('auto-idle')
    }, this.autoReleaseSeconds * 1000)
    // Push so the panel can show the countdown; throttled, because activity arrives in bursts.
    const now = Date.now()
    if (now - this.lastAutoReleasePush > 500) {
      this.lastAutoReleasePush = now
      this.push()
    }
  }

  private clearAutoRelease(): void {
    if (this.autoReleaseTimer !== undefined) {
      clearTimeout(this.autoReleaseTimer)
      this.autoReleaseTimer = undefined
    }
    this.autoReleaseAt = 0
  }

  /** Install the page-side activity listener (idempotent; re-run after each navigation). */
  private async installActivityProbe(): Promise<void> {
    const contents = this.contents
    if (contents === undefined || contents.isDestroyed()) return
    try {
      // Not `this.script()`: the probe must install even on a page we would refuse to script
      // (it is the thing that keeps a takeover alive), and it must never throw into callers.
      await contents.executeJavaScript(ACTIVITY_PROBE_SCRIPT, true)
    } catch {
      // A page that cannot host the probe just means keyboard-only activity detection.
    }
  }

  /** Whether the user currently holds the browser (tools refuse while true). */
  get drivingByUser(): boolean {
    return this.userDriving
  }

  /** Whether any agent tool call is in flight (the veil should be up). */
  get agentBusy(): boolean {
    return this.agentCalls > 0
  }

  private async showVeil(label: string): Promise<void> {
    // Already up: only the label changed. Rewriting the text beats reloading the document — a reload
    // happens once per tool call and is itself a visible flash.
    if (this.veilUp && this.veil !== undefined) {
      await this.setVeilLabel(label)
      this.syncVeil(this.visibleState ? this.lastPlacedRect() : BROWSER_HIDDEN_RECT)
      return
    }
    const view = await this.ensureVeil(label)
    if (view === undefined) return
    // The call that asked for this may already be over (the first veil of a conversation takes a
    // moment to build). Showing it now would leave it up with nobody left to take it down — the
    // reported "agent 执行完了遮罩没关闭，切走再切回来才消失".
    if (!this.veilShouldBeUp()) {
      this.hideVeil()
      return
    }
    const newlyUp = !this.veilUp
    // Re-adding moves it to the top: a new browser view (a new tab) is added above it otherwise.
    const window = this.options.window()
    if (window !== undefined && !window.isDestroyed()) {
      try { window.contentView.addChildView(view) } catch { /* already a child, or window gone */ }
    }
    this.veilUp = true
    if (newlyUp) this.veilShownAt = Date.now()
    // Same rule as every other placement: the veil is up only while this view is placed.
    this.syncVeil(this.visibleState ? this.lastPlacedRect() : BROWSER_HIDDEN_RECT)
    if (newlyUp) {
      this.options.log(`遮罩已显示（${this.veilLabelText}）`)
      this.push()
    }
  }

  /**
   * Rewrite the veil's pill text **in place**.
   *
   * The veil document ships a tiny `window.__dshVeilLabel`, so a label change costs one script call
   * instead of a document reload (which flashes the whole layer).
   */
  private async setVeilLabel(label: string): Promise<void> {
    const contents = this.veil?.webContents
    if (contents === undefined || contents.isDestroyed()) return
    try {
      await contents.executeJavaScript(`window.__dshVeilLabel && window.__dshVeilLabel(${JSON.stringify(label)})`, true)
    } catch {
      // The veil page may still be loading; `ensureVeil` put the label in the document already.
    }
  }

  /** Take the marker down. Parking it while the view is parked is `syncVeil`'s job, not this one. */
  private hideVeil(): void {
    const wasUp = this.veilUp
    this.veilUp = false
    // Hiding is parking off-screen: a WebContentsView has no setVisible(false).
    this.syncVeil(BROWSER_HIDDEN_RECT)
    if (wasUp) {
      this.options.log('遮罩已隐藏')
      this.push()
    }
  }

  private placeVeil(rect: BrowserRect): void {
    const view = this.veil
    if (view === undefined) return
    try {
      view.setBounds(rect)
    } catch { /* the view may already be gone */ }
  }

  /** The rect the surface is currently shown at (the veil mirrors it). */
  private lastPlacedRect(): BrowserRect {
    const window = this.options.window()
    if (window === undefined || window.isDestroyed()) return BROWSER_HIDDEN_RECT
    const content = window.getContentBounds()
    const placed = clampBrowserRect(this.lastRect, { width: content.width, height: content.height })
    return isUsableBrowserRect(placed) ? placed : BROWSER_HIDDEN_RECT
  }

  private async ensureVeil(label: string): Promise<WebContentsView | undefined> {
    if (this.veil !== undefined) {
      // A new label for an existing veil: rewrite its document (a data URL reload is instant).
      try {
        await this.veil.webContents.loadURL(overlayUrl(label))
      } catch { /* keep the previous document rather than losing the veil entirely */ }
      return this.veil
    }
    if (this.veilReady !== undefined) {
      const ready = await this.veilReady
      if (ready !== undefined && !ready.webContents.isDestroyed()) {
        try { await ready.webContents.loadURL(overlayUrl(label)) } catch { /* ignore */ }
      }
      return ready
    }
    const window = this.options.window()
    if (window === undefined || window.isDestroyed()) return undefined
    this.veilReady = (async (): Promise<WebContentsView | undefined> => {
      try {
        const view = new WebContentsView({
          webPreferences: {
            // The veil is decoration with one job: report a click. Nothing else is allowed.
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            // Never let the veil's page navigate anywhere or spawn windows.
            webviewTag: false,
            spellcheck: false,
          },
        })
        view.setBackgroundColor('#00000000')
        view.webContents.on('console-message', (details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>) => {
          if (isTakeoverMessage(details.message)) this.takeoverByUser()
        })
        view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        view.webContents.on('will-navigate', (event) => { event.preventDefault() })
        await view.webContents.loadURL(overlayUrl(label))
        this.veil = view
        return view
      } catch (error) {
        this.options.log(`遮罩创建失败（不影响浏览）：${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    })()
    return await this.veilReady
  }

  /** Tear the veil down with the view (window close / tab close). */
  private destroyVeil(): void {
    this.clearLinger()
    const veil = this.veil
    this.veil = undefined
    this.veilReady = undefined
    this.veilUp = false
    if (veil === undefined) return
    try {
      const window = this.options.window()
      if (window !== undefined && !window.isDestroyed()) window.contentView.removeChildView(veil)
    } catch { /* already detached */ }
    try {
      veil.webContents.close()
    } catch { /* already gone */ }
  }

  /** Load a typed address. Returns the rejection reason for the panel to display. */
  navigate(raw: unknown): BrowserCommandResult {
    if (typeof raw !== 'string') return { ok: false, reason: 'navigate 参数不合法' }
    const created = this.ensureCreated()
    if (!created.ok) return created
    const parsed = normalizeAddress(raw, this.options.applicationOrigin())
    if (!parsed.ok) return { ok: false, reason: parsed.reason }
    const contents = this.view?.webContents
    if (contents === undefined || contents.isDestroyed()) return { ok: false, reason: '浏览器视图不可用' }
    this.error = null
    void contents.loadURL(parsed.url).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      // ERR_ABORTED (a superseded load) is normal while typing in the address bar.
      if (!message.includes('ERR_ABORTED')) this.options.log(`侧边栏浏览器导航失败：${message}`)
    })
    return { ok: true, state: this.state() }
  }

  back(): BrowserCommandResult {
    const contents = this.contents
    if (contents === undefined) return { ok: false, reason: '浏览器视图不可用' }
    if (!contents.navigationHistory.canGoBack()) return { ok: false, reason: '没有上一页' }
    contents.navigationHistory.goBack()
    return { ok: true }
  }

  forward(): BrowserCommandResult {
    const contents = this.contents
    if (contents === undefined) return { ok: false, reason: '浏览器视图不可用' }
    if (!contents.navigationHistory.canGoForward()) return { ok: false, reason: '没有下一页' }
    contents.navigationHistory.goForward()
    return { ok: true }
  }

  reload(): BrowserCommandResult {
    const contents = this.contents
    if (contents === undefined) return { ok: false, reason: '浏览器视图不可用' }
    this.error = null
    contents.reload()
    return { ok: true }
  }

  /** Focus the page (the panel clicked into its stage). */
  focus(): BrowserCommandResult {
    const contents = this.contents
    if (contents === undefined) return { ok: false, reason: '浏览器视图不可用' }
    contents.focus()
    return { ok: true }
  }

  /** Record one main-frame visit; consecutive reloads of the same URL collapse into one row. */
  private recordVisit(url: string): void {
    if (url === '') return
    const last = this.visits.at(-1)
    if (last !== undefined && last.url === url) {
      this.visits[this.visits.length - 1] = { url, title: this.contents?.getTitle() ?? last.title, at: Date.now() }
      return
    }
    this.visits.push({ url, title: this.contents?.getTitle() ?? '', at: Date.now() })
    if (this.visits.length > MAX_VISITS) this.visits.splice(0, this.visits.length - MAX_VISITS)
  }

  /** Address-bar history for this tab, newest first. */
  history(): BrowserCommandResult {
    return { ok: true, entries: [...this.visits].reverse() }
  }

  /** Drop one URL (or everything) from this tab's history. */
  clearHistory(url?: string): BrowserCommandResult {
    if (url === undefined) this.visits.length = 0
    else for (let index = this.visits.length - 1; index >= 0; index -= 1) {
      if (this.visits[index]?.url === url) this.visits.splice(index, 1)
    }
    return { ok: true, entries: [...this.visits].reverse() }
  }

  /**
   * Freeze the page into a data URL so a DOM menu in the panel can be drawn over it.
   *
   * A `WebContentsView` is a native surface: no DOM in the panel can paint above it. DSH's own
   * menus work the same way one-code solves it — capture the view, park the native surface, and
   * let the panel render the still image underneath its menu.
   */
  async freeze(): Promise<BrowserCommandResult> {
    const contents = this.contents
    if (contents === undefined) return { ok: false, reason: '浏览器视图不可用' }
    // Already frozen (a second menu opened over the first): hand back the snapshot we have.
    if (blocksSurfaceShow(this.freezeState)) {
      return this.lastFrame === undefined ? { ok: true, frozen: true } : { ok: true, frozen: true, frame: this.lastFrame }
    }
    // Nothing is on screen yet (no page, or the tab is parked): there is no native surface to
    // cover, so the menu can be drawn directly. Freezing here would only park nothing, produce
    // no frame, and leave the panel showing a misleading "paused" hint.
    if (!this.visibleState) {
      return { ok: true, frozen: false }
    }
    try {
      // A capture can fail (hidden window, mid-navigation, DevTools busy). The surface is
      // parked either way — a menu the page paints over is unusable — and the panel falls back
      // to a plain hint when there is no frame to show.
      let frame: string | undefined
      try {
        const image = await contents.capturePage()
        if (!image.isEmpty()) frame = `data:image/png;base64,${image.toPNG().toString('base64')}`
      } catch (error) {
        this.options.log(`冻结时截图失败：${error instanceof Error ? error.message : String(error)}`)
      }
      this.freezeState = beginFreeze(this.visibleState)
      // Park the surface *without* going through hide(): hide() forgets the freeze on purpose.
      this.visibleState = false
      this.applyBounds(BROWSER_HIDDEN_RECT)
      if (frame !== undefined) this.lastFrame = frame
      this.options.log(`冻结视图（帧=${frame === undefined ? '无' : String(frame.length)}B）`)
      return this.lastFrame === undefined ? { ok: true, frozen: true } : { ok: true, frozen: true, frame: this.lastFrame }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Put the native surface back after a menu closes — but only if it was on screen before. */
  unfreeze(): BrowserCommandResult {
    const ended = endFreeze(this.freezeState)
    this.freezeState = ended.next
    this.lastFrame = undefined
    if (!ended.restore) {
      this.options.log('解冻视图：无需恢复（冻结时本就不可见）')
      return { ok: true }
    }
    const shown = this.show()
    this.options.log(`解冻视图：${this.visibleState ? '已恢复' : '恢复失败'}（rect=${String(this.lastRect.width)}×${String(this.lastRect.height)}，ok=${String(shown.ok)}）`)
    // A menu was open while a call was running: the veil went down with the surface, put it back.
    this.refreshVeil()
    return shown
  }

  /** Browser-owned preferences, read from the shell's userData. */
  prefs(): BrowserCommandResult {
    return { ok: true, prefs: this.options.prefs.read() }
  }

  /** Merge a preferences patch and persist it. */
  setPrefs(patch: unknown): BrowserCommandResult {
    const current = this.options.prefs.read() ?? DEFAULT_BROWSER_PREFS
    const merged = mergeBrowserPrefs(current, patch)
    if (!merged.ok) return { ok: false, reason: merged.reason }
    try {
      this.options.prefs.write(merged.prefs)
    } catch (error) {
      return { ok: false, reason: `偏好写入失败：${error instanceof Error ? error.message : String(error)}` }
    }
    return { ok: true, prefs: merged.prefs }
  }

  /** Clear the browser partition's HTTP cache (cookies stay: logins survive). */
  async clearCache(): Promise<BrowserCommandResult> {
    try {
      await this.browserSession().clearCache()
      this.options.log('侧边栏浏览器：已清空缓存')
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Clear the browser partition's cookies and site storage (a full sign-out). */
  async clearCookies(): Promise<BrowserCommandResult> {
    try {
      await this.browserSession().clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] })
      this.options.log('侧边栏浏览器：已清空 Cookie 与站点数据')
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Arm or disarm element picking.
   *
   * The injected script returns a promise that settles on the first pick (or on Esc), so
   * `executeJavaScript` hands us the pick directly — no preload, no popup, no console parsing.
   * Each arming gets a fresh nonce, so a page cannot forge a pick (see `browser-picker.ts`).
   */
  async setPickMode(enabled: boolean): Promise<BrowserCommandResult> {
    const created = this.ensureCreated()
    if (!created.ok) return created
    try {
      if (!enabled) {
        this.pickNonce = undefined
        await this.script<unknown>(PICKER_REMOVE_SCRIPT)
        this.push()
        return { ok: true, state: this.state() }
      }
      const nonce = randomBytes(16).toString('hex')
      this.pickNonce = nonce
      this.deliveredPicks.clear()
      const pending = this.script<unknown>(buildPickerScript(nonce))
      // Not awaited: the promise settles when the user picks (or presses Esc).
      void pending.then(
        (value) => {
          // `null` means the page-side picker removed itself; the sentinel means this arming
          // was a no-op because one was already active (never treat that as "disarmed").
          if (value === null) {
            this.disarmPick()
            return
          }
          if (value === PICKER_ALREADY_ACTIVE) return
          this.acceptPick(asPickedElement(value, nonce))
        },
        (error: unknown) => {
          // The view went away (tab closed, page reloaded): not an error worth surfacing.
          this.options.log(`元素拾取已结束：${error instanceof Error ? error.message : String(error)}`)
          this.disarmPick()
        },
      )
      this.push()
      return { ok: true, state: this.state() }
    } catch (error) {
      this.pickNonce = undefined
      return { ok: false, reason: `元素拾取切换失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** The page-side picker removed itself (Esc): mirror that in the panel's toggle. */
  private disarmPick(): void {
    if (this.pickNonce === undefined) return
    this.pickNonce = undefined
    this.push()
  }

  /**
   * Deliver one pick to the panel, at most once per element per arming.
   *
   * Both transports can report the same first pick (the promise settles *and* the console line
   * fires); the second arrival is dropped rather than shown twice.
   */
  private acceptPick(element: PickedElement | undefined): void {
    if (element === undefined || this.pickNonce === undefined) return
    const signature = pickSignature(element)
    if (this.deliveredPicks.has(signature)) return
    this.deliveredPicks.add(signature)
    this.options.log(`拾取元素：${element.selector}`)
    this.options.onPick(element)
  }

  /**
   * Apply a device preset through CDP (Chromium's own emulation), or clear it for `desktop`.
   * Emulation lives on the debugger session, so it is torn down with the view.
   */
  async setDevice(preset: DevicePreset): Promise<BrowserCommandResult> {
    this.device = preset
    this.deviceRotated = false
    if (preset === 'desktop') {
      this.customDeviceSize = undefined
    } else {
      const spec = DEVICE_SPECS[preset]
      this.customDeviceSize = { width: spec.width, height: spec.height }
    }
    return await this.applyDevice()
  }

  /**
   * Custom viewport and/or rotation on top of the current preset: what the panel's device row
   * drives. Rotation swaps the effective width/height and tells Chromium the screen turned, so
   * pages that read `orientation` behave like a flipped phone.
   */
  async setDeviceSpec(patch: { preset?: unknown; width?: unknown; height?: unknown; rotate?: unknown }): Promise<BrowserCommandResult> {
    if (patch.preset !== undefined) {
      if (!isDevicePreset(patch.preset)) {
        return { ok: false, reason: 'device 参数不合法' }
      }
      return await this.setDevice(patch.preset as DevicePreset)
    }
    if (patch.width !== undefined || patch.height !== undefined) {
      const base = this.customDeviceSize ?? this.presetSize()
      const size = clampDeviceSize(
        patch.width === undefined ? base.width : Number(patch.width),
        patch.height === undefined ? base.height : Number(patch.height),
      )
      if (size === undefined) return { ok: false, reason: '设备宽高不合法' }
      this.customDeviceSize = size
      if (this.device === 'desktop') this.device = 'iphone'
    }
    if (patch.rotate !== undefined) {
      if (typeof patch.rotate !== 'boolean') return { ok: false, reason: 'rotate 参数不合法' }
      this.deviceRotated = patch.rotate
    }
    return await this.applyDevice()
  }

  /** The preset's own size, or the fallback for `desktop`. */
  private presetSize(): { width: number; height: number } {
    return presetSize(this.device)
  }

  /**
   * Push the current preset + custom size + rotation to CDP. `desktop` with no custom size clears
   * the override entirely (the real window size comes back).
   */
  private async applyDevice(): Promise<BrowserCommandResult> {
    const created = this.ensureCreated()
    if (!created.ok) return created
    const preset = this.device
    const size = this.customDeviceSize
    const rotated = this.deviceRotated
    const applied = await this.withDebugger(async (debuggerSession) => {
      if (preset === 'desktop' && size === undefined) {
        await debuggerSession.sendCommand('Emulation.clearDeviceMetricsOverride')
        await debuggerSession.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: false })
        await debuggerSession.sendCommand('Emulation.setUserAgentOverride', { userAgent: this.defaultUserAgent })
        return true
      }
      const spec = preset === 'desktop' ? undefined : DEVICE_SPECS[preset]
      const base = size ?? { width: spec?.width ?? 1280, height: spec?.height ?? 800 }
      await debuggerSession.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: rotated ? base.height : base.width,
        height: rotated ? base.width : base.height,
        deviceScaleFactor: spec?.deviceScaleFactor ?? 1,
        mobile: spec !== undefined,
        ...rotated
          ? { screenOrientation: { type: 'landscapePrimary', angle: 90 } }
          : { screenOrientation: { type: 'portraitPrimary', angle: 0 } },
      })
      if (spec === undefined) {
        await debuggerSession.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: false })
        await debuggerSession.sendCommand('Emulation.setUserAgentOverride', { userAgent: this.defaultUserAgent })
      } else {
        await debuggerSession.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
        await debuggerSession.sendCommand('Emulation.setUserAgentOverride', {
          userAgent: spec.userAgent,
          platform: spec.platform,
        })
      }
      return true
    })
    if (applied !== true) return { ok: false, reason: '设备模拟不可用（CDP 调试器未就绪）' }
    this.push()
    return { ok: true, state: this.state() }
  }

  /** Probe the view for the panel's readiness banner. */
  state(): BrowserViewState {
    if (!this.created) return this.emptyState()
    const contents = this.view?.webContents
    if (contents === undefined || contents.isDestroyed()) return this.emptyState()
    const size = this.effectiveDeviceSize()
    return {
      url: contents.getURL(),
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      device: this.device,
      deviceWidth: size.width,
      deviceHeight: size.height,
      deviceRotated: this.deviceRotated,
      picking: this.pickNonce !== undefined,
      // Same rule as the native marker itself, so the panel's「助手正在操作」bar and the veil agree:
      // both follow the *turn*, and neither blinks between two calls.
      agentActive: this.veilShouldBeUp(),
      userDriving: this.userDriving,
      autoReleaseAt: this.autoReleaseAt,
      error: this.error,
    }
  }

  /** The view-less state: same shape, so the panel never has to special-case it. */
  private emptyState(): BrowserViewState {
    const size = this.effectiveDeviceSize()
    return {
      ...EMPTY_STATE,
      device: this.device,
      deviceWidth: size.width,
      deviceHeight: size.height,
      deviceRotated: this.deviceRotated,
      picking: this.pickNonce !== undefined,
      // Same rule as the native marker itself, so the panel's「助手正在操作」bar and the veil agree:
      // both follow the *turn*, and neither blinks between two calls.
      agentActive: this.veilShouldBeUp(),
      userDriving: this.userDriving,
      autoReleaseAt: this.autoReleaseAt,
      error: this.error,
    }
  }

  /** Effective emulated viewport in CSS pixels (0x0 = no override). */
  private effectiveDeviceSize(): { width: number; height: number } {
    return effectiveDeviceSize(this.device, this.customDeviceSize, this.deviceRotated)
  }

  private push(): void {
    this.options.notify(this.state())
  }

  /** Drop the view entirely (panel tab closed). A later call may create a fresh one. */
  destroy(): void {
    this.destroyVeil()
    const view = this.view
    this.view = undefined
    this.visibleState = false
    this.error = null
    this.lastRect = BROWSER_HIDDEN_RECT
    this.indexToSelector = new Map()
    this.debuggerReady = undefined
    this.debuggerQueue = Promise.resolve()
    if (view === undefined) return
    this.detach(view)
    this.options.log('侧边栏浏览器视图已销毁')
  }

  /** Final teardown (window closing): the panel's tab count no longer matters. */
  shutdown(): void {
    this.retired = true
    this.destroy()
  }

  private detach(view: WebContentsView): void {
    const window = this.options.window()
    try {
      if (view.webContents.debugger.isAttached()) view.webContents.debugger.detach()
    } catch {
      // The debugger is gone with the view; nothing to release.
    }
    try {
      if (window !== undefined && !window.isDestroyed()) window.contentView.removeChildView(view)
    } catch {
      // The window may already be gone; the view dies with it.
    }
    try {
      if (!view.webContents.isDestroyed()) view.webContents.close()
    } catch {
      // Same: nothing to do when the process is already torn down.
    }
  }

  // ── agent tools (M2) ─────────────────────────────────────────────────────
  //
  // The model drives the same view the user sees. Reads and interactions go through the
  // vendored page-injection scripts (one-code, MIT) over `executeJavaScript`; clicks and
  // keystrokes go through CDP so they hit Chromium's real input pipeline without stealing
  // focus, with a programmatic fallback when the debugger is unavailable (DevTools open,
  // or a strict page).

  /** `snapshot` index -> stable selector, so click/type/select can take an index handle. */
  private indexToSelector = new Map<number, string>()
  private debuggerReady: Promise<Electron.Debugger | undefined> | undefined
  /** Serialises CDP commands: attach/send/detach must not interleave. */
  private debuggerQueue: Promise<unknown> = Promise.resolve()

  /** Whether this tab's surface is currently placed on screen (the tab picker reads it). */
  get visible(): boolean {
    return this.visibleState
  }

  /** Run one page-injection script in the page's main world. */
  private async script<T>(source: string): Promise<T> {
    const contents = this.contents
    if (contents === undefined) throw new Error('浏览器视图不可用')
    // A view that was never navigated has no document to script against, and
    // `executeJavaScript` simply never settles there — which used to hang a tool call until the
    // transport gave up. Say what to do instead.
    if (!this.hasDocument()) throw new Error('页面还没有加载：先用 navigate 打开一个网址')
    // Even on a real page the renderer can wedge (an infinite page script, a dead render process).
    return await withTimeout(
      contents.executeJavaScript(source, true) as Promise<T>,
      SCRIPT_TIMEOUT_MS,
      '页面脚本执行超时（页面可能卡住了，试试 reload）',
    )
  }

  /** Whether the view holds a real document (`about:blank` is not one). */
  private hasDocument(): boolean {
    const contents = this.contents
    if (contents === undefined) return false
    const url = contents.getURL()
    return url !== '' && url !== 'about:blank'
  }

  /**
   * Attach the debugger once, then serialise every command through it. Returns `undefined`
   * when CDP is not available, which callers treat as "use the fallback path".
   */
  private async withDebugger<T>(run: (debuggerSession: Electron.Debugger) => Promise<T>): Promise<T | undefined> {
    if (this.debuggerReady === undefined) {
      this.debuggerReady = Promise.resolve().then(() => {
        const contents = this.contents
        if (contents === undefined) return undefined
        try {
          const session = contents.debugger
          session.attach('1.3')
          return session
        } catch (error) {
          this.options.log(`浏览器 CDP 不可用，改用脚本回退：${error instanceof Error ? error.message : String(error)}`)
          return undefined
        }
      })
    }
    const session = await this.debuggerReady
    if (session === undefined) return undefined
    const next = this.debuggerQueue.then(async () => await run(session))
    this.debuggerQueue = next.then(() => undefined, () => undefined)
    try {
      return await next
    } catch (error) {
      this.options.log(`浏览器 CDP 命令失败：${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  private async waitForLoad(timeoutMs: number): Promise<{ ok: boolean; url: string; title: string; error: string }> {
    const contents = this.contents
    if (contents === undefined) return { ok: false, url: '', title: '', error: '浏览器视图不可用' }
    const read = (): { url: string; title: string } => ({ url: contents.getURL(), title: contents.getTitle() })
    if (!contents.isLoading()) return { ok: true, ...read(), error: '' }
    return await new Promise((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let poll: ReturnType<typeof setInterval> | undefined
      const finish = (value: { ok: boolean; url: string; title: string; error: string }): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        if (poll !== undefined) clearInterval(poll)
        contents.off('did-finish-load', onFinish)
        contents.off('did-fail-load', onFail)
        contents.off('did-stop-loading', onStop)
        resolve(value)
      }
      const onFinish = (): void => { finish({ ok: true, ...read(), error: '' }) }
      const onFail = (_event: Electron.Event, code: number, description: string, _url: string, isMainFrame: boolean): void => {
        if (!isMainFrame || code === -3) return
        finish({ ok: false, ...read(), error: describeLoadFailure(code, description) })
      }
      /**
       * `did-finish-load` fires **once per main-frame load**, and the caller's `loadURL` already
       * resolved on it — so attaching this listener a moment later could wait for an event that will
       * never come again. Measured on a real page: every `navigate` took exactly 15 s (the whole
       * timeout) while the page had been ready almost immediately, which also held the agent's veil
       * up for 15 s per call. `did-stop-loading` plus a cheap poll on `isLoading()` closes the race.
       */
      const onStop = (): void => { if (!contents.isLoading()) finish({ ok: true, ...read(), error: '' }) }
      timer = setTimeout(() => { finish({ ok: true, ...read(), error: '' }) }, timeoutMs)
      poll = setInterval(() => { if (!contents.isLoading()) finish({ ok: true, ...read(), error: '' }) }, 120)
      contents.once('did-finish-load', onFinish)
      contents.on('did-fail-load', onFail)
      contents.on('did-stop-loading', onStop)
    })
  }

  async toolNavigate(
    address: string,
    options: { show: boolean },
  ): Promise<HostResult<{ url: string; title: string; visible: boolean }>> {
    const created = this.ensureCreated()
    if (!created.ok) return { ok: false, error: created.reason ?? '浏览器不可用' }
    const parsed = normalizeAddress(address, this.options.applicationOrigin())
    if (!parsed.ok) return { ok: false, error: parsed.reason }
    const contents = this.contents
    if (contents === undefined) return { ok: false, error: '浏览器视图不可用' }
    this.error = null
    try {
      await contents.loadURL(parsed.url)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('ERR_ABORTED')) return { ok: false, error: message }
    }
    // The panel may or may not be open: `show('agent')` only takes effect while it is, so a page
    // the user cannot see still loads in the background instead of covering the UI.
    if (options.show) this.show('agent')
    const loaded = await this.waitForLoad(15_000)
    if (!loaded.ok && loaded.error !== '') return { ok: false, error: loaded.error }
    this.push()
    return { ok: true, url: loaded.url, title: loaded.title, visible: this.visibleState }
  }

  toolHistory(action: 'back' | 'forward' | 'reload'): HostResult<{ url: string; title: string }> {
    const result = action === 'back' ? this.back() : action === 'forward' ? this.forward() : this.reload()
    if (!result.ok) return { ok: false, error: result.reason ?? '操作失败' }
    const current = this.state()
    return { ok: true, url: current.url, title: current.title }
  }

  async toolSnapshot(): Promise<HostResult<{ data: SnapshotData }>> {
    try {
      const raw = await this.script<Partial<SnapshotData>>(SNAPSHOT_SCRIPT)
      if (raw === null || typeof raw !== 'object') return { ok: false, error: '页面没有返回快照数据' }
      const interactive = Array.isArray(raw.interactive) ? raw.interactive : []
      const data: SnapshotData = {
        url: typeof raw.url === 'string' ? raw.url : '',
        title: typeof raw.title === 'string' ? raw.title : '',
        readyState: typeof raw.readyState === 'string' ? raw.readyState : '',
        html: typeof raw.html === 'string' ? raw.html : '',
        bodyText: typeof raw.bodyText === 'string' ? raw.bodyText : '',
        interactive,
      }
      // Index handles are only valid for the snapshot they came from.
      this.indexToSelector = new Map(interactive.map((element) => [element.index, element.selector]))
      return { ok: true, data }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Resolve an index handle (preferred) or a raw selector into a CSS selector. */
  private resolveHandle(index: number | undefined, selector: string | undefined): HostResult<{ selector: string }> {
    if (index !== undefined) {
      const mapped = this.indexToSelector.get(index)
      if (mapped === undefined) {
        return { ok: false, error: `元素索引 ${String(index)} 不在当前快照中（页面可能已变化，请重新调用 snapshot）` }
      }
      return { ok: true, selector: mapped }
    }
    if (selector !== undefined && selector.trim() !== '') return { ok: true, selector }
    return { ok: false, error: '需要 index 或 selector 之一' }
  }

  async toolClick(input: {
    index?: number | undefined
    selector?: string | undefined
    coordinateX?: number | undefined
    coordinateY?: number | undefined
  }): Promise<HostResult<{ url: string; title: string; obscured?: { tag: string; text: string } }>> {
    const hasCoords = input.coordinateX !== undefined && input.coordinateY !== undefined
    if (!hasCoords) {
      const handle = this.resolveHandle(input.index, input.selector)
      if (!handle.ok) return handle
      try {
        const center = await this.script<{
          ok?: boolean
          x?: number
          y?: number
          /** `null` from the page script means "nothing covers the target". */
          obscured?: { tag: string; text: string } | null
          fallback?: boolean
          error?: string
        }>(buildElementCenterScript(handle.selector))
        if (center.fallback === true || center.ok !== true || typeof center.x !== 'number' || typeof center.y !== 'number') {
          // Zero-size or unstyled target: the programmatic click still reaches it.
          const click = await this.script<{ ok?: boolean; error?: string }>(buildClickScript(handle.selector))
          if (click.ok !== true) return { ok: false, error: click.error ?? '点击失败' }
        } else {
          const dispatched = await this.withDebugger(async (session) => {
            await dispatchBrowserClick(session, center.x as number, center.y as number)
            return true
          })
          if (dispatched !== true) {
            const click = await this.script<{ ok?: boolean; error?: string }>(buildClickScript(handle.selector))
            if (click.ok !== true) return { ok: false, error: click.error ?? '点击失败' }
          }
          // A null `obscured` means "nothing covered the target": only report a real obstruction,
          // otherwise the caller would read `.tag` off null (which used to fail *every* click).
          if (center.obscured !== undefined && center.obscured !== null) {
            await new Promise((resolve) => setTimeout(resolve, 400))
            const current = this.state()
            this.push()
            return { ok: true, url: current.url, title: current.title, obscured: center.obscured }
          }
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    } else {
      const point = { x: input.coordinateX as number, y: input.coordinateY as number }
      const dispatched = await this.withDebugger(async (session) => {
        await dispatchBrowserClick(session, point.x, point.y)
        return true
      })
      if (dispatched !== true) {
        return { ok: false, error: '坐标点击需要 CDP，但当前调试器不可用（请改用 index 或 selector）' }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 600))
    const current = this.state()
    this.push()
    return { ok: true, url: current.url, title: current.title }
  }

  async toolType(input: {
    index?: number | undefined
    selector?: string | undefined
    text: string
    clear?: boolean | undefined
  }): Promise<HostResult<{ url: string; title: string }>> {
    const handle = this.resolveHandle(input.index, input.selector)
    if (!handle.ok) return handle
    try {
      const result = await this.script<{ ok?: boolean; error?: string; url?: string; title?: string }>(
        buildTypeScript(handle.selector, input.text, input.clear !== false),
      )
      if (result.ok !== true) return { ok: false, error: result.error ?? '输入失败' }
      this.push()
      return { ok: true, url: result.url ?? '', title: result.title ?? '' }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async toolKeys(keys: string): Promise<HostResult<{ url: string; title: string }>> {
    const parsed = parseAccelerator(keys)
    if (parsed === undefined) return { ok: false, error: `无法识别的按键：${keys}` }
    const dispatched = await this.withDebugger(async (session) => {
      await dispatchBrowserKeys(session, parsed)
      return true
    })
    if (dispatched !== true) {
      const contents = this.contents
      if (contents === undefined) return { ok: false, error: '浏览器视图不可用' }
      // Fallback: Electron's own input pipeline (no synthetic key text for chords).
      const keyCode = fallbackKeyCode(parsed.key)
      if (keyCode === undefined) return { ok: false, error: '当前调试器不可用时只能发送普通按键' }
      contents.sendInputEvent({ type: 'keyDown', keyCode })
      contents.sendInputEvent({ type: 'keyUp', keyCode })
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
    const current = this.state()
    this.push()
    return { ok: true, url: current.url, title: current.title }
  }

  async toolScroll(input: {
    direction: 'up' | 'down'
    pages: number
    selector?: string | undefined
  }): Promise<HostResult<ScrollOutput>> {
    const pages = Math.max(0.1, Math.min(20, input.pages))
    const arg = input.selector === undefined
      ? { direction: input.direction, pages }
      : { direction: input.direction, pages, selector: input.selector }
    try {
      const result = await this.script<{ ok?: boolean; error?: string } & Partial<ScrollOutput>>(buildScrollScript(arg))
      if (result.ok !== true) return { ok: false, error: result.error ?? '滚动失败' }
      return {
        ok: true,
        scrollY: typeof result.scrollY === 'number' ? result.scrollY : 0,
        scrollHeight: typeof result.scrollHeight === 'number' ? result.scrollHeight : 0,
        viewport: typeof result.viewport === 'number' ? result.viewport : 0,
        url: result.url ?? '',
        title: result.title ?? '',
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async toolWait(input: {
    selector?: string | undefined
    text?: string | undefined
    seconds?: number | undefined
    timeoutSeconds?: number | undefined
  }): Promise<HostResult<{ url: string; title: string }>> {
    if (input.selector === undefined && input.text === undefined && input.seconds === undefined) {
      return { ok: false, error: '需要 selector、text 或 seconds 之一' }
    }
    if (input.seconds !== undefined) {
      const seconds = Math.max(0, Math.min(60, input.seconds))
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
      const current = this.state()
      return { ok: true, url: current.url, title: current.title }
    }
    const timeoutSeconds = Math.max(1, Math.min(60, input.timeoutSeconds ?? 10))
    const deadline = Date.now() + timeoutSeconds * 1000
    const waitArg: Parameters<typeof buildWaitScript>[0] = {}
    if (input.selector !== undefined) waitArg.selector = input.selector
    if (input.text !== undefined) waitArg.text = input.text
    let reason = ''
    for (;;) {
      try {
        const poll = await this.script<{ found?: boolean; reason?: string; url?: string; title?: string }>(buildWaitScript(waitArg))
        if (poll.found === true) {
          this.push()
          return { ok: true, url: poll.url ?? '', title: poll.title ?? '' }
        }
        reason = poll.reason ?? ''
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      if (Date.now() >= deadline) {
        const current = this.state()
        const what = input.selector !== undefined ? `元素 ${input.selector}` : `文本 ${JSON.stringify(input.text ?? '')}`
        return {
          ok: false,
          error: `等待超时（${String(timeoutSeconds)}s）：${what} 未出现${reason === '' ? '' : `（${reason}）`}。当前 URL: ${current.url}`,
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  async toolSelect(input: {
    index?: number | undefined
    selector?: string | undefined
    value: string
  }): Promise<HostResult<SelectOutput>> {
    const handle = this.resolveHandle(input.index, input.selector)
    if (!handle.ok) return handle
    try {
      const result = await this.script<{
        ok?: boolean
        error?: string
        selected?: SelectOptionEntry
        options?: SelectOptionEntry[]
      }>(buildSelectScript(handle.selector, input.value))
      if (result.ok !== true) {
        return result.options === undefined
          ? { ok: false, error: result.error ?? '选择失败' }
          : { ok: false, error: result.error ?? '选择失败', options: result.options }
      }
      this.push()
      return result.selected === undefined ? { ok: true } : { ok: true, selected: result.selected }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async toolFind(input: FindInput): Promise<HostResult<FindOutput>> {
    const arg: Parameters<typeof buildFindScript>[0] = {}
    if (input.selector !== undefined) arg.selector = input.selector
    if (input.text !== undefined) arg.text = input.text
    if (input.regex !== undefined) arg.regex = input.regex
    if (input.caseSensitive !== undefined) arg.caseSensitive = input.caseSensitive
    if (input.maxResults !== undefined) arg.maxResults = input.maxResults
    if (input.attributes !== undefined) arg.attributes = [...input.attributes]
    if (input.cssScope !== undefined) arg.cssScope = input.cssScope
    try {
      const result = await this.script<{ error?: string; matches?: FindMatch[]; total?: number }>(buildFindScript(arg))
      if (result.error !== undefined) return { ok: false, error: result.error }
      return result.total === undefined
        ? { ok: true, matches: result.matches ?? [] }
        : { ok: true, matches: result.matches ?? [], total: result.total }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * PNG on disk: the model gets a path it can hand to `present`.
   *
   * `fullPage` goes through CDP's `captureBeyondViewport`, which is the only way to get the
   * whole document (Electron's `capturePage` is viewport-sized); it falls back to the
   * viewport when the debugger is busy.
   */
  async toolScreenshot(fullPage = false): Promise<HostResult<{ file: string; bytes: number; fullPage: boolean }>> {
    const contents = this.contents
    if (contents === undefined) return { ok: false, error: '浏览器视图不可用' }

    if (fullPage) {
      const encoded = await this.withDebugger(async (debuggerSession) => {
        await debuggerSession.sendCommand('Page.enable')
        const result = await debuggerSession.sendCommand('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
        }) as { data?: string }
        return typeof result.data === 'string' ? result.data : undefined
      })
      if (encoded !== undefined) {
        const png = Buffer.from(encoded, 'base64')
        const file = this.screenshotFilePath()
        writeFileSync(file, png)
        return { ok: true, file, bytes: png.length, fullPage: true }
      }
    }

    try {
      const image = await contents.capturePage()
      const png = image.toPNG()
      const file = this.screenshotFilePath()
      writeFileSync(file, png)
      return { ok: true, file, bytes: png.length, fullPage: false }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Writes one screenshot and returns its path. */
  private screenshotFilePath(): string {
    const directory = this.options.screenshotDir()
    const file = join(directory, `browser-${new Date().toISOString().replace(/[:.]/gu, '-')}.png`)
    mkdirSync(directory, { recursive: true })
    return file
  }

  /** Single entry point for the panel; every accepted command is whitelisted here. */
  handle(command: unknown): BrowserCommandResult | Promise<BrowserCommandResult> {
    if (typeof command !== 'object' || command === null) return { ok: false, reason: '命令格式不合法' }
    const raw = command as Record<string, unknown>
    switch (raw.name) {
      case 'create': return this.ensureCreated()
      case 'bounds': return this.setBounds(raw.rect)
      case 'show': return this.show('panel')
      case 'hide': return this.hide()
      case 'navigate': return this.navigate(raw.url)
      case 'back': return this.back()
      case 'forward': return this.forward()
      case 'reload': return this.reload()
      case 'focus': return this.focus()
      case 'history': return this.history()
      case 'clearHistory': {
        if (raw.url !== undefined && typeof raw.url !== 'string') return { ok: false, reason: 'url 参数不合法' }
        return this.clearHistory(typeof raw.url === 'string' ? raw.url : undefined)
      }
      case 'freeze': return this.freeze()
      case 'unfreeze': return this.unfreeze()
      case 'prefs': return this.prefs()
      case 'setPrefs': return this.setPrefs(raw.patch)
      case 'clearCache': return this.clearCache()
      case 'clearCookies': return this.clearCookies()
      case 'pick': {
        if (typeof raw.enabled !== 'boolean') return { ok: false, reason: 'pick 参数不合法' }
        return this.setPickMode(raw.enabled)
      }
      case 'device': {
        const device = raw.device
        if (!isDevicePreset(device)) {
          return { ok: false, reason: 'device 参数不合法' }
        }
        return this.setDevice(device as DevicePreset)
      }
      case 'deviceSpec': return this.setDeviceSpec({
        preset: raw.preset,
        width: raw.width,
        height: raw.height,
        rotate: raw.rotate,
      })
      case 'state': return { ok: true, state: this.state() }
      case 'close': this.destroy(); return { ok: true }
      default: return { ok: false, reason: '未知命令' }
    }
  }
}