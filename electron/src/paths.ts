/**
 * Filesystem layout and external-process resolution.
 *
 * The Electron userData directory replaces the Tauri `app_config_dir()`: it holds
 * `shell-settings.json`, `desktop-facts.json`, and the generated `dsh-overlay.yml`,
 * so the bundled DSH panel plugin keeps working without a single change.
 */

import { app } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import {
  DSH_BUNDLED_RUNTIME_ENV,
  DSH_ENTRY_ENV,
  DSH_HOME_ENV,
  DSH_OVERLAY_FILENAME,
  DSH_PLUGIN_DIR_NAME,
  DSH_PLUGIN_PATH_ENV,
  DSH_USER_DATA_ENV,
  SHELL_SETTINGS_FILENAME,
  SHARED_USER_DATA_DIR_NAME,
} from './constants.ts'

/** Directory holding downloaded installers, kept beside the settings. */
export function updatesDir(): string {
  return join(bridgeDir(), 'updates')
}

/** Harness home for the managed child. Unset keeps the user's own `~/.dsh`. */
export function harnessHome(): string | undefined {
  const override = process.env[DSH_HOME_ENV]
  return override === undefined || override === '' ? undefined : resolve(override)
}

/** Directory owned by the shell: settings, facts, overlay, and logs. */
export function bridgeDir(): string {
  return app.getPath('userData')
}

export function settingsPath(): string {
  return join(bridgeDir(), SHELL_SETTINGS_FILENAME)
}

export function overlayPath(): string {
  return join(bridgeDir(), DSH_OVERLAY_FILENAME)
}

export function factsPath(): string {
  return join(bridgeDir(), 'desktop-facts.json')
}

/** The browser-tool catalog, written for the panel plugin to register natively. */
export function browserToolsPath(): string {
  return join(bridgeDir(), 'browser-tools.json')
}

/** What the plugin reported about its native registration (drives the MCP fallback). */
export function toolRegistrationPath(): string {
  return join(bridgeDir(), 'browser-tool-registration.json')
}

/**
 * Apply the userData override before anything reads `app.getPath('userData')`.
 * Must run before `app.whenReady()`.
 *
 * Without an override the directory is the one the Tauri shell used
 * (`%APPDATA%\ai.deepseek.dsh-desktop`), not Electron's productName default: settings
 * and the panel bridge directory must survive the migration unchanged.
 */
export function applyUserDataOverride(userDataDirName: string = SHARED_USER_DATA_DIR_NAME): void {
  const override = process.env[DSH_USER_DATA_ENV]
  if (override !== undefined && override !== '') {
    app.setPath('userData', resolve(override))
    return
  }
  app.setPath('userData', join(app.getPath('appData'), userDataDirName))
}

/**
 * Entry file of the DSH panel plugin. Shipped as a resource in packaged builds and
 * pointed at directly during development.
 */
export function pluginEntryPath(): string | undefined {
  const override = process.env[DSH_PLUGIN_PATH_ENV]
  if (override !== undefined && override !== '' && existsSync(override)) return override
  const packaged = join(process.resourcesPath, DSH_PLUGIN_DIR_NAME, 'index.js')
  if (existsSync(packaged)) return packaged
  const development = join(app.getAppPath(), '..', 'src-tauri', 'resources', DSH_PLUGIN_DIR_NAME, 'index.js')
  return existsSync(development) ? development : undefined
}

/**
 * Root of the runtime that ships with the app, when one is present.
 *
 * Packaged, this is the **ASAR** (`resources/app.asar/dsh`): the whole runtime is packed into one
 * file so the installer does not have to create ~12,400 files (measured: 18.5 s versus 0.2 s for
 * the same bytes as a single file). Electron's `fs` reads through it, and the files that cannot be
 * loaded from an archive — native modules, executables, shell scripts — sit physically in
 * `resources/app.asar.unpacked/dsh`. Development points this at a prepared tree instead.
 */
export function bundledRuntimeRoot(): string | undefined {
  const override = process.env[DSH_BUNDLED_RUNTIME_ENV]
  if (override !== undefined && override !== '') return existsSync(override) ? resolve(override) : undefined
  const packaged = join(app.getAppPath(), 'dsh')
  return existsSync(packaged) ? packaged : undefined
}

/**
 * Candidate paths of something that lives beside the runtime tree.
 *
 * Two shapes: a prepared directory during development (`DSH_DESKTOP_BUNDLED_RUNTIME`), and the
 * ASAR's unpacked twin when packaged — the physical half of the runtime is under
 * `resources/app.asar.unpacked/dsh`, not `resources/dsh`.
 */
function bundledRuntimeSibling(relativePath: string): string[] {
  const candidates: string[] = []
  const override = process.env[DSH_BUNDLED_RUNTIME_ENV]
  if (override !== undefined && override !== '') candidates.push(join(resolve(override), relativePath))
  candidates.push(join(process.resourcesPath, 'app.asar.unpacked', 'dsh', relativePath))
  return candidates
}

/**
 * Directory of the bundled `pnpm`/`node` shims, when the runtime ships them.
 *
 * These must stay physical: `cmd.exe` starts them and a shell cannot read inside an ASAR, so this is
 * the runtime's `bin` under `app.asar.unpacked`, never a path inside the archive.
 */
export function runtimeBinDir(): string | undefined {
  for (const candidate of bundledRuntimeSibling('bin')) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * pnpm's JavaScript entry, run on the app's own binary in Node mode.
 *
 * `dsh plugin …` forwards to `pnpm` on PATH (our shim), and profile seeding installs plugins with it,
 * so a runtime without this cannot manage plugins at all.
 *
 * Packaged, `pnpm.cjs` lives **inside the ASAR** (it is JavaScript, read through the archive like any
 * other module; only what pnpm *executes* sits in `app.asar.unpacked`). Looking for it beside the
 * shims finds nothing — and the caller reads "no pnpm" as "this runtime cannot install plugins",
 * which silently skips profile seeding.
 */
export function bundledPnpmEntry(): string | undefined {
  const relative = join('node_modules', 'pnpm', 'bin', 'pnpm.cjs')
  const override = process.env[DSH_BUNDLED_RUNTIME_ENV]
  const candidates: string[] = []
  if (override !== undefined && override !== '') candidates.push(join(resolve(override), relative))
  candidates.push(join(app.getAppPath(), 'dsh', relative))
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Resolve the dsh JavaScript entry.
 *
 * Resolving the `.js` entry instead of the Windows `dsh.cmd` shim means no shell is
 * involved, so arguments need no cmd.exe quoting and no console window can appear.
 *
 * @returns Absolute path to `.../@deepseek-ai/dsh/lib/bin.js`, or undefined.
 */
export function resolveDshEntry(): string | undefined {
  const explicit = process.env[DSH_ENTRY_ENV]
  if (explicit !== undefined && explicit !== '' && existsSync(explicit)) return resolve(explicit)

  const runtime = bundledRuntimeRoot()
  if (runtime !== undefined) {
    const bundled = join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (existsSync(bundled)) return bundled
    const direct = join(runtime, 'lib', 'bin.js')
    if (existsSync(direct)) return direct
  }

  // A global npm/pnpm install puts the shim next to the package tree.
  for (const directory of executableDirectories()) {
    const candidate = join(directory, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** PATH entries, plus the directory of an explicitly configured launcher command. */
function executableDirectories(): string[] {
  const directories: string[] = []
  const configured = process.env.DSH_COMMAND_ENV
  if (configured !== undefined && configured !== '' && isAbsolute(configured)) {
    directories.push(dirname(configured))
  }
  const path = process.env.PATH ?? process.env.Path ?? ''
  for (const entry of path.split(process.platform === 'win32' ? ';' : ':')) {
    if (entry !== '') directories.push(entry)
  }
  return directories
}
