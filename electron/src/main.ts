/**
 * P0 Electron shell.
 *
 * What it does, in order:
 * 1. single-instance lock, so a second launch focuses the running window;
 * 2. three startup gates (dsh version, `--patch`, port) *before* any child exists;
 * 3. spawn `dsh web` in Electron Node mode, on the fixed loopback port;
 * 4. wait for the one-time authentication URL, then hand the page an authenticated
 *    session instead of a token — see {@link authenticate};
 * 5. show the window only after the first paint.
 *
 * Load modes (`DSH_DESKTOP_LOAD_MODE`):
 * - `cookie` (default): the main process exchanges the token for a cookie, stores it
 *   in the session, and loads the bare address — the token never reaches the page.
 * - `token`: the Tauri shell's behaviour, kept for comparison.
 * - `proxy`: spike S2, `dsh-app://app/` reverse-proxied onto the loopback host.
 */

import { BrowserWindow, Menu, Notification, WebContentsView, app, dialog, ipcMain, nativeImage, nativeTheme, screen, session, shell } from 'electron'
import { createHash, randomBytes } from 'node:crypto'

import minisignSmokeFixture from './fixtures/minisign-smoke.json' with { type: 'json' }
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { release as osRelease } from 'node:os'
import { join } from 'node:path'

import {
  IPC,
  DESKTOP_PROFILE_NAME,
  INSTALL_HANDOFF_MS,
  LOAD_MODE_ENV,
  PANEL_ACTIONS,
  PANEL_DROPPED_LOG_CAP,
  PROFILE_ENV,
  PROXY_ORIGIN_ENV,
  SKIP_LEGACY_CLEANUP_ENV,
  SMOKE_ENV,
  SHELL_LOG_FILENAME,
  SHELL_SETTINGS_FILENAME,
  TITLEBAR_HEIGHT,
  SHELL_LOG_MAX_BYTES,
  SMOKE_CRASH_ENV,
  SMOKE_MENU_ENV,
  SMOKE_MINISIGN_ENV,
  SMOKE_NOTIFY_ENV,
  SMOKE_SUPPORT_ENV,
  SMOKE_UPDATE_ENV,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_STARTUP_DELAY_MS,
  channelConfig,
  resolveChannel,
  type LauncherStatus,
  type ShellMenuName,
  type LoadMode,
} from './constants.ts'
import { writeBrowserToolsCatalog, writeFacts } from './desktop-files.ts'
import {
  BROWSER_PARTITION,
  BrowserViewManager,
  type BrowserViewManagerOptions,
  type BrowserViewState,
} from './browser-view.ts'
import { mergeBrowserPrefs, readBrowserPrefs, writeBrowserPrefs } from './browser-prefs.ts'
import { BrowserDownloads } from './browser-downloads.ts'
import { BrowserTabs } from './browser-tabs.ts'
import { BROWSER_TOOLS, callBrowserTool } from './browser-tools.ts'
import { startAgentBridge, type AgentBridge, type BridgeRegistrationReport } from './agent-bridge.ts'
import { decideToolSurface, parseRegistrationRecord, type ToolRegistrationRecord, type ToolSurfaceDecision } from './browser-tool-surface.ts'
import { clampAutoReleaseSeconds, controlNote, shouldWriteControlNote } from './browser-control.ts'
import type { ControlChange } from './browser-view.ts'
import { runGates, resolvePort, supportsNoOpen } from './gates.ts'
import { DshHostProcess } from './host-process.ts'
import {
  findLegacyInstalls,
  legacyPromptAlreadyOffered,
  markLegacyPromptOffered,
  removeInstall,
} from './legacy-cleanup.ts'
import { blake2b512Chunked } from './blake2b.ts'
import { verifyMinisign } from './minisign.ts'
import { PanelBridge, checkSettingsRoundTrip, describeTasks } from './panel-bridge.ts'
import { applyUserDataOverride, bridgeDir, bundledPnpmEntry, bundledRuntimeRoot, harnessHome, resolveDshEntry, runtimeBinDir, toolRegistrationPath, updatesDir } from './paths.ts'
import {
  ensureDesktopProfile,
  harnessHomeFrom,
  installProfileDependencies,
  linkedPackages,
  profileNeedsInstall,
  profileStoreMismatch,
  relinkPackage,
  repairSeededProfile,
  type ProfileSeed,
} from './profile.ts'
import { installProxyHandler, registerSchemePrivileges } from './proxy.ts'
import { describeRuntimeFailure, verifyRuntime } from './runtime-tree.ts'
import { ensureServicePort, readShellSettings, type ShellSettings } from './settings.ts'
import { mergeSettingsInput, type SettingsInput } from './settings-shape.ts'
import { SettingsWindow, type SettingsSnapshot, type SettingsSaveResult } from './settings-window.ts'
import { titleBarPalette } from './constants.ts'
import { createTray, resolveIconPath } from './tray.ts'
import { UpdateController } from './update-controller.ts'
import { UpdateWindow } from './update-window.ts'
import { launchInstaller, updatePublicKey } from './update.ts'
import { buildAbout } from './about.ts'
import { buildSupportBundle, supportBundleFileName } from './support.ts'
import { WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH, fitBounds, readWindowState, writeWindowState } from './window-state.ts'

// Scheme privileges must be granted before the app is ready; userData must be
// redirected before anything reads it.
registerSchemePrivileges()

/**
 * Channel baked into the packaged app (`extraMetadata`), so a debug install needs no
 * environment variables to know it must stay off the release port and out of the
 * release userData.
 */
function bakedChannel(): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as { dshDesktopChannel?: string }
    return manifest.dshDesktopChannel
  } catch {
    return undefined
  }
}

const channel = resolveChannel(process.env, bakedChannel(), app.isPackaged)
const channelSettings = channelConfig(channel)
const PRODUCT_NAME = channelSettings.productName

applyUserDataOverride(channelSettings.userDataDirName)

const smoke = process.env[SMOKE_ENV] === '1'
const loadMode: LoadMode = (() => {
  const raw = process.env[LOAD_MODE_ENV]
  return raw === 'token' || raw === 'proxy' || raw === 'cookie' ? raw : 'cookie'
})()
/** Proxy-mode document host; `loopback` carries the real host:port (spike S2b). */
const proxyOriginMode = process.env[PROXY_ORIGIN_ENV] === 'loopback' ? 'loopback' : 'app'
let proxyDocumentHost = 'app'

let mainWindow: BrowserWindow | undefined
let tray: ReturnType<typeof createTray>
let host: DshHostProcess | undefined
let stopping = false
/** Installer to run once the shell has stopped; set only from a verified download. */
let pendingInstaller: string | undefined
let updateWindow: UpdateWindow | undefined
let settingsWindow: SettingsWindow | undefined
let updateController: UpdateController | undefined
let updateTimer: NodeJS.Timeout | undefined
let status: LauncherStatus = { phase: 'checking', message: '正在检查启动条件…' }
let hostOrigin: string | undefined
let cookieHeader: string | undefined
/** Settings as of the last read; the panel can change them at runtime. */
let shellSettings: ShellSettings = readShellSettings()
/** Client for the bundled panel plugin's authenticated routes. */
let panelBridge: PanelBridge | undefined
/** The shell-owned sidebar browser (per-tab views + panel bridge). */
let browserPanel: BrowserTabs | undefined
/** Downloads started in the browser partition (session-level, so tabs can close mid-download). */
let browserDownloads: BrowserDownloads | undefined
/** Loopback MCP endpoint the agent's browser tools are served from. */
let agentBridge: AgentBridge | undefined
/** Which surface publishes the browser tools this launch (decided before the child boots). */
let toolSurface: ToolSurfaceDecision | undefined
/** Pane tab id -> the DSH session it belongs to (reported by the panel on every command). */
const browserTabSessions = new Map<string, string>()
/**
 * Pane tab id -> whether the last takeover wrote a session note.
 *
 * A hand-back note is only useful as the *closing half* of a takeover note; without one it would be
 * a message about something the agent never heard about.
 */
const browserControlNotes = new Map<string, boolean>()
/** Set once a quit has been authorised, so `close` stops asking. */
let quitAllowed = false
/** Which dsh runtime this run uses, and whether it verified. */
let runtimeInfo: { source: 'bundled' | 'system'; version?: string; files?: number; shell?: string } | undefined
/** The port this run settled on; used by failure messages after startup. */
let activePort = 0
/** The managed dsh version, once the gates have read it. */
let activeDshVersion: string | null = null
/** For the About dialog's uptime. */
const startedAt = Date.now()
/** Whether the stored window geometry was usable this run. */
let windowGeometryRestored = false
/** The profile this run owns, and whether it had to be created. */
let profileSeed: ProfileSeed | undefined
/** Outcome of the first-run plugin install, when one ran. */
let profileInstall: { ok: boolean; detail: string } | undefined
const logs: string[] = []
/** Observation only, populated in smoke runs: proxied paths, WS handshakes, WS failures. */
const proxyRequests: { path: string; status: number }[] = []
const wsAttempts: string[] = []
const wsErrors: string[] = []
/** Panel actions the main process accepted; smoke uses it to prove the bridge works. */
let panelEventCount = 0
/** Notification emits the shell accepted (shown as a system notification), and refused emits. */
let notificationEventCount = 0
let refusedEmitCount = 0

const launcherRoot = (): string => join(app.getAppPath(), 'dist', 'launcher')
const titleBarRoot = (): string => join(app.getAppPath(), 'dist', 'titlebar')

/**
 * Where the launcher page and the product page load.
 *
 * With a custom title bar the window's own webContents cannot hold them: that one always
 * fills the whole client area, and the page must start below the strip.
 */
let contentView: WebContentsView | undefined
let titleBarView: WebContentsView | undefined

/** The webContents currently showing the launcher or the product page. */
function pageContents(): Electron.WebContents | undefined {
  if (contentView === undefined) return undefined
  const contents = contentView.webContents
  return contents.isDestroyed() ? undefined : contents
}

/** Shared web preferences for both child views. */
function viewWebPreferences(): Electron.WebPreferences {
  return {
    preload: join(app.getAppPath(), 'dist', 'preload.cjs'),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    devTools: true,
    spellcheck: false,
  }
}

function publish(next: LauncherStatus): void {
  status = next
  const contents = pageContents()
  if (contents === undefined) return
  // `send` to a crashed renderer logs "Render frame was disposed before WebFrameMain could
  // be accessed" from inside Electron itself — a try/catch cannot suppress it, so do not
  // send at all; the launcher page pulls the status when it subscribes.
  if (contents.isCrashed()) return
  try {
    contents.send(IPC.launcherStatus, status)
  } catch {
    // The renderer may already be gone — a crash report is published before the launcher
    // page takes over, and `WebFrameMain.send` throws on a disposed frame. The status lives
    // in module state and the next page pulls it on subscribe, so the lost push costs
    // nothing. Without this guard a crashed renderer also logs a confusing Electron error.
  }
}

/**
 * Append to the rolling shell log.
 *
 * The in-memory buffer dies with the process, which is precisely when a user needs the
 * log: a failed start, a crash, a launch that never reaches a window. Lines are already
 * token-redacted before they get here.
 */
function appendShellLog(line: string): void {
  try {
    const path = join(bridgeDir(), SHELL_LOG_FILENAME)
    if (existsSync(path) && statSync(path).size > SHELL_LOG_MAX_BYTES) {
      rmSync(`${path}.1`, { force: true })
      renameSync(path, `${path}.1`)
    }
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    // Diagnostics must never be the reason the app fails.
  }
}

function pushLog(line: string): void {
  logs.push(line)
  if (logs.length > 200) logs.shift()
  appendShellLog(line)
}

/** Collect everything a bug report needs, with credentials removed. */
async function collectSupportBundle(): Promise<string> {
  const directory = bridgeDir()
  const legacy = await findLegacyInstalls(app.getPath('exe')).catch(() => [])
  const bundle = buildSupportBundle({
    desktopVersion: app.getVersion(),
    channel,
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
    v8: process.versions.v8,
    osRelease: osRelease(),
    userData: directory,
    dshHome: harnessHome() ?? null,
    settings: shellSettings,
    status,
    runtime: runtimeInfo ?? { source: 'system' },
    profile: profileSeed ?? null,
    profileInstall: profileInstall ?? null,
    window: mainWindow === undefined || mainWindow.isDestroyed()
      ? null
      : { bounds: mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized(), restored: windowGeometryRestored },
    legacyInstalls: legacy,
    logs,
  })
  const path = join(directory, supportBundleFileName())
  writeFileSync(path, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8')
  return path
}

/** Menu action: write the bundle and tell the user where it is. */
async function exportSupportBundle(): Promise<void> {
  try {
    const path = await collectSupportBundle()
    pushLog(`已导出诊断信息：${path}`)
    const parent = mainWindow === undefined || mainWindow.isDestroyed() ? undefined : mainWindow
    const options = {
      type: 'info' as const,
      title: '诊断信息',
      message: '已导出诊断信息',
      detail: `${path}\n\n其中不含认证令牌与代理密码，可直接附在问题反馈里。`,
      buttons: ['打开所在文件夹', '关闭'],
      defaultId: 0,
      cancelId: 1,
    }
    const { response } = parent === undefined
      ? await dialog.showMessageBox(options)
      : await dialog.showMessageBox(parent, options)
    if (response === 0) shell.showItemInFolder(path)
  } catch (error) {
    pushLog(`导出诊断信息失败：${String(error)}`)
  }
}

function isLauncherSender(url: string): boolean {
  return url.startsWith('file://') || url.startsWith('dsh-app://shell')
}

function createMainWindow(): BrowserWindow {
  // Restore the last position, but only if it still lands on a display: the layout that
  // produced it may be gone (undocked laptop, unplugged monitor, changed resolution).
  const stateDirectory = bridgeDir()
  const stored = readWindowState(stateDirectory)
  const fitted = fitBounds(stored.bounds, screen.getAllDisplays())
  windowGeometryRestored = fitted !== undefined
  const window = new BrowserWindow({
    ...fitted === undefined ? { width: 1280, height: 860 } : fitted,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    show: false,
    backgroundColor: titleBarPalette(nativeTheme.shouldUseDarkColors).background,
    title: PRODUCT_NAME,
    // Windows cannot merge a native menu bar into the title row the way macOS does, so the
    // shell owns that row: Windows draws the caption buttons over a strip of ours, and the
    // menus hang off buttons in it instead of sitting on a row of their own.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: titleBarPalette(nativeTheme.shouldUseDarkColors).background,
      symbolColor: titleBarPalette(nativeTheme.shouldUseDarkColors).symbol,
      height: TITLEBAR_HEIGHT,
    },
  })

  // Two child views: our strip on top, the launcher/product document below. The window's own
  // webContents stays empty, because it would cover the full client area.
  titleBarView = new WebContentsView({ webPreferences: viewWebPreferences() })
  contentView = new WebContentsView({ webPreferences: viewWebPreferences() })
  window.contentView.addChildView(titleBarView)
  window.contentView.addChildView(contentView)
  void titleBarView.webContents.loadFile(join(titleBarRoot(), 'index.html'))

  const layoutViews = (): void => {
    if (window.isDestroyed()) return
    const { width, height } = window.getContentBounds()
    titleBarView?.setBounds({ x: 0, y: 0, width, height: TITLEBAR_HEIGHT })
    contentView?.setBounds({ x: 0, y: TITLEBAR_HEIGHT, width, height: Math.max(0, height - TITLEBAR_HEIGHT) })
  }
  layoutViews()
  window.on('resize', layoutViews)
  window.on('maximize', layoutViews)
  window.on('unmaximize', layoutViews)
  window.on('restore', layoutViews)
  window.on('enter-full-screen', layoutViews)
  window.on('leave-full-screen', layoutViews)

  // Follow the OS theme while running, not just at startup: the caption buttons are drawn by
  // Windows and the strip is ours, so both have to be repainted together.
  nativeTheme.on('updated', () => {
    if (window.isDestroyed()) return
    const palette = titleBarPalette(nativeTheme.shouldUseDarkColors)
    window.setBackgroundColor(palette.background)
    window.setTitleBarOverlay({ color: palette.background, symbolColor: palette.symbol, height: TITLEBAR_HEIGHT })
  })

  const page = contentView.webContents

  if (stored.maximized === true) window.maximize()

  const saveGeometry = (): void => {
    if (window.isDestroyed()) return
    writeWindowState(stateDirectory, {
      bounds: window.getNormalBounds(),
      maximized: window.isMaximized(),
    })
  }
  let geometryTimer: NodeJS.Timeout | undefined
  const scheduleGeometrySave = (): void => {
    if (geometryTimer !== undefined) clearTimeout(geometryTimer)
    geometryTimer = setTimeout(() => { geometryTimer = undefined; saveGeometry() }, 400)
  }
  window.on('resize', scheduleGeometrySave)
  window.on('move', scheduleGeometrySave)
  window.on('maximize', scheduleGeometrySave)
  window.on('unmaximize', scheduleGeometrySave)
  window.on('close', () => {
    if (geometryTimer !== undefined) clearTimeout(geometryTimer)
    saveGeometry()
  })

  // The strip shows the product name, and the taskbar/Alt-Tab label must not follow the
  // page either. `preventDefault()` alone did not hold on Electron 44 — the native title
  // still followed `document.title` (verified through Win32, not `getTitle()`) — so re-pin
  // it on the next tick as well.
  page.on('page-title-updated', (event) => {
    event.preventDefault()
    setImmediate(() => {
      if (!window.isDestroyed()) window.setTitle(PRODUCT_NAME)
    })
  })

  // External links go to the system browser; nothing else may open a window.
  page.setWindowOpenHandler(({ url }) => {
    try {
      if (['http:', 'https:'].includes(new URL(url).protocol)) void shell.openExternal(url)
    } catch {
      // Malformed URL: deny without a side effect.
    }
    return { action: 'deny' }
  })

  // The dsh web app must stay on the loopback origin it was served from.
  page.on('will-navigate', (event, url) => {
    const allowed = hostOrigin !== undefined && url.startsWith(hostOrigin)
    const isLauncher = url.startsWith('file://') || url.startsWith('dsh-app://')
    if (!allowed && !isLauncher) {
      event.preventDefault()
      pushLog(`已阻止非预期导航：${url}`)
    }
  })

  // A crashed renderer leaves a white window with no explanation and no way back.
  // Report it on the launcher page, which carries the log panel, and keep a menu path to
  // reload the product document.
  page.on('render-process-gone', (_event, details) => {
    pushLog(`界面进程异常退出：reason=${details.reason} exitCode=${String(details.exitCode)}`)
    publish({
      phase: 'failed',
      message: `界面进程已崩溃（${details.reason}）`,
      detail: '用标题栏「应用 → 重新加载界面」可以恢复；若反复出现，请退出并重启应用。',
      port: activePort,
      loadMode,
    })
    void page.loadFile(join(launcherRoot(), 'index.html'))
  })

  // The DSH document failing to load usually means the managed service died underneath it.
  // ERR_ABORTED (-3) is normal: it is what a superseded navigation reports.
  page.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return
    if (validatedURL.startsWith('file://') || validatedURL.startsWith('dsh-app://')) return
    pushLog(`DSH 界面加载失败：${String(errorCode)} ${errorDescription}`)
    publish({
      phase: 'failed',
      message: `DSH 界面加载失败（${errorDescription}）`,
      detail: 'DSH 服务可能已经退出。用标题栏「应用 → 重新加载界面」重试，或重启应用。',
      port: activePort,
      loadMode,
    })
    void page.loadFile(join(launcherRoot(), 'index.html'))
  })

  // Not fatal, and usually self-healing: record it so a support log explains the hiccup.
  page.on('unresponsive', () => { pushLog('界面暂时无响应') })
  page.on('responsive', () => { pushLog('界面已恢复响应') })

  // Closing follows the setting the DSH settings page writes, and never silently
  // discards running work.
  window.on('close', (event) => {
    if (stopping || quitAllowed) return
    if (shellSettings.closeBehavior === 'minimizeToTray' && tray !== undefined) {
      event.preventDefault()
      window.hide()
      return
    }
    event.preventDefault()
    void (async () => {
      if (!await confirmInterrupt('退出', '退出')) return
      quitAllowed = true
      app.quit()
    })()
  })

  void window.loadFile(join(launcherRoot(), 'index.html'))
  return window
}

function showMainWindow(): void {
  if (mainWindow === undefined || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** The native about panel, reachable from the tray and from the DSH settings page. */
function showAbout(): void {
  const iconPath = resolveIconPath()
  const icon = iconPath === undefined ? undefined : nativeImage.createFromPath(iconPath)
  const content = buildAbout({
    productName: PRODUCT_NAME,
    version: app.getVersion(),
    channel,
    dshVersion: activeDshVersion,
    runtimeSource: runtimeInfo?.source === 'bundled' ? 'bundled' : 'system',
    port: activePort === 0 ? null : activePort,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    uptimeMs: Date.now() - startedAt,
    repository: 'github.com/gzh330205/deepseek-harness-desktop',
  })
  const options = {
    type: 'none' as const,
    // The app icon instead of a generic blue "i": this is the one dialog where the product
    // should look like itself.
    ...icon === undefined || icon.isEmpty() ? {} : { icon },
    title: content.title,
    message: content.message,
    detail: content.detail,
    buttons: ['确定'],
    defaultId: 0,
    cancelId: 0,
    // Regular push buttons rather than Windows command links: one action does not need the
    // oversized layout.
    noLink: true,
  }
  // Parented to the window, so it is modal and centred on the app rather than floating.
  const parent = mainWindow === undefined || mainWindow.isDestroyed() ? undefined : mainWindow
  void (parent === undefined ? dialog.showMessageBox(options) : dialog.showMessageBox(parent, options))
}

/**
 * Ask DSH what stopping now would interrupt, and confirm with the user.
 *
 * `unknown` is treated as "may have work" and still asks: a shell that guesses wrong
 * here throws away a user's running agent. `idle` proceeds without a dialog.
 */
async function confirmInterrupt(intent: string, confirmLabel: string): Promise<boolean> {
  const bridge = panelBridge
  if (bridge === undefined || smoke) return true
  // No managed host means there is nothing that could be interrupted; only a *running*
  // host whose query fails counts as unknown and asks. Same rule as the official shell.
  if (hostOrigin === undefined || cookieHeader === undefined) return true
  const report = await bridge.tasks()
  if (report.answer === 'idle') return true
  const detail = describeTasks(report)
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: [confirmLabel, '取消'],
    defaultId: 1,
    cancelId: 1,
    title: `${intent}会中断正在运行的任务`,
    message: report.answer === 'unknown' ? '无法确认当前是否有任务在运行。' : '检测到正在运行的任务。',
    detail: `${detail === '' ? '' : `${detail}\n\n`}${intent}会中断它们。`,
  })
  return response === 0
}

/**
 * Exchange the one-time token for the `dsh-auth` cookie.
 *
 * The token is a credential for exactly one redirect. Doing the exchange in the main
 * process means the page's history, referrer, and cookie jar never see it, and the
 * cookie cannot be lifted by script running in the page.
 */
async function authenticate(authUrl: string, port: number): Promise<string | undefined> {
  try {
    const response = await fetch(authUrl, { redirect: 'manual' })
    const setCookie = response.headers.getSetCookie()[0] ?? response.headers.get('set-cookie') ?? null
    await response.body?.cancel()
    if (setCookie === null) {
      pushLog(`认证换取 cookie 失败：HTTP ${String(response.status)}，未返回 set-cookie`)
      return undefined
    }
    const pair = setCookie.split(';')[0]?.trim() ?? ''
    const separator = pair.indexOf('=')
    if (separator <= 0) {
      pushLog('认证换取 cookie 失败：set-cookie 格式不可解析')
      return undefined
    }
    const name = pair.slice(0, separator)
    const value = pair.slice(separator + 1)
    await session.defaultSession.cookies.set({
      url: `http://127.0.0.1:${String(port)}/`,
      name,
      value,
      sameSite: 'strict',
    })
    pushLog(`已用一次性 token 换取 ${name} cookie（token 未进入页面）`)
    return pair
  } catch (error) {
    pushLog(`认证换取 cookie 失败：${String(error)}`)
    return undefined
  }
}

/**
 * Wire the panel bridge: the DSH settings page talks to the shell through the two
 * Tauri event methods the preload exposes, and the shell pushes a state event back so
 * the page refreshes itself.
 *
 * Every message is checked twice: the preload only exposes the allowlisted event names
 * to the product document, and here the sender must be the main window's main frame on
 * a loopback origin. Actions are matched against {@link PANEL_ACTIONS}.
 */
function installPanelBridge(): void {
  panelBridge = new PanelBridge({ origin: () => hostOrigin, cookie: () => cookieHeader })

  ipcMain.on(IPC.panelEvent, (event, name: unknown, payload: unknown) => {
    if (mainWindow === undefined || mainWindow.isDestroyed()) return
    if (event.sender !== pageContents()) return
    if (event.senderFrame !== event.sender.mainFrame) return
    const url = event.senderFrame?.url ?? ''
    if (!url.startsWith('http://127.0.0.1:') && !url.startsWith('http://localhost:')) return

    // The notification plugin's own event name (`tauriEventName`, default `dsh-notify`); the
    // package-name spelling is kept for older configs.
    if (name === 'dsh-notify' || name === 'dsh-win-notify') {
      notificationEventCount += 1
      showNotification(payload)
      return
    }
    if (name !== 'dsh-desktop-shell') return
    const action = typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>).action
      : undefined
    if (typeof action !== 'string' || !(PANEL_ACTIONS as readonly string[]).includes(action)) return
    panelEventCount += 1
    void handlePanelAction(action)
  })

  // An emit the preload refused by name (see PANEL_EMIT_EVENTS). Reported once per name: this is the
  // only trace a plugin whose event name drifted leaves, and it is otherwise completely silent.
  const droppedNames = new Set<string>()
  ipcMain.on(IPC.panelDropped, (event, name: unknown) => {
    if (mainWindow === undefined || mainWindow.isDestroyed()) return
    if (event.sender !== pageContents()) return
    refusedEmitCount += 1
    const label = typeof name === 'string' ? name.slice(0, 60) : ''
    if (label === '' || droppedNames.has(label) || droppedNames.size >= PANEL_DROPPED_LOG_CAP) return
    droppedNames.add(label)
    pushLog(`忽略了页面发来的未知事件「${label}」（不在白名单里；若是插件通知，见 PANEL_EMIT_EVENTS）`)
  })
}

/**
 * The sidebar browser's panel bridge.
 *
 * The panel is a DSH client plugin rendered inside the product page, so it is a renderer:
 * every command is re-validated here (sender identity, main frame, loopback origin) and
 * then handed to {@link BrowserViewManager}, which owns the native view, its dedicated
 * session partition and its navigation policy. Commands never carry a URL to load on
 * behalf of a page other than this one.
 */
function installBrowserPanel(): void {
  const window = mainWindow
  /**
   * One tab's manager wiring. Extracted so `rebindManager` can re-point a live view at another tab
   * occurrence when the panel takes the agent's background view over: the page keeps loading, but
   * its state pushes, picks and control notes must name the panel's tab from then on.
   */
  const managerOptions = (tabId: string, notify: (state: BrowserViewState) => void): BrowserViewManagerOptions => ({
    window: () => mainWindow,
    notify,
    log: pushLog,
    titleBarHeight: TITLEBAR_HEIGHT,
    applicationOrigin: () => hostOrigin,
    screenshotDir: () => join(bridgeDir(), 'browser-screenshots'),
    // A pick is already nonce-checked by the manager; it still only ever goes to the
    // panel of the tab that produced it.
    onPick: (element) => { pageContents()?.send(IPC.browserPick, { ...element, tabId }) },
    // Control handover: the panel learns from its own state push; the *agent* is told through a
    // session note, so a waiting tool call knows why it is waiting and when it may continue.
    onControlChange: (change) => { notifyBrowserControl(tabId, change) },
    // Browser-local preferences (homepage, bookmarks) live next to shell-settings.json.
    prefs: {
      read: () => readBrowserPrefs(bridgeDir()),
      write: (prefs) => { writeBrowserPrefs(bridgeDir(), prefs) },
      directory: () => bridgeDir(),
    },
  })
  browserPanel = new BrowserTabs({
    // One manager (one native view, one renderer process) per sidebar tab occurrence.
    createManager: (tabId, notify) => new BrowserViewManager(managerOptions(tabId, notify)),
    notify: (tabId, state) => { pageContents()?.send(IPC.browserState, { ...state, tabId }) },
    log: pushLog,
    // Adoption: the sidebar tab that just came on screen takes the conversation's background view
    // over. Same view, same page, same load — only the id it reports under changes, so the closures
    // that name the tab have to be re-pointed.
    rebindManager: (manager, tabId) => {
      const sessionId = browserPanel?.sessionOf(tabId) ?? ''
      if (sessionId !== '') browserTabSessions.set(tabId, sessionId)
      manager.rebind({
        notify: (state) => { pageContents()?.send(IPC.browserState, { ...state, tabId }) },
        onPick: (element) => { pageContents()?.send(IPC.browserPick, { ...element, tabId }) },
        onControlChange: (change) => { notifyBrowserControl(tabId, change) },
      })
    },
    // The agent wants the user to see a page but no panel is on screen: ask DSH's page to open the
    // browser tab in the right sidebar (opening it is a client-side operation). The driving
    // conversation travels with the request so the panel opens *that* conversation's tab.
    onOpenPane: (paneTabId, mayExpandSidebar, drivingSession) => { void openBrowserForAgent(paneTabId, mayExpandSidebar, drivingSession) },
  })
  browserPanel.setAutoReleaseSeconds(shellSettings.browser.autoReleaseSeconds)
  window?.on('closed', () => { browserPanel?.shutdown() })
  // Downloads belong to the browser partition, not to one tab: a tab can be closed mid-download.
  browserDownloads = new BrowserDownloads({
    log: pushLog,
    notify: (items) => { pageContents()?.send(IPC.browserDownloads, { downloads: items }) },
    saveDir: () => app.getPath('downloads'),
    openPath: (path) => shell.openPath(path),
    revealPath: (path) => { shell.showItemInFolder(path) },
  })
  browserDownloads.attach(session.fromPartition(BROWSER_PARTITION))
  window?.on('closed', () => { browserDownloads?.dispose() })
  // Leaving the DSH page (launcher, reload, crash recovery) must not leave a native surface
  // floating over whatever replaces it.
  pageContents()?.on('did-navigate', () => { browserPanel?.hideAll() })
  // The DSH page's own errors and warnings go into shell.log as well. A client plugin that
  // throws while rendering leaves a blank pane and *nothing* in the shell's log otherwise —
  // which is exactly how a white sidebar once shipped (see docs/sidebar-browser-integration.md).
  pageContents()?.on('console-message', (details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>) => {
    if (details.level !== 'error' && details.level !== 'warning') return
    const message = typeof details.message === 'string' ? details.message.slice(0, 500) : ''
    if (message === '') return
    // Electron's own unpackaged-build security notices are not our page's problems.
    if (message.includes('Electron Security Warning') || message.includes('electronjs.org/docs/tutorial/security')) return
    pushLog(`[页面${details.level === 'error' ? '错误' : '警告'}] ${message}`)
  })

  ipcMain.handle(IPC.browserCommand, (event, command: unknown) => {
    if (mainWindow === undefined || mainWindow.isDestroyed()) return { ok: false, reason: '主窗口未就绪' }
    if (event.sender !== pageContents()) return { ok: false, reason: 'forbidden' }
    if (event.senderFrame !== event.sender.mainFrame) return { ok: false, reason: 'forbidden' }
    const url = event.senderFrame?.url ?? ''
    if (!url.startsWith('http://127.0.0.1:') && !url.startsWith('http://localhost:')) {
      return { ok: false, reason: 'forbidden' }
    }
    // Downloads are shell-level (one partition, many tabs), so they are answered here rather
    // than by a tab's manager.
    if (typeof command === 'object' && command !== null) {
      const downloadCommand = command as { name?: unknown; id?: unknown; text?: unknown }
      // Panel-side diagnostics: the client plugin's console is invisible from the shell, so it
      // reports lifecycle lines (menu open/close, freeze result) through here into shell.log.
      if (downloadCommand.name === 'diag') {
        const text = typeof downloadCommand.text === 'string' ? downloadCommand.text.slice(0, 300) : ''
        if (text !== '') pushLog(`[面板] ${text}`)
        return { ok: true }
      }
      const downloads = browserDownloads
      if (downloads !== undefined) {
        switch (downloadCommand.name) {
          case 'downloads': return { ok: true, downloads: downloads.list() }
          case 'openDownload': return downloads.open(typeof downloadCommand.id === 'string' ? downloadCommand.id : '')
          case 'revealDownload': return downloads.reveal(typeof downloadCommand.id === 'string' ? downloadCommand.id : '')
          case 'clearDownloads': downloads.clear(); return { ok: true, downloads: downloads.list() }
          default: break
        }
      }
    }
    // The panel tells us which DSH session it belongs to on every command; remember it per tab so
    // a control handover can be reported into that session (see `notifyBrowserControl`).
    if (typeof command === 'object' && command !== null) {
      const envelope = command as { tabId?: unknown; sessionId?: unknown }
      if (typeof envelope.tabId === 'string' && typeof envelope.sessionId === 'string' && envelope.sessionId !== '') {
        browserTabSessions.set(envelope.tabId, envelope.sessionId)
      }
    }
    return browserPanel?.handle(command) ?? { ok: false, reason: '浏览器不可用' }
  })
}

/**
 * Tell the agent (not just the panel) that browser control changed hands.
 *
 * Runs a session append inside the DSH host plugin: `user/message` with a dedicated `source.kind`,
 * which DSH projects into the model's history without treating it as a user prompt.
 *
 * Only written when the agent would otherwise learn nothing. If a call was in flight it is *held*
 * until the hand-back, and that call's own result already explains the wait — adding a note on top
 * of it is what made a real session answer "我暂停，稍后继续读结构" and end its turn.
 */
function notifyBrowserControl(tabId: string, change: ControlChange): void {
  const seconds = clampAutoReleaseSeconds(change.autoReleaseSeconds)
  pushLog(
    change.state === 'taken'
      ? `浏览器控制权已交给用户（${change.reason === 'user-click' ? '用户点击页面' : '面板'}）：助手调用会等待，${String(seconds)} 秒无操作后自动交还`
      : `浏览器控制权已交还助手（${change.reason === 'auto-idle' ? '用户停止操作' : '面板按钮'}）`,
  )
  const wroteTakeoverNote = browserControlNotes.get(tabId) === true
  if (!shouldWriteControlNote(change, wroteTakeoverNote)) {
    browserControlNotes.set(tabId, false)
    pushLog(
      change.state === 'taken'
        ? '（有调用正在等待：解释随该调用的结果一起返回，不额外写入会话）'
        : '（本次接管没有写会话提示：等待的调用已自行说明，不额外写入会话）',
    )
    return
  }
  browserControlNotes.set(tabId, change.state === 'taken')
  const sessionId = browserTabSessions.get(tabId)
  if (sessionId === undefined) {
    pushLog('（未记录到该标签所属的 DSH 会话，跳过向会话写入控制权提示）')
    return
  }
  void panelBridge?.sessionNote(sessionId, controlNote(change.state === 'taken' ? 'taken' : change.reason === 'auto-idle' ? 'expired' : 'released', seconds))
    .then((result) => {
      if (!result.ok) pushLog(`（控制权提示未能写入会话：${result.error ?? '未知原因'}；会话 ${sessionId}）`)
    })
    .catch((error: unknown) => {
      pushLog(`（控制权提示写入异常：${error instanceof Error ? error.message : String(error)}）`)
    })
}

/**
 * Ask DSH's page to open the browser tab in the right sidebar.
 *
 * The one way the browser reaches the user's screen.
 *
 * A native view may only be placed where the panel measured itself, so the sequence is: the page
e * opens the tab (a client-side operation, ctx.sidebarRight.openTabIn/openTab), the panel mounts
 * and reports bounds, and the shell hands it the view the agent is using.
 */
/**
 * The agent asked to show a page (the only entry point a tool call has into the user's screen).
 *
 * Everything here is a request to the *page*: only the client half can open a tab in DSH's right
 * sidebar. The driving conversation is passed along, because `openTabIn` needs it and a new
 * conversation must not land in another one's panel.
 */
async function openBrowserForAgent(tabId: string, mayExpandSidebar: boolean, knownSessionId = ''): Promise<void> {
  await openBrowserPane(tabId, mayExpandSidebar, knownSessionId)
}
async function openBrowserPane(tabId: string, mayExpandSidebar: boolean, knownSessionId = ''): Promise<void> {
  const page = pageContents()
  if (page === undefined) return
  // Prefer the conversation the tool call came from; the panel's last report and the plugin's
  // recorded driver are the fallbacks.
  const sessionId = knownSessionId !== ''
    ? knownSessionId
    : browserTabSessions.get(tabId) ?? await panelBridge?.driverSession() ?? ''
  page.send(IPC.browserOpenPane, { tabId, sessionId, expand: mayExpandSidebar })
  pushLog(
    `助手要求显示页面：已请面板打开侧边栏浏览器（会话 ${sessionId === '' ? '未知' : sessionId}` +
      `${mayExpandSidebar ? '，面板从未显示过→必要时展开侧栏' : ''}）`,
  )
}

/**
 * What the plugin reported about its native registration last launch.
 *
 * This is the memory behind the automatic MCP fallback: if the plugin could not register the
 * catalog natively (a DSH upgrade changed `ctx.tools.register`), the shell injects the MCP row
 * on the *next* launch instead of losing the tools silently.
 */
function readToolRegistrationRecord(): ToolRegistrationRecord | undefined {
  try {
    const raw = readFileSync(toolRegistrationPath(), 'utf8')
    return parseRegistrationRecord(JSON.parse(raw))
  } catch {
    return undefined
  }
}

function recordToolRegistration(report: BridgeRegistrationReport): void {
  try {
    writeFileSync(toolRegistrationPath(), `${JSON.stringify({ ...report, at: Date.now() }, null, 2)}\n`, 'utf8')
  } catch {
    // Diagnostics only: a failure to remember the result must not break the run.
  }
  if (report.ok) {
    pushLog(`面板插件已注册 ${String(report.count)} 个原生浏览器工具（下次启动继续用原生工具）`)
  } else {
    pushLog(`面板插件注册原生工具失败：${report.error ?? '未知原因'}——下次启动将自动回退 MCP 工具`)
  }
  pushPanelState()
}

/**
 * Start the browser-tool bridge.
 *
 * It has to be listening *before* the child boots, because the overlay that points DSH's
 * MCP client at it is written during `DshHostProcess.start()`. A failure here is logged and
 * non-fatal: the panel keeps working, only the agent tools are missing.
 */
async function startBrowserTools(): Promise<void> {
  if (browserPanel === undefined) return
  // A relaunch rebuilds everything anyway; this only matters if boot ever reruns in place.
  await agentBridge?.close().catch(() => {})
  agentBridge = undefined
  // Which surface publishes these tools is decided *before* the child boots (the overlay either
  // carries the MCP row or leaves it to the plugin), so decide it here and remember it.
  toolSurface = decideToolSurface(shellSettings.browser.agentTools, readToolRegistrationRecord(), BROWSER_TOOLS.length)
  // The host is bound to the calling conversation, so browser tabs stay per conversation.
  const hostFor = (sessionId: string) => browserPanel?.toolHost(sessionId)
  try {
    agentBridge = await startAgentBridge({
      serverName: 'desktop_browser',
      tools: BROWSER_TOOLS,
      call: async (name, args, signal, sessionId) => {
        // Every entry point (MCP and the plugin's direct calls) ends up here, so this is the one
        // place that brackets a call with the "the agent is driving" veil.
        browserPanel?.beginAgentActivity(name, sessionId)
        try {
          const host = hostFor(sessionId)
          if (host === undefined) return { content: [{ type: 'text', text: '浏览器不可用' }], isError: true }
          return await callBrowserTool(host, name, args, signal)
        } finally {
          browserPanel?.endAgentActivity()
        }
      },
      log: pushLog,
      onRegistered: (report) => { recordToolRegistration(report) },
    })
    // The plugin reads this file to register the same catalog natively (one source, two surfaces).
    writeBrowserToolsCatalog(BROWSER_TOOLS)
    pushLog(
      `浏览器 agent 工具桥已就绪（${String(BROWSER_TOOLS.length)} 个工具，loopback；呈现方式：${toolSurface.mode === 'native' ? '原生' : 'MCP'}——${toolSurface.reason}）`,
    )
  } catch (error) {
    pushLog(`浏览器 agent 工具桥启动失败，agent 将看不到这些工具：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function handlePanelAction(action: string): Promise<void> {
  switch (action) {
    case 'settings-changed': {
      shellSettings = readShellSettings()
      pushLog(`面板已保存设置（关闭行为 ${shellSettings.closeBehavior}、端口 ${String(shellSettings.servicePort ?? '(默认)')}）`)
      break
    }
    case 'restart-dsh': {
      // The settings page says "保存并重启 DSH"; the proxy and port are environment and
      // argument inputs to the child, so the whole shell restarts rather than the host
      // alone. Cheaper to get right than a partial in-place host restart.
      shellSettings = readShellSettings()
      setImmediate(() => { restartShell('设置页请求重启') })
      return
    }
    case 'check-desktop-update':
      await updateController?.check(true)
      break
    case 'show-about':
      showAbout()
      break
    case 'focus-main':
      showMainWindow()
      break
  }
  pushPanelState()
}

/**
 * Reload the DSH document from the same origin, the recovery path offered after a renderer
 * crash. Token mode cannot be reloaded this way — the one-time token is spent — so it sends
 * the user to the launcher instead of to a 401.
 */
function reloadProductDocument(): void {
  const contents = pageContents()
  if (contents === undefined) return
  if (hostOrigin === undefined || loadMode === 'token') {
    pushLog(hostOrigin === undefined ? '尚未启动 DSH 服务，回到启动页' : 'token 模式下请重启应用以重新认证')
    void contents.loadFile(join(launcherRoot(), 'index.html'))
    return
  }
  pushLog(`重新加载界面：${hostOrigin}/`)
  void contents.loadURL(`${hostOrigin}/`)
}

/**
 * The 应用 menu. There is no native menu bar any more — Windows cannot put one in the title
 * row — so the strip's button pops this up instead. The actions are unchanged, and the
 * recovery ones stay one click away, which is why the bar was not simply dropped.
 */
/** The menus the strip's buttons can open. One entry today: Ctrl+C/V/X/A/Z already work in
 * web content on Windows, so an 编辑 menu only duplicated the keyboard. */
const MENU_TEMPLATES: Record<ShellMenuName, () => Electron.MenuItemConstructorOptions[]> = {
  app: appMenuTemplate,
}

/**
 * The 应用 menu.
 *
 * No 退出 here on purpose: it sits one click away from 重新加载界面 and 设置…, and a misplaced
 * click would end the session. Quitting lives in the tray menu, which cannot be hit by
 * accident while working in the window, and the window's own close button follows the
 * `closeBehavior` setting.
 */
function appMenuTemplate(): Electron.MenuItemConstructorOptions[] {
  return [
    { label: '重新加载界面', click: () => { reloadProductDocument() } },
    { label: '显示状态页（诊断）', click: () => { void pageContents()?.loadFile(join(launcherRoot(), 'index.html')) } },
    { label: '重启 DSH 服务（重启应用）', click: () => { restartShell('菜单请求重启') } },
    { type: 'separator' },
    {
      label: '检查更新…',
      click: () => {
        updateWindow?.open()
        void updateController?.check(true)
      },
    },
    { label: '导出诊断信息…', click: () => { void exportSupportBundle() } },
    { type: 'separator' },
    { label: '设置…', click: () => { settingsWindow?.open() } },
    { label: `关于 ${PRODUCT_NAME}`, click: () => { showAbout() } },
  ]
}

/**
 * Restart the shell — and with it the DSH service.
 *
 * The service is a child process spawned during boot, together with the tray, the IPC
 * handlers and the panel bridge; restarting only the child in place would have to unwind and
 * re-register all of that, and the port and proxy it takes are read at spawn time anyway. A
 * relaunch gets a clean service, fresh gates and a fresh auth cookie, which is what this menu
 * item is for. `quitAllowed` skips the "tasks are still running" prompt: the user asked for
 * this, and the confirm-before-quit guard is about the close button.
 *
 * @param reason - Logged, so the shell log says why the app restarted.
 */
function restartShell(reason: string): void {
  pushLog(`${reason}，正在重启桌面端与 DSH 服务`)
  quitAllowed = true
  app.relaunch()
  app.exit(0)
}

/**
 * Open one of the strip's menus under the button that asked for it.
 *
 * The promise resolves when the menu closes, so the button can hold its pressed state.
 *
 * @param name - Which menu.
 * @param anchor - Button rectangle, in the title bar view's coordinates.
 * @param onItems - Receives the item labels; used by the smoke run to prove the menu exists.
 */
function popupShellMenu(
  name: ShellMenuName,
  anchor?: { x: number; y: number; height: number },
  hooks?: { readonly onItems?: (labels: readonly string[]) => void; readonly onMenu?: (menu: Electron.Menu) => void },
): Promise<boolean> {
  const window = mainWindow
  if (window === undefined || window.isDestroyed()) return Promise.resolve(false)
  const template = MENU_TEMPLATES[name]()
  hooks?.onItems?.(template.map(item => item.label ?? item.role ?? item.type ?? ''))
  const menu = Menu.buildFromTemplate(template)
  hooks?.onMenu?.(menu)
  const point = anchor === undefined ? {} : { x: Math.round(anchor.x), y: Math.round(anchor.y + anchor.height) }
  return new Promise<boolean>((resolve) => {
    menu.once('menu-will-close', () => { resolve(true) })
    menu.popup({ window, ...point })
  })
}

/** Tell the product page that shell state changed; it re-reads `/state` over HTTP. */
function pushPanelState(): void {
  const contents = pageContents()
  if (contents === undefined) return
  contents.send(IPC.panelState, { at: Date.now() })
}

/**
 * Run the bundled pnpm shim for a profile operation.
 *
 * A shell is required: `.cmd` cannot be spawned directly on Node 20+. Args are fixed and
 * paths are quoted by the caller, so no user input reaches the command line.
 */
function runProfileCommand(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly timeoutMs: number; readonly shell: boolean },
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    execFile(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      windowsHide: true,
      shell: options.shell,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
        ? (error as unknown as { code: number }).code
        : 1
      resolve({ code, output: `${stdout}${stderr}` })
    })
  })
}

/**
 * Store a profile was last relinked to, e.g. `v11`.
 *
 * Kept beside the shell's other state rather than inside the profile: pnpm owns that directory and
 * its purge would delete our file, and pnpm itself records no store version in the workspace state
 * it writes.
 */
function readStoreMigration(profilePath: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(bridgeDir(), 'profile-store.json'), 'utf8')) as { profile?: unknown; store?: unknown }
    if (raw.profile !== profilePath || typeof raw.store !== 'string') return undefined
    return raw.store
  } catch {
    return undefined
  }
}

/** Record a completed relink, so the next start does not purge and reinstall the profile again. */
function writeStoreMigration(profilePath: string, store: string): void {
  try {
    writeFileSync(join(bridgeDir(), 'profile-store.json'), `${JSON.stringify({ profile: profilePath, store, at: Date.now() }, null, 2)}\n`, 'utf8')
  } catch {
    // Diagnostics only: the migration still happened, it will simply be repeated next start.
  }
}

/** The notification plugin (`dsh-win-notify`) emits `{ title, body, sessionId }`. */
function showNotification(payload: unknown): void {
  if (typeof payload !== 'object' || payload === null) return
  const record = payload as Record<string, unknown>
  const title = typeof record.title === 'string' && record.title !== '' ? record.title : PRODUCT_NAME
  const body = typeof record.body === 'string' ? record.body : ''
  if (body === '' && title === PRODUCT_NAME) return
  if (!Notification.isSupported()) {
    pushLog('系统通知不可用（当前系统不支持）')
    return
  }
  try {
    new Notification({ title, body }).show()
    // One line per notification: "did the shell actually try to show it" is otherwise unknowable
    // from the outside, and that is exactly the question a "通知没弹" report asks.
    pushLog(`系统通知：${title}${body === '' ? '' : ` —— ${body.slice(0, 60)}`}`)
  } catch (error) {
    pushLog(`系统通知失败：${String(error)}`)
  }
}

/**
 * Wire the update window, the controller, and the check schedule.
 *
 * The shell only ever installs an artifact it verified in this process; the check
 * itself is silent and opens the window only when a newer version exists.
 */
/** The snapshot the settings page renders: current values plus read-only facts. */
function settingsSnapshot(): SettingsSnapshot {
  const path = join(bridgeDir(), SHELL_SETTINGS_FILENAME)
  return {
    values: {
      servicePort: shellSettings.servicePort ?? channelSettings.defaultPort,
      closeBehavior: shellSettings.closeBehavior,
      proxyEnabled: shellSettings.proxy.enabled,
      httpProxy: shellSettings.proxy.httpProxy,
      httpsProxy: shellSettings.proxy.httpsProxy,
      noProxy: shellSettings.proxy.noProxy,
      checkDesktopOnStart: shellSettings.updates.checkDesktopOnStart,
      checkDshOnStart: shellSettings.updates.checkDshOnStart,
      browserEnabled: shellSettings.browser.enabled,
    },
    facts: {
      desktopVersion: app.getVersion(),
      dshVersion: activeDshVersion,
      runtimeVersion: runtimeInfo?.version ?? '未知',
      runtimeSource: runtimeInfo?.source ?? 'system',
      effectivePort: activePort === 0 ? null : activePort,
      profileName: channelSettings.profileName,
      settingsPath: path,
      defaultPort: channelSettings.defaultPort,
    },
  }
}

/**
 * Persist a submission from the shell's settings page.
 *
 * Validation and merging live in `settings-shape.ts`, which the DSH panel's writes share, so
 * the two entry points cannot drift apart. The document is written whole (merged over what
 * was on disk) because the Tauri shell's plugin reads and writes the same file.
 */
function saveSettings(input: SettingsInput): SettingsSaveResult {
  const path = join(bridgeDir(), SHELL_SETTINGS_FILENAME)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    raw = {}
  }
  const merged = mergeSettingsInput(raw, input, channelSettings.defaultPort)
  if (!merged.ok) return { ok: false, reason: merged.reason }
  if (merged.changed.length === 0) return { ok: true, changed: [], restartRequired: false }

  // Atomic: a half-written file would change the port and close behaviour on the next boot.
  const temporary = `${path}.tmp-${String(process.pid)}`
  writeFileSync(temporary, `${JSON.stringify(merged.document, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
  shellSettings = readShellSettings()
  pushLog(`桌面端设置已保存：${merged.changed.join('、')}`)
  const restartRequired = merged.changed.some((key) => key.startsWith('service.') || key.startsWith('proxy.'))
  return { ok: true, changed: merged.changed, restartRequired }
}

/**
 * The shell's own settings window.
 *
 * These settings are the shell's own — the port it binds, how its window closes, the proxy it
 * hands to the dsh child, whether it checks for updates — so they no longer need a DSH page.
 */
function installSettingsWindow(): void {
  const window = new SettingsWindow({
    appRoot: app.getAppPath(),
    snapshot: settingsSnapshot,
    save: saveSettings,
    restart: () => { restartShell('设置页请求保存并重启') },
    isShellDocument: isLauncherSender,
  })
  window.install()
  settingsWindow = window
}

function installUpdates(): void {
  const window = new UpdateWindow({
    appRoot: app.getAppPath(),
    state: () => updateController?.current ?? { phase: 'idle' },
    onAction: (action) => {
      if (action === 'check') void updateController?.check(true)
      else if (action === 'download') void updateController?.download()
      else if (action === 'install') void requestInstall()
      else {
        // "稍后" must actually dismiss: resetting the state published the same content back to the
        // same open window, so the button looked dead (reported by a user).
        updateController?.dismiss()
        updateWindow?.close()
      }
    },
    isShellDocument: isLauncherSender,
  })
  window.install()
  updateWindow = window

  updateController = new UpdateController({
    currentVersion: app.getVersion(),
    updatesDir,
    onState: (state) => { window.publish(state) },
    onAvailable: (version) => {
      pushLog(`发现新版本 ${version}`)
      if (!smoke) window.open()
    },
    onInstall: (installer) => {
      // The installer takes over from here; `close` must not ask again.
      quitAllowed = true
      pendingInstaller = installer
      // Say what is happening while it still can be seen. The NSIS run is silent and this process is
      // about to exit, so a user who watched the window vanish assumed a working update had failed
      // (reported). A system notification also outlives us in the Action Center, and the short delay
      // is the time the update window needs to render the "installing" phase before it goes.
      const target = updateController?.current.version
      showNotification({
        title: `${PRODUCT_NAME} 正在安装更新`,
        body: target === undefined
          ? '应用即将关闭以完成安装，装好后会自动重新打开。'
          : `正在安装 v${target}，应用会自动重新打开。`,
      })
      setTimeout(() => { app.quit() }, INSTALL_HANDOFF_MS)
    },
  })

  if (smoke) return
  // The DSH settings page owns this switch; the tray and menu can always check by hand.
  // The debug channel skips the automatic checks entirely: it shares the release feed, so
  // accepting an update there would install a release build into the release directory.
  if (shellSettings.updates.checkDesktopOnStart && channelSettings.autoUpdateCheck) {
    const startup = setTimeout(() => { void updateController?.check(true) }, UPDATE_STARTUP_DELAY_MS)
    startup.unref()
    updateTimer = setInterval(() => { void updateController?.check(true) }, UPDATE_CHECK_INTERVAL_MS)
    updateTimer.unref()
  }
}

/** Confirm that installing now would not throw away running work, then install. */
async function requestInstall(): Promise<void> {
  if (!await confirmInterrupt('安装更新', '继续安装')) {
    updateWindow?.open()
    return
  }
  updateController?.install()
}

/**
 * Test-only: verify a real minisign signature inside the app's own runtime.
 *
 * This is the guard for a bug that shipped in 0.3.8: verification used
 * `crypto.createHash('blake2b512')`, which Node has and Electron's BoringSSL does not, so the
 * app could never verify a downloaded installer — every update failed with
 * `Digest method not supported`. Unit tests and the release scripts all run on Node, which is
 * why only a check inside the app can catch it.
 */
async function driveSmokeMinisign(): Promise<void> {
  const artifact = Buffer.from(minisignSmokeFixture.artifactBase64, 'base64')
  const started = Date.now()
  const good = await verifyMinisign(artifact, minisignSmokeFixture.signature, updatePublicKey())
  const verifiedMs = Date.now() - started

  const altered = Buffer.from(artifact)
  altered[0] = (altered[0] ?? 0) ^ 0x01
  const tampered = await verifyMinisign(altered, minisignSmokeFixture.signature, updatePublicKey())

  let openSslHasBlake2b = true
  try {
    createHash('blake2b512')
  } catch {
    openSslHasBlake2b = false
  }

  // Time the fallback over a sample, because the real installer is ~190 MB and the whole
  // verification happens on the main process.
  const sample = randomBytes(24 * 1024 * 1024)
  const hashStarted = Date.now()
  await blake2b512Chunked(sample)
  const elapsed = Date.now() - hashStarted

  const report = {
    ok: good.ok,
    reason: good.ok ? null : good.reason,
    signatureKeyIdMatched: good.ok,
    tamperedRejected: tampered.ok === false,
    fixtureSha256: createHash('sha256').update(artifact).digest('hex'),
    expectedSha256: minisignSmokeFixture.artifactSha256,
    usesOpenSslBlake2b: openSslHasBlake2b,
    javascriptHashMBps: openSslHasBlake2b || elapsed === 0 ? null : Math.round(24 / (elapsed / 1000)),
    verifiedMs,
  }
  try {
    writeFileSync(join(bridgeDir(), 'minisign-smoke.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  } catch {
    // Diagnostics only.
  }
  app.exit(report.ok && report.tamperedRejected ? 0 : 1)
}

/**
 * Test-only: open both title-bar menus and record what they contain.
 *
 * There is no native menu bar to check any more, so without this a refactor could silently
 * leave the window with no way to reload or export diagnostics.
 */
async function driveSmokeMenu(): Promise<void> {
  const report: Record<string, unknown> = {}
  for (const name of ['app'] as const) {
    let labels: readonly string[] = []
    let menu: Electron.Menu | undefined
    const closed = new Promise<boolean>((resolve) => {
      void popupShellMenu(name, { x: 40, y: 0, height: TITLEBAR_HEIGHT }, {
        onItems: (items) => { labels = items },
        onMenu: (created) => { menu = created },
      }).then(resolve)
    })
    await new Promise<void>((resolve) => { setTimeout(resolve, 500) })
    menu?.closePopup()
    report[name] = { opened: await closed, labels }
  }
  // The logo is an image on a `file://` page, so a missing `img-src` in its CSP blocks it
  // silently — which shipped once and left the title bar with no icon.
  if (titleBarView !== undefined && !titleBarView.webContents.isDestroyed()) {
    const logo = await titleBarView.webContents.executeJavaScript(`(() => {
      const image = document.querySelector('img#icon');
      if (!image) return { found: false };
      return { found: true, complete: image.complete, naturalWidth: image.naturalWidth, rendered: image.getBoundingClientRect().width };
    })()`) as Record<string, unknown>
    report.titleBarLogo = logo
  }
  try {
    writeFileSync(join(bridgeDir(), 'menu-smoke.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  } catch {
    // Diagnostics only.
  }
  app.exit(0)
}

/**
 * Test-only: crash the renderer on purpose and record what the shell did about it.
 *
 * The claim being verified is user-visible behaviour — a crashed renderer must not leave a
 * white window. It has to be produced, not asserted from reading the code.
 */
async function driveSmokeCrash(): Promise<void> {
  const window = mainWindow
  // The page lives in the content view now; crashing the window's own (empty) webContents
  // would test nothing.
  const contents = pageContents()
  if (window === undefined || window.isDestroyed() || contents === undefined) return
  const before = contents.getURL()
  contents.forcefullyCrashRenderer()
  await new Promise<void>((resolve) => { setTimeout(resolve, 3_000) })
  const afterContents = pageContents()
  const after = afterContents === undefined ? '(contents gone)' : afterContents.getURL()
  const report = {
    ok: !window.isDestroyed(),
    before,
    after,
    recoveredToLauncher: after.startsWith('file://'),
    logs: logs.filter(line => /崩溃|界面|子进程|无响应/.test(line)).slice(-6),
  }
  try {
    writeFileSync(join(bridgeDir(), 'crash-smoke.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  } catch {
    // Diagnostics only.
  }
  app.exit(report.ok ? 0 : 1)
}

/**
 * Test-only: prove the notification plugin's emit actually reaches the shell.
 *
 * The plugin's client half emits its own `tauriEventName` (default `dsh-notify`) through the preload's
 * Tauri-compatible bridge. The shell once allowlisted the *package* name `dsh-win-notify` instead, and
 * because `emit` resolves either way, the plugin believed the shell had shown the notification and
 * skipped its own browser fallback — the user saw nothing, with no error anywhere. This driver emits
 * one name the shell accepts and one it refuses, from the real product page, and records what happened
 * to each. Enabled by `DSH_DESKTOP_SMOKE_NOTIFY=1`.
 */
async function driveSmokeNotify(): Promise<void> {
  const report: Record<string, unknown> = {}
  const deadline = Date.now() + 30_000
  for (;;) {
    const contents = pageContents()
    if (contents !== undefined && !contents.isDestroyed() && contents.getURL().startsWith('http://127.0.0.1:')) break
    if (Date.now() > deadline) break
    await new Promise<void>((resolve) => { setTimeout(resolve, 250) })
  }
  const contents = pageContents()
  if (contents === undefined || contents.isDestroyed()) {
    report.error = '产品页未就绪，无法演练通知链路'
  } else {
    const before = { accepted: notificationEventCount, refused: refusedEmitCount }
    // Exactly what the plugin does: `tauri.event.emit(name, payload)`.
    report.bridge = await contents.executeJavaScript(`(() => {
      const event = globalThis.__TAURI__ && globalThis.__TAURI__.event;
      return { present: typeof event?.emit === 'function', listen: typeof event?.listen === 'function' };
    })()`) as Record<string, unknown>
    await contents.executeJavaScript(`globalThis.__TAURI__.event.emit('dsh-notify', { title: '冒烟通知', body: '通知链路演练', sessionId: 'smoke' })`)
    // A name no allowlist carries: it must be refused *and* reported, never silently dropped.
    await contents.executeJavaScript(`globalThis.__TAURI__.event.emit('dsh-drifted-plugin', { title: 'x' })`)
    await new Promise<void>((resolve) => { setTimeout(resolve, 1_000) })
    report.accepted = notificationEventCount - before.accepted
    report.refused = refusedEmitCount - before.refused
    report.logs = logs.filter(line => /系统通知|未知事件/.test(line)).slice(-4)
  }
  report.ok = report.accepted === 1 && report.refused === 1
  try {
    writeFileSync(join(bridgeDir(), 'notify-smoke.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  } catch {
    // Diagnostics only.
  }
  app.exit(report.ok === true ? 0 : 1)
}

/**
 * Test-only: drive the whole update path with no window, so a real upgrade (download →
 * minisign verify → installer replaces a 361 MiB runtime tree → relaunch) can be
 * rehearsed on an actual installation. Enabled by `DSH_DESKTOP_SMOKE_UPDATE=1`; each
 * phase is written to `update-smoke.json` in userData, which is the only way to observe a
 * process that exits to let the installer run.
 */
async function driveSmokeUpdate(): Promise<void> {
  const path = join(bridgeDir(), 'update-smoke.json')
  const report = (phase: string, extra: Record<string, unknown> = {}): void => {
    try {
      writeFileSync(path, `${JSON.stringify({ phase, at: Date.now(), ...extra }, null, 2)}\n`, 'utf8')
    } catch (error) {
      pushLog(`写入更新冒烟结果失败：${String(error)}`)
    }
  }

  const controller = updateController
  if (controller === undefined) { report('failed', { message: '更新控制器未初始化' }); return }

  report('checking')
  const checked = await controller.check(false)
  if (checked.phase !== 'available') {
    report('failed', { message: `没有可用更新（phase=${checked.phase}）`, detail: checked.detail })
    return
  }
  report('available', { version: checked.version })

  const downloaded = await controller.download()
  if (downloaded.phase !== 'ready') {
    report('failed', { message: `下载或验签失败（phase=${downloaded.phase}）`, version: downloaded.version, detail: downloaded.detail })
    return
  }
  report('verified', { version: downloaded.version })

  report('installing', { version: downloaded.version })
  const started = controller.install()
  report(started ? 'install-requested' : 'failed', { version: downloaded.version, message: started ? undefined : 'install() 拒绝启动' })
}

/**
 * Offer once to remove a leftover Tauri installation.
 *
 * Deliberately in the shell rather than in NSIS: `ExecWait` on another product's
 * uninstaller has no timeout and would hang the install. Here it has a bound, a log,
 * and only runs after the user agrees.
 */
async function offerLegacyCleanup(): Promise<void> {
  const directory = bridgeDir()
  // Only the shipped app migrates a Tauri install; the debug channel must never offer to
  // uninstall the user's working copy.
  if (!channelSettings.legacyCleanup) return
  if (smoke || process.platform !== 'win32' || legacyPromptAlreadyOffered(directory)) return
  if (process.env[SKIP_LEGACY_CLEANUP_ENV] === '1') return
  const legacy = await findLegacyInstalls(app.getPath('exe')).catch(() => [])
  if (legacy.length === 0) return
  markLegacyPromptOffered(directory)
  const first = legacy[0]
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['卸载旧版', '稍后'],
    defaultId: 0,
    cancelId: 1,
    title: '检测到旧版 DSH Desktop',
    message: `检测到旧版（Tauri 版）DSH Desktop${first?.displayVersion === undefined || first.displayVersion === '' ? '' : ` ${first.displayVersion}`}`,
    detail: '当前版本可以独立运行。是否现在卸载旧版，避免出现两个「DSH Desktop」？',
  })
  if (response !== 0) return
  for (const install of legacy) {
    const result = await removeInstall(install)
    pushLog(`旧版卸载 ${install.key}：${result.ok ? '完成' : `失败（${result.detail}）`}`)
  }
}

/** Hand the authentication cookie to WebSocket handshakes from the product window. */function installWebSocketCookie(): void {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['ws://127.0.0.1/*', 'ws://localhost/*'] },
    (details, callback) => {
      const fromProductWindow = mainWindow !== undefined
        && !mainWindow.isDestroyed()
        && details.webContentsId === pageContents()?.id
      if (!fromProductWindow || cookieHeader === undefined) {
        callback({})
        return
      }
      callback({ requestHeaders: { ...details.requestHeaders, Cookie: cookieHeader } })
    },
  )
}

/**
 * Smoke-only observation: record WebSocket handshakes and their failures. The
 * product window's own WS traffic is otherwise invisible, and proxy mode is exactly
 * the case where the page and the host are different origins.
 */
function installWebSocketObservation(): void {
  if (!smoke) return
  const filter = { urls: ['ws://*/*', 'wss://*/*'] }
  session.defaultSession.webRequest.onBeforeRequest(filter, (details, callback) => {
    if (wsAttempts.length < 50) wsAttempts.push(details.url)
    callback({})
  })
  session.defaultSession.webRequest.onErrorOccurred(filter, (details) => {
    if (wsErrors.length < 50) wsErrors.push(`${details.url} → ${details.error}`)
  })
}

async function boot(): Promise<void> {
  // The DSH settings page is the source of truth; read it into module state so runtime
  // actions (close behaviour, update switches) see the same values.
  // Materialise the channel's default port first: the DSH panel defaults a missing
  // `service.port` to the release port (41729), which would pull the debug channel onto
  // the port the shipping app uses as soon as the user saved anything on that page.
  if (ensureServicePort(channelSettings.defaultPort)) {
    pushLog(`设置文件缺 service.port，已写入本通道默认端口 ${String(channelSettings.defaultPort)}`)
  }
  shellSettings = readShellSettings()
  const port = resolvePort(shellSettings.servicePort, channelSettings.defaultPort)
  activePort = port
  const entry = resolveDshEntry()

  mainWindow = createMainWindow()
  proxyDocumentHost = proxyOriginMode === 'loopback' ? `127.0.0.1:${String(port)}` : 'app'
  installProxyHandler({
    host: () => hostOrigin,
    cookie: () => cookieHeader,
    shellRoot: launcherRoot(),
    documentHost: proxyDocumentHost,
    onRequest: (info) => {
      if (!smoke) return
      if (proxyRequests.length < 200) proxyRequests.push(info)
    },
  })
  installWebSocketCookie()
  installWebSocketObservation()
  installPanelBridge()
  installBrowserPanel()
  if (shellSettings.browser.enabled) {
    await startBrowserTools()
  } else {
    pushLog('侧边栏浏览器已在设置中关闭：本次不注入浏览器工具（面板 tab 也不会注册）')
  }
  installUpdates()
  installSettingsWindow()

  // A bundled runtime is the executable half of the product: verify it is the tree that
  // was packaged before spawning anything. A system dsh is used only when the app has no
  // bundled runtime (development, or an older build).
  const bundled = bundledRuntimeRoot()
  const binDir = runtimeBinDir()
  // pnpm's JavaScript entry: run it with our own binary rather than the `.cmd` shim, so
  // an install directory containing spaces cannot break the command line.
  const pnpmEntry = bundled === undefined ? undefined : bundledPnpmEntry()
  /** pnpm version the bundled runtime ships; decides whether an existing profile needs relinking. */
  let runtimePnpmVersion: string | undefined
  if (bundled !== undefined) {
    const verification = verifyRuntime({
      root: bundled,
      electron: process.versions.electron,
      platform: process.platform,
      arch: process.arch,
    })
    if (!verification.ok) {
      const message = describeRuntimeFailure(verification)
      pushLog(`随包运行时校验失败：${verification.reason}${verification.detail === undefined ? '' : ` — ${verification.detail}`}`)
      publish({ phase: 'failed', message, port, loadMode })
      if (!smoke) showMainWindow()
      finishSmoke({ ok: false, stage: 'runtime', message, reason: verification.reason, logs })
      return
    }
    runtimeInfo = {
      source: 'bundled',
      version: verification.manifest.dsh,
      files: verification.manifest.files,
      // The shell version the runtime tree was produced for. This is the observable
      // proof that an upgrade replaced `resources/runtime`, not just `app.asar`.
      shell: verification.manifest.shell,
    }
    pushLog(`随包运行时校验通过：dsh ${verification.manifest.dsh}，${String(verification.manifest.files)} 个文件`)
    runtimePnpmVersion = verification.manifest.pnpm
  } else {
    runtimeInfo = { source: 'system' }
    pushLog('未发现随包运行时，改用 PATH 中的 dsh')
  }

  // The shell boots its own profile; `dsh` refuses to boot one that does not exist, so a
  // first run seeds it from the shipped `web` profile and installs those plugins with the
  // bundled pnpm.
  const home = harnessHome() ?? harnessHomeFrom(process.env)
  profileSeed = ensureDesktopProfile(home, channelSettings.profileName)
  // A profile seeded by an earlier version (<= 0.3.7) has neither the user layer nor the
  // packages its patch names. Repair it once; `missingLinks` is then installed below.
  const repair = repairSeededProfile(home, channelSettings.profileName)
  if (repair.repaired) {
    pushLog(`已补齐桌面端 profile 的用户层：${repair.copied.join('、')}${repair.missingLinks.length === 0 ? '' : `，并需安装 ${String(repair.missingLinks.length)} 个本地插件`}`)
  }
  pushLog(profileSeed.created
    ? `已创建桌面端 profile：${profileSeed.path}（bundle 列表来自 ${profileSeed.seededFrom}，${String(profileSeed.bundles.length)} 项）`
    : `复用已有桌面端 profile：${profileSeed.path}`)

  // pnpm versions its content store by its own major and rejects a `node_modules` linked from a
  // different one (`ERR_PNPM_UNEXPECTED_STORE`). A bundled-pnpm upgrade across a major therefore
  // leaves every existing profile broken for `dsh plugin …` until it is relinked — reported here and
  // fixed with the same `pnpm install` the profile install path already runs. The lockfile decides
  // the dependency set; the store only decides where the bytes come from, so this is a migration.
  //
  // The record of "already relinked" lives in the shell's own state: pnpm keeps no store version in
  // the workspace state it writes, and leaves a profile's `.modules.yaml` alone when there was
  // nothing to install — reading only that file would purge and reinstall the profile on every start.
  const migratedStore = readStoreMigration(profileSeed.path)
  const storeMismatch = profileStoreMismatch(profileSeed.path, runtimePnpmVersion ?? '', migratedStore)
  if (storeMismatch !== undefined) {
    pushLog(`桌面端 profile 的依赖由 pnpm ${storeMismatch.from} 链接，随包 pnpm 为 ${storeMismatch.to}：需要重新链接一次（不改依赖）`)
  }
  // Awaited and done *before* the host starts. pnpm's relink deletes `node_modules` first, so doing it
  // while `dsh` is running would fail on the files it holds open (Windows refuses to unlink them), and
  // tying it to the page load would leave a profile that cannot boot unmigrated forever.
  if (profileSeed !== undefined && storeMismatch !== undefined && pnpmEntry !== undefined) {
    const seed = profileSeed
    // pnpm's purge deletes the whole `node_modules`, and only `package.json`/the lockfile come back. A
    // plugin linked by hand (or by a `dsh plugin` call that never reached `package.json`) is only a
    // symlink there, while the profile's patch still names it — so the links are restored afterwards.
    const linkedBefore = linkedPackages(seed.path)
    pushLog(`正在重新链接桌面端 profile 的依赖（pnpm ${storeMismatch.from} → ${storeMismatch.to}，按锁文件，不改依赖；可能需要几分钟）…`)
    const relinked = await installProfileDependencies({
      path: seed.path,
      nodeExecutable: process.execPath,
      pnpmEntry,
      run: runProfileCommand,
    })
    pushLog(`重新链接：${relinked.ok ? '完成' : `失败（${relinked.detail}）`}`)
    if (relinked.ok) {
      const restored = linkedBefore.filter(entry => !existsSync(join(seed.path, 'node_modules', entry.name)))
      for (const entry of restored) {
        try {
          relinkPackage(seed.path, entry)
        } catch (error) {
          pushLog(`本地插件链接恢复失败：${entry.name} — ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (restored.length > 0) pushLog(`已恢复 ${String(restored.length)} 个本地插件链接：${restored.map(entry => entry.name).join('、')}`)
      writeStoreMigration(seed.path, storeMismatch.to)
    }
  }

  ipcMain.handle(IPC.titlebarState, (event) => {
    if (event.sender !== titleBarView?.webContents) {
      throw new Error('dsh desktop: rejected title bar IPC from an unowned renderer')
    }
    return { productName: PRODUCT_NAME, version: app.getVersion() }
  })

  ipcMain.handle(IPC.titlebarMenu, async (event, name: unknown, anchor: unknown) => {
    // Only the strip may open shell menus; the product page has no business doing so.
    if (event.sender !== titleBarView?.webContents) {
      throw new Error('dsh desktop: rejected title bar IPC from an unowned renderer')
    }
    if (name !== 'app') return false
    const rect = typeof anchor === 'object' && anchor !== null ? anchor as Record<string, unknown> : undefined
    const valid = rect !== undefined
      && typeof rect.x === 'number' && typeof rect.y === 'number' && typeof rect.height === 'number'
    return popupShellMenu(name, valid ? { x: rect.x as number, y: rect.y as number, height: rect.height as number } : undefined)
  })

  ipcMain.handle(IPC.launcherSubscribe, (event) => {
    if (!isLauncherSender(event.senderFrame?.url ?? '')) {
      throw new Error('dsh desktop: rejected launcher IPC from an unowned renderer')
    }
    return status
  })

  ipcMain.handle(IPC.launcherEnter, (event) => {
    if (!isLauncherSender(event.senderFrame?.url ?? '')) {
      throw new Error('dsh desktop: rejected launcher IPC from an unowned renderer')
    }
    // Only from the status page, and only once the service is up: otherwise the click would
    // just bounce back to this same page.
    if (status.phase !== 'ready' || hostOrigin === undefined) return false
    reloadProductDocument()
    return true
  })

  publish({ phase: 'checking', message: '正在检查启动条件…', port, loadMode, version: app.getVersion() })

  const gate = await runGates(entry, port, (attempt, remainingMs) => {
    pushLog(`端口 ${String(port)} 暂被占用，等待中（第 ${String(attempt)} 次，剩余 ${String(Math.ceil(remainingMs / 1000))} 秒）`)
  })
  if (!gate.ok) {
    pushLog(`${gate.message}${gate.detail === undefined ? '' : ` — ${gate.detail}`}`)
    publish({ phase: gate.phase, message: gate.message, ...(gate.detail === undefined ? {} : { detail: gate.detail }), port, loadMode })
    if (!smoke) showMainWindow()
    finishSmoke({ ok: false, stage: 'gates', message: gate.message })
    return
  }

  pushLog(`闸门通过：dsh ${gate.version}，端口 ${String(gate.port)}`)
  activeDshVersion = gate.version
  publish({ phase: 'starting', message: `正在启动 DSH Web（端口 ${String(gate.port)}）…`, version: gate.version, port, loadMode })

  const noOpen = await supportsNoOpen(entry as string)
  const child = new DshHostProcess({
    entry: entry as string,
    version: gate.version,
    port: gate.port,
    appVersion: app.getVersion(),
    loadMode,
    proxy: shellSettings.proxy,
    noOpen,
    profileName: process.env[PROFILE_ENV] === undefined || process.env[PROFILE_ENV] === ''
      ? channelSettings.profileName
      : process.env[PROFILE_ENV] as string,
    ...binDir === undefined ? {} : { runtimeBinDir: binDir },
    // The `pnpm.cmd` shim cannot reach pnpm by a relative path once the runtime is inside the ASAR.
    ...pnpmEntry === undefined ? {} : { pnpmEntry },
    ...agentBridge === undefined ? {} : { agentMcp: { url: agentBridge.url, token: agentBridge.token } },
    // Which surface publishes the tools is decided in `startBrowserTools()` (before this).
    // Native mode hands the plugin the direct call endpoint; MCP mode leaves the overlay row.
    toolSurface: {
      injectMcp: toolSurface?.injectMcp ?? true,
      ...toolSurface?.nativeTools === true && agentBridge !== undefined
        ? { nativeTools: { callUrl: agentBridge.callUrl, registeredUrl: agentBridge.registeredUrl, token: agentBridge.token } }
        : {},
    },
    onLog: (stream, line) => { pushLog(`[${stream}] ${line}`) },
  })
  host = child

  let ready
  try {
    ready = await child.start()
  } catch (error) {
    const message = `DSH Web 启动失败：${String(error instanceof Error ? error.message : error)}`
    pushLog(message)
    publish({ phase: 'failed', message, port, loadMode })
    if (!smoke) showMainWindow()
    finishSmoke({ ok: false, stage: 'host-start', message, logs })
    return
  }

  hostOrigin = new URL(ready.bareUrl).origin
  writeFacts({
    desktopVersion: app.getVersion(),
    panelInjected: child.injectedPanel,
    dshUrl: `${hostOrigin}/`,
    dshPort: ready.port,
    dshVersion: gate.version,
    dshManaged: true,
    dshBrowserAuth: true,
    runtime: runtimeInfo ?? { source: 'system' },
    ...mainWindow === undefined || mainWindow.isDestroyed() ? {} : {
      window: {
        bounds: mainWindow.getNormalBounds(),
        maximized: mainWindow.isMaximized(),
        restored: windowGeometryRestored,
      },
    },
    ...profileSeed === undefined ? {} : {
      profile: {
        name: process.env[PROFILE_ENV] === undefined || process.env[PROFILE_ENV] === ''
          ? channelSettings.profileName
          : process.env[PROFILE_ENV] as string,
        path: profileSeed.path,
        seededFrom: profileSeed.seededFrom,
        dependencies: Object.keys(profileSeed.dependencies).length,
      },
    },
    // Reported on the settings page: "on but no tools" must not look like "working".
    browser: {
      enabled: shellSettings.browser.enabled,
      tools: agentBridge === undefined ? 0 : BROWSER_TOOLS.length,
      bridge: agentBridge !== undefined,
      // Which surface publishes the tools, and why (the fallback reason is user-visible).
      toolSurface: toolSurface?.mode ?? 'mcp',
      toolSurfaceReason: toolSurface?.reason ?? '',
      nativeToolCount: readToolRegistrationRecord()?.count ?? 0,
    },
  })

  cookieHeader = await authenticate(ready.authUrl, ready.port)
  if (cookieHeader === undefined && loadMode !== 'token') {
    pushLog('回退：无法换取 cookie，改用一次性认证地址导航（与 Tauri 版行为一致）')
  }

  const target = loadMode === 'proxy'
    ? `dsh-app://${proxyDocumentHost}/`
    : cookieHeader === undefined ? ready.authUrl : ready.bareUrl
  pushLog(`加载模式 ${loadMode}，导航目标 ${target}`)

  const contents = pageContents()
  if (contents === undefined) throw new Error('主窗口内容视图未就绪')
  await contents.loadURL(target)
  if (loadMode === 'token' && cookieHeader === undefined) {
    // SameSite=Strict means the cookie is not sent on the cross-site 303 hop; the
    // Tauri shell re-navigates the bare address for the same reason.
    setTimeout(() => { void pageContents()?.loadURL(ready.bareUrl) }, 400)
  }

  publish({ phase: 'ready', message: 'DSH 已就绪', version: gate.version, port, loadMode })

  // First run: the seeded profile declares the plugins that were in the CLI's `web`
  // profile, and none of them are installed yet. Install them with the bundled pnpm in
  // the background so the window opens immediately; a restart applies them.
  // Retried on every start while the dependencies are declared but not installed, so a
  // first attempt that failed (no network, a bad package-manager call) heals itself.
  if (profileSeed !== undefined && (profileNeedsInstall(profileSeed) || repair.missingLinks.length > 0) && pnpmEntry !== undefined) {
    const seed = profileSeed
    const additions = repair.missingLinks
    void (async () => {
      pushLog(`正在用随包 pnpm ${additions.length > 0 ? `补齐 ${String(additions.length)} 个本地插件` : '安装桌面端 profile 的插件'}（可能需要几分钟）…`)
      profileInstall = await installProfileDependencies({
        path: seed.path,
        nodeExecutable: process.execPath,
        pnpmEntry,
        ...additions.length === 0 ? {} : { additions },
        run: runProfileCommand,
      })
      pushLog(`桌面端 profile 插件安装：${profileInstall.ok ? '完成（重启后生效）' : `失败（${profileInstall.detail}）`}`)
      // Durable: an in-memory log disappears with the process, and a silent failure is
      // what left a real profile without its plugins.
      try {
        writeFileSync(join(bridgeDir(), 'profile-install.json'), `${JSON.stringify({
          at: Date.now(), ok: profileInstall.ok, detail: profileInstall.detail, profile: seed.path, dependencies: Object.keys(seed.dependencies),
        }, null, 2)}\n`, 'utf8')
      } catch {
        // Diagnostics only.
      }
      pushPanelState()
    })()
  }

  if (!smoke) {
    mainWindow.show()
    mainWindow.focus()
    void offerLegacyCleanup()
  }
  finishSmoke(await smokeResult(gate.version, ready.port, target))

  // Upgrade rehearsal: drive the update path with no window. Last, so the normal smoke
  // result is already on disk before this exits the app to hand over to the installer.
  if (process.env[SMOKE_UPDATE_ENV] === '1') await driveSmokeUpdate()
  if (process.env[SMOKE_NOTIFY_ENV] === '1') await driveSmokeNotify()
  if (process.env[SMOKE_CRASH_ENV] === '1') await driveSmokeCrash()
  if (process.env[SMOKE_MENU_ENV] === '1') await driveSmokeMenu()
  if (process.env[SMOKE_MINISIGN_ENV] === '1') await driveSmokeMinisign()
  if (process.env[SMOKE_SUPPORT_ENV] === '1') {
    const path = await collectSupportBundle()
    const raw = readFileSync(path, 'utf8')
    writeFileSync(join(bridgeDir(), 'support-smoke.json'), `${JSON.stringify({
      path,
      bytes: raw.length,
      // The two things a support bundle must never contain.
      containsToken: /token=[A-Za-z0-9_-]{8,}/u.test(raw),
      containsProxyCredentials: /:\/\/[^/@\s]+:[^/@\s]+@/u.test(raw),
      hasLogs: raw.includes('已创建桌面端 profile') || raw.includes('闸门通过'),
    }, null, 2)}\n`, 'utf8')
    app.exit(0)
  }
}

/** Probe the loaded document. Used by the smoke run; cheap enough to always compute. */
async function smokeResult(version: string, port: number, target: string): Promise<Record<string, unknown>> {
  const base = {
    ok: true,
    stage: 'ready',
    loadMode,
    version,
    port,
    entry: resolveDshEntry() ?? null,
    overlay: host?.overlayPath ?? null,
    panelInjected: host?.injectedPanel ?? false,
    cookieAcquired: cookieHeader !== undefined,
    target,
    userData: bridgeDir(),
    dshHome: harnessHome() ?? null,
    proxyDocumentHost,
    /** Window chrome: fixed title, and the strip above the product page. */
    windowTitle: mainWindow === undefined || mainWindow.isDestroyed() ? null : mainWindow.getTitle(),
    titleBar: mainWindow === undefined || mainWindow.isDestroyed() ? null : {
      height: TITLEBAR_HEIGHT,
      document: titleBarView === undefined || titleBarView.webContents.isDestroyed() ? null : titleBarView.webContents.getURL(),
      windowContentHeight: mainWindow.getContentBounds().height,
      contentTop: contentView?.getBounds().y ?? null,
      contentHeight: contentView?.getBounds().height ?? null,
      nativeMenuBar: Menu.getApplicationMenu() === null ? 'removed' : 'present',
    },
    /** Which dsh runtime served this run: the bundled tree or a system install. */
    runtime: runtimeInfo ?? null,
    /** The profile this run booted, and how it was seeded. */
    profile: profileSeed === undefined
      ? null
      : { path: profileSeed.path, created: profileSeed.created, seededFrom: profileSeed.seededFrom, bundles: profileSeed.bundles.length, dependencies: Object.keys(profileSeed.dependencies).length },
    profileInstall: profileInstall ?? null,
    logs,
  }
  if (!smoke) return base
  // Give the SPA time to open its stream and pull its plugin bundles; otherwise the
  // observation below reports an empty, falsely clean picture.
  await new Promise((resolve) => { setTimeout(resolve, 4_000) })
  try {
    const probe = await pageContents()?.executeJavaScript(
      `(async () => { try {
          const bridge = globalThis.__TAURI__ && globalThis.__TAURI__.event
          const hasBridge = Boolean(bridge && typeof bridge.emit === 'function' && typeof bridge.listen === 'function')
          let listened = false
          if (hasBridge) {
            const off = await bridge.listen('dsh-desktop-state', () => { listened = true })
            if (typeof off === 'function') off()
            // One allowed action, then one rejected action and one rejected event name.
            await bridge.emit('dsh-desktop-shell', { action: 'settings-changed' })
            await bridge.emit('dsh-desktop-shell', { action: 'not-an-action' })
            await bridge.emit('not-allowed-event', { action: 'settings-changed' })
          }
          return { href: location.href, origin: location.origin, title: document.title,
                   readyState: document.readyState,
                   root: Boolean(document.querySelector('#root, #app, [data-dsh-root]')),
                   nodes: document.querySelectorAll('*').length,
                   hasTauriBridge: hasBridge, listenReturnedUnlisten: hasBridge,
                   text: (document.body ? document.body.innerText : '').slice(0, 300) }
        } catch (error) { return { probeThrew: String(error) } } })()`,
    ) as Record<string, unknown> | undefined
    // Give the accepted action a moment to reach the main process.
    await new Promise((resolve) => { setTimeout(resolve, 500) })
    return {
      ...base,
      probe,
      proxyRequests,
      wsAttempts,
      wsErrors,
      pluginBundleRequests: proxyRequests.filter(entry => entry.path.startsWith('/plugins/')).length,
      // Panel bridge (P2): the plugin's own readiness/task routes, plus proof that the
      // page's Tauri-shaped event bridge reaches the shell for exactly one of three
      // emitted messages.
      panelReady: await panelBridge?.ready() ?? false,
      tasks: await panelBridge?.tasks() ?? { answer: 'unknown', reason: 'no-bridge', families: [] },
      panelSettings: panelBridge === undefined
        ? { read: false, write: false, error: 'no-bridge' }
        : await checkSettingsRoundTrip(panelBridge),
      panelEventCount,
      // Detection is observable here so a real machine with a Tauri install can prove
      // the matching rules without removing anything.
      legacyInstalls: process.platform === 'win32'
        ? await findLegacyInstalls(app.getPath('exe')).catch(() => [])
        : [],
    }
  } catch (error) {
    return { ...base, probeError: String(error), proxyRequests, wsAttempts, wsErrors }
  }
}

function finishSmoke(result: Record<string, unknown>): void {
  if (!smoke) return
  // A packaged build is a GUI-subsystem binary: its stdout may reach no console at all,
  // so the verdict is also written next to the shell's data where the runner reads it.
  try {
    writeFileSync(join(bridgeDir(), 'smoke-result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  } catch {
    // Diagnostics only.
  }
  process.stdout.write(`SMOKE_RESULT ${JSON.stringify(result)}\n`)
  setTimeout(() => { app.exit(result.ok === true ? 0 : 1) }, 300)
}

// A smoke run must never hang the caller.
if (smoke) {
  setTimeout(() => {
    process.stdout.write(`SMOKE_RESULT ${JSON.stringify({ ok: false, stage: 'timeout', logs })}\n`)
    app.exit(3)
  }, 180_000).unref()
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => { showMainWindow() })

  app.whenReady().then(async () => {
    // No native menu bar: the strip's buttons pop these submenus up instead.
    Menu.setApplicationMenu(null)

    tray = createTray({
      show: showMainWindow,
      about: () => { showAbout() },
      quit: () => { app.quit() },
    }, PRODUCT_NAME)

    try {
      await boot()
    } catch (error) {
      const message = `桌面壳启动失败：${String(error instanceof Error ? error.message : error)}`
      pushLog(message)
      publish({ phase: 'failed', message })
      if (!smoke) showMainWindow()
      finishSmoke({ ok: false, stage: 'boot', message, logs })
    }
  }).catch((error: unknown) => {
    process.stderr.write(`dsh desktop: whenReady failed: ${String(error)}\n`)
    app.exit(1)
  })
}

app.on('window-all-closed', () => { app.quit() })

// GPU and utility processes come and go; a crash here usually recovers by itself, but it
// explains a hiccup in a support log.
app.on('child-process-gone', (_event, details) => {
  pushLog(`子进程退出：type=${details.type} reason=${details.reason}${details.type === 'GPU' ? '（GPU 进程崩溃通常会自动恢复）' : ''}`)
})

app.on('before-quit', (event) => {
  if (stopping) return
  stopping = true
  event.preventDefault()
  if (updateTimer !== undefined) clearInterval(updateTimer)
  void (async () => {
    // Stop the host first: it holds files the installer may need to replace.
    await host?.stop().catch(() => {})
    await agentBridge?.close().catch(() => {})
    agentBridge = undefined
    if (pendingInstaller !== undefined) {
      pushLog(`运行已校验的安装包：${pendingInstaller}`)
      launchInstaller(pendingInstaller)
    }
    app.exit(0)
  })()
})

export { existsSync }
