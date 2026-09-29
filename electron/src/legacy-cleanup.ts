/**
 * Detect and remove a leftover Tauri-shell installation.
 *
 * The Electron installer cannot uninstall it safely from NSIS: `ExecWait` on another
 * product's uninstaller has no timeout and would hang the install if that uninstaller
 * ever showed UI. Doing it here instead gives us a timeout, a log, and a return value.
 *
 * Nothing is removed without the user agreeing; this module only detects. The caller
 * asks, then calls {@link removeInstall}.
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { promisify } from 'node:util'

import { PRODUCT_NAME } from './constants.ts'

const execFileAsync = promisify(execFile)
const UNINSTALL_KEYS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
]

export interface LegacyInstall {
  /** Registry key that holds the entry. */
  readonly key: string
  readonly displayName: string
  readonly displayVersion: string
  readonly installLocation: string
  readonly uninstallString: string
}

/** Marker written once the user has been asked, so the prompt never repeats. */
export function legacyMarkerPath(directory: string): string {
  return join(directory, 'legacy-tauri-removal-offered')
}

export function legacyPromptAlreadyOffered(directory: string): boolean {
  return existsSync(legacyMarkerPath(directory))
}

export function markLegacyPromptOffered(directory: string): void {
  try {
    const path = legacyMarkerPath(directory)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${new Date().toISOString()}\n`, 'utf8')
  } catch {
    // Diagnostics only.
  }
}

function parseRegistryValues(stdout: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('HKEY_')) continue
    const match = /^(\S+)\s+REG_\w+\s+(.*)$/u.exec(line)
    if (match === null) continue
    const [, name, value] = match
    if (name !== undefined && value !== undefined) values[name] = value
  }
  return values
}

/** Strip the surrounding quotes NSIS/Inno write around a path. */
function unquote(value: string): string {
  return value.trim().replace(/^"|"$/gu, '')
}

/**
 * Extract the executable from an `UninstallString`.
 *
 * Both shapes occur in the wild and a naive `unquote` gets the second one wrong:
 *   `"D:\Program Files\DSH Desktop\uninstall.exe"`                    (Tauri / NSIS)
 *   `"C:\…\Uninstall DSH Desktop.exe" /currentuser`                   (electron-builder)
 */
function uninstallerPath(uninstallString: string): string {
  const trimmed = uninstallString.trim()
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1)
    if (end > 1) return trimmed.slice(1, end)
  }
  return trimmed.split(/\s+/u)[0] ?? ''
}

/** Subkey names under an uninstall root; `reg query` prints one per line. */
async function listUninstallKeys(root: string): Promise<string[]> {
  let stdout = ''
  try {
    const result = await execFileAsync('reg', ['query', root], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
    stdout = result.stdout
  } catch {
    return []
  }
  return stdout
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line.startsWith('HKEY_'))
    .map(line => line.slice(line.lastIndexOf('\\') + 1))
    .filter(name => name !== '')
}

/**
 * Read one uninstall entry.
 *
 * Enumeration is by **key name**, not by searching value data: the Tauri install
 * registers under the literal key `DSH Desktop`, while electron-builder registers under
 * a UUID derived from the appId. A `/f … /d` data search finds neither reliably —
 * measured on a machine with both installed.
 */
async function readUninstallEntry(root: string, name: string): Promise<LegacyInstall | undefined> {
  try {
    const result = await execFileAsync('reg', ['query', `${root}\\${name}`], { windowsHide: true, maxBuffer: 1024 * 1024 })
    const values = parseRegistryValues(result.stdout)
    return {
      key: `${root}\\${name}`,
      displayName: values.DisplayName ?? '',
      displayVersion: values.DisplayVersion ?? '',
      installLocation: unquote(values.InstallLocation ?? ''),
      uninstallString: values.UninstallString ?? '',
    }
  } catch {
    return undefined
  }
}

function sameDirectory(left: string, right: string): boolean {
  const normalizeCase = (value: string): string => normalize(value).replace(/[\\/]+$/u, '').toLowerCase()
  return left !== '' && right !== '' && normalizeCase(left) === normalizeCase(right)
}

/**
 * Pick the entries that really are *other* installations of this product.
 *
 * Split out from the registry access so the rules can be tested against registry
 * dumps captured from a real machine (see legacy-cleanup.test.ts).
 *
 * @param entries - Every uninstall entry whose display name mentions the product.
 * @param currentExecutable - `app.getPath('exe')`; its directory identifies this build.
 */
export function selectLegacyInstalls(
  entries: readonly LegacyInstall[],
  currentExecutable: string,
): LegacyInstall[] {
  const ours = dirname(currentExecutable)
  return entries.filter((install) => {
    if (install.uninstallString === '') return false
    // Electron registers "DSH Desktop 0.3.0"; the Tauri shell registers "DSH Desktop".
    if (install.displayName !== PRODUCT_NAME && !install.displayName.startsWith(`${PRODUCT_NAME} `)) return false
    // Skip this very installation. The uninstaller comparison is load-bearing:
    // electron-builder writes no InstallLocation into the uninstall key, so an
    // install-location-only check would make the app offer to uninstall *itself*.
    if (sameDirectory(install.installLocation, ours)) return false
    if (sameDirectory(dirname(uninstallerPath(install.uninstallString)), ours)) return false
    return true
  })
}

/**
 * Find installed copies of this product that are not the running build.
 *
 * @param currentExecutable - `app.getPath('exe')`; its directory identifies this build.
 */
export async function findLegacyInstalls(currentExecutable: string): Promise<LegacyInstall[]> {
  if (process.platform !== 'win32') return []
  const entries: LegacyInstall[] = []
  for (const root of UNINSTALL_KEYS) {
    for (const name of await listUninstallKeys(root)) {
      const install = await readUninstallEntry(root, name)
      if (install !== undefined) entries.push(install)
    }
  }
  return selectLegacyInstalls(entries, currentExecutable)
}

export interface RemovalResult {
  readonly key: string
  readonly ok: boolean
  readonly detail: string
}

/**
 * Run one legacy uninstaller silently, with a bounded wait.
 *
 * A non-zero exit is not treated as failure by itself: NSIS uninstallers routinely
 * report oddly after removing themselves. The caller re-queries the registry to
 * confirm.
 */
export async function removeInstall(install: LegacyInstall, timeoutMs = 90_000): Promise<RemovalResult> {
  const command = install.uninstallString.replace(/^"|"$/gu, '')
  return new Promise((resolve) => {
    const child = execFile(command, ['/S'], { windowsHide: true, timeout: timeoutMs }, (error) => {
      if (error === null) {
        resolve({ key: install.key, ok: true, detail: '卸载程序已完成' })
        return
      }
      const timedOut = (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true
      resolve({
        key: install.key,
        ok: false,
        detail: timedOut ? `卸载程序超时（${String(timeoutMs)} ms）` : error.message,
      })
    })
    child.once('error', (error) => {
      resolve({ key: install.key, ok: false, detail: error.message })
    })
  })
}
