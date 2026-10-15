/**
 * Build the market surface out of the shell's own state.
 *
 * Kept out of `main.ts` on purpose: `main.ts` is already the place where every subsystem is wired,
 * and this factory needs exactly three facts (where the profile is, where the bundled runtime is,
 * which binary to fall back to) that all come from `paths.ts` and the running app. Nothing here
 * touches the DSH page, so the market stays reachable when the harness is the thing that is broken.
 */

import { app } from 'electron'
import { join } from 'node:path'

import { DESKTOP_PROFILE_NAME } from './constants.ts'
import { MarketService } from './market-service.ts'
import { MarketWindow } from './market-window.ts'
import { bundledRuntimeRoot, harnessHome } from './paths.ts'

/**
 * The profile the shell owns (`$DSH_HOME/profiles/dsh-desktop`).
 *
 * Same derivation as the DSH child's `DSH_HOME`: the market must install into the profile the shell
 * actually boots, not into whatever the user's command-line `dsh` happens to use.
 */
export function desktopProfileDir(): string {
  const home = harnessHome() ?? join(app.getPath('home'), '.dsh')
  return join(home, 'profiles', DESKTOP_PROFILE_NAME)
}

/**
 * Create the market window, bound to the shell's profile and bundled runtime.
 *
 * @param appRoot - Directory holding `dist/` (where the window's page and preload live).
 * @param log - Shell log sink; window-level refusals and action start/stop lines land there.
 */
export function createMarketWindow(appRoot: string, log: (line: string) => void): MarketWindow {
  const runtimeRoot = bundledRuntimeRoot() ?? join(appRoot, 'runtime', 'dsh')
  const service = new MarketService({
    profileDir: desktopProfileDir(),
    runtimeRoot,
    appExecutable: process.execPath,
    log: line => { log(`插件市场：${line}`) },
  })
  return new MarketWindow({ appRoot, service, log })
}
