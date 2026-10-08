/**
 * Shell-wide constants. Ports, environment variable names, and IPC channel names
 * stay in one place so the Electron shell keeps the same contract as the Tauri one.
 */

export const PRODUCT_NAME = 'DSH Desktop'

/** Fixed loopback port. Same default as the Tauri shell, overridable by `DSH_DESKTOP_PORT`. */
export const DEFAULT_DSH_PORT = 41729
export const LOOPBACK = '127.0.0.1'

/**
 * The shell draws its own title bar.
 *
 * Windows cannot put a native menu bar into the title bar the way macOS does, so the only
 * way to have the menu *in* the title row is to own that row: a frameless window with a
 * native caption overlay, plus a strip of our own that the product page never sees.
 */
export const TITLEBAR_HEIGHT = 36

/** The shell's own settings window. Fixed size: it is a form, not a workspace. */
export const SETTINGS_WINDOW_WIDTH = 560
export const SETTINGS_WINDOW_HEIGHT = 660

/**
 * Window chrome colours, picked from the OS theme.
 *
 * The strip and the caption overlay are window chrome, so they follow the system like a
 * native title bar does. The first version hardcoded a dark pair, which meant a light
 * desktop still got a black bar — reported as "why is this black, and why not the white it
 * used to be".
 */
export const TITLEBAR_THEME = {
  dark: { background: '#0f1115', symbol: '#e8ebf2' },
  light: { background: '#f3f3f3', symbol: '#1f1f1f' },
} as const

/** The palette to use for a given OS theme. */
export function titleBarPalette(useDarkColors: boolean): { background: string; symbol: string } {
  return useDarkColors ? TITLEBAR_THEME.dark : TITLEBAR_THEME.light
}
/** Menus reachable from the title bar's buttons. */
export type ShellMenuName = 'app'
/**
 * How long the port gate keeps waiting for the port to come free, and how often it retries.
 * Covers the one launch where the outgoing Tauri process is still dying: its `dsh` child
 * holds the port until then. Never a fallback to another port (see `waitForPort`).
 */
export const PORT_WAIT_TIMEOUT_MS = 15_000
export const PORT_RETRY_INTERVAL_MS = 500

/** Browser-session authentication (one-time token + `dsh-auth` cookie) starts here. */
export const MINIMUM_DSH_VERSION = '0.1.2-alpha.2'

/** How long to wait for the one-time authentication URL on stdout. */
export const STARTUP_TIMEOUT_MS = 60_000

/** Grace period for the managed dsh child to exit before it is terminated. */
export const HOST_EXIT_TIMEOUT_MS = 8_000

export const DSH_PORT_ENV = 'DSH_DESKTOP_PORT'
/** Bridge directory handed to the dsh child: overlay, settings, and facts live here. */
export const DSH_BRIDGE_DIR_ENV = 'DSH_DESKTOP_BRIDGE_DIR'
/** Override the launcher command (kept for compatibility with the Tauri shell). */
export const DSH_COMMAND_ENV = 'DSH_DESKTOP_DSH_COMMAND'
/** Point directly at the dsh JS entry (`.../@deepseek-ai/dsh/lib/bin.js`). */
export const DSH_ENTRY_ENV = 'DSH_DESKTOP_DSH_ENTRY'
/** Point directly at the panel plugin entry (`.../dsh-desktop-shell/index.js`). */
export const DSH_PLUGIN_PATH_ENV = 'DSH_DESKTOP_PLUGIN_PATH'
/** Root of the runtime that ships inside the app (P0 spike S1). */
export const DSH_BUNDLED_RUNTIME_ENV = 'DSH_DESKTOP_BUNDLED_RUNTIME'
/**
 * pnpm's JavaScript entry, for the bundled `pnpm.cmd` shim.
 *
 * The runtime is packed into the app ASAR, so the shim — which must itself be physical, because
 * cmd.exe starts it — cannot reach pnpm by a relative path any more. The shell knows the exact
 * entry (`bundledPnpmEntry()`), so it tells the shim instead of the shim guessing a layout.
 */
export const DSH_PNPM_ENTRY_ENV = 'DSH_DESKTOP_PNPM_ENTRY'
/** Isolate all shell state; the official shell exposes the same escape hatch. */
export const DSH_USER_DATA_ENV = 'DSH_DESKTOP_USER_DATA_DIR'
/**
 * Which build of the shell this is.
 *
 * The debug channel exists so the new shell can be run **next to** the shipping Tauri app
 * (and next to a release Electron install) without either of them being disturbed: its
 * own install directory, its own userData, its own DSH profile, and — the part that
 * actually decides whether it can start at all — its own default port, because the Tauri
 * app already holds 41729.
 */
export type ShellChannel = 'release' | 'debug' | 'development'

export interface ChannelConfig {
  readonly productName: string
  readonly userDataDirName: string
  readonly defaultPort: number
  readonly profileName: string
  /** Offer to uninstall a leftover Tauri install; only meaningful for the shipped app. */
  readonly legacyCleanup: boolean
  /**
   * Whether startup pulls the published update feed. The debug channel does not: it
   * shares the release feed, and installing a release build from a debug install would
   * move the update into the release directory. Manual checks still work.
   */
  readonly autoUpdateCheck: boolean
}

export const CHANNEL_ENV = 'DSH_DESKTOP_CHANNEL'

export const CHANNELS: Readonly<Record<ShellChannel, ChannelConfig>> = {
  release: {
    productName: 'DSH Desktop',
    userDataDirName: 'ai.deepseek.dsh-desktop',
    defaultPort: 41729,
    profileName: 'dsh-desktop',
    legacyCleanup: true,
    autoUpdateCheck: true,
  },
  debug: {
    productName: 'DSH Desktop Debug',
    userDataDirName: 'ai.deepseek.dsh-desktop.debug',
    // Never 41729: that is where the shipping desktop app (Tauri today, Electron later)
    // listens, and the debug build must be able to run at the same time.
    defaultPort: 41731,
    profileName: 'dsh-desktop-debug',
    legacyCleanup: false,
    autoUpdateCheck: false,
  },
  /**
   * Running from source (`pnpm dev`). Without this, a development run writes
   * `shell-settings.json`, `desktop-facts.json`, `window-state.json` and even
   * `service.port` into the **installed** app's directory, so two different builds fight
   * over one settings file. Set `DSH_DESKTOP_USER_DATA_DIR` to opt back into sharing.
   */
  development: {
    productName: 'DSH Desktop (dev)',
    userDataDirName: 'ai.deepseek.dsh-desktop.dev',
    defaultPort: 41733,
    profileName: 'dsh-desktop-dev',
    legacyCleanup: false,
    autoUpdateCheck: false,
  },
}

/**
 * Resolve the channel from an explicit override, then the value baked in at package time.
 *
 * Unpackaged runs default to `development`: a source checkout must not share state with an
 * installed build. Packaged runs always carry their channel in the app's package.json, so
 * an unreadable/absent one there still means `release`.
 *
 * @param environment - Environment to consult for `DSH_DESKTOP_CHANNEL`.
 * @param baked - `dshDesktopChannel` from the packaged package.json, when present.
 * @param packaged - Whether this is a packaged app (`app.isPackaged`).
 */
export function resolveChannel(environment: NodeJS.ProcessEnv, baked?: string, packaged = true): ShellChannel {
  const requested = environment[CHANNEL_ENV] ?? baked
  if (requested === 'debug' || requested === 'development' || requested === 'release') return requested
  return packaged ? 'release' : 'development'
}

export function channelConfig(channel: ShellChannel): ChannelConfig {
  return CHANNELS[channel]
}

/** Harness home for the managed child. Unset means the user's own `~/.dsh`. */
export const DSH_HOME_ENV = 'DSH_DESKTOP_DSH_HOME'
/**
 * Test-only: run the whole update path (check → download → verify → install) without the
 * update window and write each phase to `update-smoke.json` in userData, so the upgrade
 * can be rehearsed end to end on a real install.
 */
export const SMOKE_UPDATE_ENV = 'DSH_DESKTOP_SMOKE_UPDATE'
/**
 * Test-only: crash the renderer on purpose after startup, so the recovery path is verified
 * rather than assumed.
 */
export const SMOKE_CRASH_ENV = 'DSH_DESKTOP_SMOKE_CRASH'
/** Test-only: verify a real minisign signature inside the app's own runtime. */
export const SMOKE_MINISIGN_ENV = 'DSH_DESKTOP_SMOKE_MINISIGN'
/** Test-only: open the title bar's menus and record their items. */
export const SMOKE_MENU_ENV = 'DSH_DESKTOP_SMOKE_MENU'
/** Test-only: export the support bundle at startup and record where it went. */
export const SMOKE_SUPPORT_ENV = 'DSH_DESKTOP_SMOKE_SUPPORT'
/** Test-only: emit the notification plugin's event from the real page and record what the shell did. */
export const SMOKE_NOTIFY_ENV = 'DSH_DESKTOP_SMOKE_NOTIFY'
/** Rolling shell log, written next to the other shell state. */
export const SHELL_LOG_FILENAME = 'shell.log'
export const SHELL_LOG_MAX_BYTES = 512 * 1024
/**
 * Profile the shell owns. `dsh web` is just the shipped `web` profile; booting our own
 * keeps plugin installs, lockfiles and node_modules out of the CLI's reach.
 *
 * Not `desktop`: dsh reserves that name for the official Electron app and rejects it
 * outright (`rejectElectronProfile` in dsh's launcher, for both booting and
 * `dsh plugin --profile desktop`).
 */
export const PROFILE_ENV = 'DSH_DESKTOP_PROFILE'
export const DESKTOP_PROFILE_NAME = 'dsh-desktop'
/** `token` (Tauri-compatible) | `cookie` (default, token never reaches the page) | `proxy` (spike S2). */
export const LOAD_MODE_ENV = 'DSH_DESKTOP_LOAD_MODE'
/**
 * Proxy-mode document host: `app` (spike S2a) or `loopback` (spike S2b).
 *
 * The DSH client derives its WebSocket URL from `location`, so `dsh-app://app/`
 * produces the unusable `ws://app/...`. Serving the document from
 * `dsh-app://127.0.0.1:<port>/` makes that derivation land on the real host.
 */
export const PROXY_ORIGIN_ENV = 'DSH_DESKTOP_PROXY_ORIGIN'
/** When set, the shell boots, reports one JSON result line, and quits. */
export const SMOKE_ENV = 'DSH_DESKTOP_SMOKE'
/** Set to `1` to suppress the one-time "remove the old Tauri install?" prompt. */
export const SKIP_LEGACY_CLEANUP_ENV = 'DSH_DESKTOP_SKIP_LEGACY_CLEANUP'

export const DSH_OVERLAY_FILENAME = 'dsh-overlay.yml'
export const DSH_FACTS_FILENAME = 'desktop-facts.json'
export const SHELL_SETTINGS_FILENAME = 'shell-settings.json'
export const DSH_PLUGIN_DIR_NAME = 'dsh-desktop-shell'

/** Desktop-owned document scheme. Only used by the reverse-proxy load mode (spike S2). */
export const SCHEME = 'dsh-app'

/**
 * The Tauri shell's `app_config_dir()`. Pointing Electron's userData here keeps
 * `shell-settings.json` and the panel plugin's bridge directory identical across the
 * migration, so an existing user keeps their settings.
 */
export const SHARED_USER_DATA_DIR_NAME = 'ai.deepseek.dsh-desktop'

/** Update manifest. Same file the Tauri clients read, so one manifest serves both. */
export const DEFAULT_UPDATE_MANIFEST_URL =
  'https://github.com/gzh330205/deepseek-harness-desktop/releases/latest/download/latest.json'
export const UPDATE_MANIFEST_URL_ENV = 'DSH_DESKTOP_UPDATE_MANIFEST_URL'
/** Delay before the automatic startup check, and the interval between later checks. */
export const UPDATE_STARTUP_DELAY_MS = 8_000
export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

/** IPC channels. Product-page channels are deliberately absent: no product IPC exists in P0. */
export const IPC = {
  /** Title bar → main: which dropdown to open and where. */
  titlebarMenu: 'shell:titlebar-menu',
  /** Title bar → main: product name and version for its label. */
  titlebarState: 'shell:titlebar-state',
  /** Settings window → main: read the current snapshot. */
  settingsGet: 'shell:settings-get',
  /** Settings window → main: submit values. */
  settingsSave: 'shell:settings-save',
  settingsClose: 'shell:settings-close',
  settingsRestart: 'shell:settings-restart',
  launcherStatus: 'dsh-desktop:launcher-status',
  launcherSubscribe: 'dsh-desktop:launcher-subscribe',
  /** Launcher page → main: leave the status page and open the DSH UI. */
  launcherEnter: 'dsh-desktop:launcher-enter',
  updateStatus: 'dsh-desktop:update-status',
  updateSubscribe: 'dsh-desktop:update-subscribe',
  updateAction: 'dsh-desktop:update-action',
  /** Product page → shell: one of {@link PANEL_EMIT_EVENTS}. */
  panelEvent: 'dsh-desktop:panel-event',
  /**
   * Product page → shell: an emit the preload refused by name. Diagnostics only — the shell logs it
   * so "the plugin tried to talk to us and nothing happened" is visible in `shell.log`.
   */
  panelDropped: 'dsh-desktop:panel-dropped',
  /** Shell → product page: the shell's state changed, reload it. */
  panelState: 'dsh-desktop:panel-state',
  /**
   * Sidebar-browser panel → main: a command for the shell-owned browser view
   * (create / bounds / show / hide / navigate / back / forward / reload / focus / pick /
   * device / close).
   */
  browserCommand: 'dsh-desktop:browser-command',
  /** Main → sidebar-browser panel: the view's navigation state changed. */
  browserState: 'dsh-desktop:browser-state',
  /** Main → sidebar-browser panel: the user picked an element in the browser view. */
  browserPick: 'dsh-desktop:browser-pick',
  /** Main → sidebar-browser panel: the browser's download list changed. */
  browserDownloads: 'dsh-desktop:browser-downloads',
  /**
   * Main → sidebar-browser panel: open the browser tab in DSH's right sidebar.
   *
   * Sent when the *agent* wants the user to see a page (`navigate { show: true }`) but the panel is
   * not on screen. Only the page can do this — opening a pane is a client-side operation
   * (`ctx.sidebarRight.openTab` / `openTabIn`), so the shell asks and the page acts.
   */
  browserOpenPane: 'dsh-desktop:browser-open-pane',
} as const

/**
 * Events the DSH page may send to the shell (the `dsh-desktop-shell` action channel and
 * the notification bridge). Everything else is refused.
 *
 * The notification plugin's event name is its own `tauriEventName` setting, whose default — and the
 * name its README documents for shell integration — is `dsh-notify`, **not** the package name
 * `dsh-win-notify` this list carried for a long time. That mismatch was silent in the worst way:
 * `emit` resolves for names it refuses, the plugin treats "no throw" as "the shell showed it", and
 * so it never fell back to a browser notification either — the user simply saw nothing. Both names
 * are accepted now, and a refused name is reported (see `IPC.panelDropped`) instead of vanishing.
 */
export const PANEL_EMIT_EVENTS = ['dsh-desktop-shell', 'dsh-notify', 'dsh-win-notify'] as const
/** Per-run set of refused emit names, so one drift is reported once rather than per event. */
export const PANEL_DROPPED_LOG_CAP = 8
/** Events the shell may send to the DSH page. */
export const PANEL_LISTEN_EVENTS = ['dsh-desktop-state'] as const
/** Actions the settings page may ask for; anything else is ignored. */
export const PANEL_ACTIONS = [
  'settings-changed',
  'restart-dsh',
  'check-desktop-update',
  'show-about',
  'focus-main',
] as const

/** Route prefix of the bundled DSH panel plugin. */
export const PANEL_ROUTE = '/dsh-desktop-shell/v1'

/** What stopping DSH now would interrupt, as reported by the panel plugin. */
export interface TaskReport {
  readonly answer: 'idle' | 'active' | 'unknown'
  readonly families: readonly {
    readonly sessionId: string
    readonly kind: string
    readonly count: number
    readonly labels: readonly string[]
  }[]
  readonly sessions?: number
  readonly reason?: string
}

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'ready'
  | 'error'

export interface UpdateState {
  readonly phase: UpdatePhase
  /** Version offered by the manifest, once known. */
  readonly version?: string
  readonly percent?: number
  /** Localised text for display; never contains credentials or raw updater output. */
  readonly message?: string
  /** Diagnostics kept for logs only. */
  readonly detail?: string
}

export type UpdateAction = 'check' | 'download' | 'install' | 'dismiss'

export type LoadMode = 'token' | 'cookie' | 'proxy'

export interface LauncherStatus {
  readonly phase: 'checking' | 'starting' | 'ready' | 'failed' | 'updateRequired'
  readonly message: string
  readonly detail?: string
  readonly version?: string
  readonly port?: number
  readonly loadMode?: LoadMode
}
