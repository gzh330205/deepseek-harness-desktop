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
import type { MarketActionResult } from './market-install.ts'
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
export function createMarketService(appRoot: string, log: (line: string) => void, logDir?: string): MarketService {
  const runtimeRoot = bundledRuntimeRoot() ?? join(appRoot, 'runtime', 'dsh')
  return new MarketService({
    profileDir: desktopProfileDir(),
    runtimeRoot,
    appExecutable: process.execPath,
    log: line => { log(`插件市场：${line}`) },
    ...(logDir === undefined ? {} : { logDir }),
  })
}

export function createMarketWindow(
  appRoot: string,
  log: (line: string) => void,
  options: { readonly logDir?: string } = {},
): MarketWindow {
  return new MarketWindow({ appRoot, service: createMarketService(appRoot, log, options.logDir), log })
}

/**
 * Install one plugin through the very same service a click goes through.
 *
 * A packaged self-check, not a user feature: it exists so "installing works after packaging" is
 * asserted by running it, and it is deliberately built by `createMarketService` so the check cannot
 * drift from the real construction. It installs into whatever profile the app was started with — for
 * the smoke, a throwaway `DSH_HOME`.
 *
 * @param appRoot - Directory holding `dist/` and (in development) the runtime.
 * @param log - Shell log sink.
 * @param name - Registry package name.
 * @param version - Exact version to pin.
 */
export function installForVerification(
  appRoot: string,
  log: (line: string) => void,
  name: string,
  version: string,
): Promise<MarketActionResult> {
  return createMarketService(appRoot, log).install(name, version)
}

/**
 * Install from GitHub through the same service a click goes through.
 *
 * Same purpose as {@link installForVerification}, for the other source: a GitHub install is a
 * different code path inside pnpm (git or tarball rather than a registry fetch) and only running it
 * proves it survives packaging.
 *
 * @param appRoot - Directory holding `dist/` and (in development) the runtime.
 * @param log - Shell log sink.
 * @param input - `owner/repo`, a repository URL, or a release tarball URL.
 */
export function installGithubForVerification(
  appRoot: string,
  log: (line: string) => void,
  input: string,
): Promise<MarketActionResult> {
  return createMarketService(appRoot, log).installFromGithub(input)
}
