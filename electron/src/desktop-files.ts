/**
 * Files the shell hands to the DSH side: the `--patch` overlay and the facts file.
 *
 * Both keep the exact shapes the Tauri shell produced, because the bundled panel
 * plugin (`dsh-desktop-shell`) reads them unchanged.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { DSH_OVERLAY_FILENAME } from './constants.ts'
import { bridgeDir, factsPath, overlayPath, pluginEntryPath } from './paths.ts'

export interface OverlayResult {
  readonly path: string
  readonly panelInjected: boolean
}

/**
 * Rewrite the overlay on every launch:
 * 1. override the `web-runtime` bundle so dsh prints the authentication URL, never
 *    opens a system browser, and does not trust the LAN;
 * 2. insert the panel plugin shipped with the shell.
 */
export function writeOverlay(appVersion: string): OverlayResult {
  let body = `# 由 DSH Desktop (Electron) 每次启动生成，请勿手工编辑。
- id: web-runtime
  config:
    openBrowser: false
    printUrl: true
    surfaceContext: true
    trustedHosts: []
`
  const entry = pluginEntryPath()
  if (entry !== undefined) {
    const escaped = entry.replaceAll("'", "''")
    body += `- insert:
    - id: dsh-desktop-shell
      name: '${escaped}'
`
  }
  const path = overlayPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body, 'utf8')
  void appVersion
  return { path, panelInjected: entry !== undefined }
}

export interface DesktopFacts {
  readonly schema: number
  readonly generatedAtUnixMs: number
  readonly desktopVersion: string
  readonly settingsPath: string
  readonly bridgeDir: string
  readonly panelInjected: boolean
  readonly dshUrl: string | null
  readonly dshPort: number
  readonly dshVersion: string | null
  readonly dshManaged: boolean
  readonly dshBrowserAuth: boolean
  readonly shell: 'electron'
  /** Where the dsh runtime came from, and which one it is. */
  readonly runtime: {
    readonly source: 'bundled' | 'system'
    readonly version?: string
    readonly files?: number
    /** Shell version the bundled runtime tree was produced for. */
    readonly shell?: string
  }
  /** Main-window geometry this run ended up with, and whether it was restored. */
  readonly window?: {
    readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
    readonly maximized: boolean
    /** False when a stored position was rejected as unreachable. */
    readonly restored: boolean
  }
  /** The profile the shell owns, and whether this run created it. */
  readonly profile?: {
    readonly name: string
    readonly path: string
    readonly seededFrom: string
    readonly dependencies: number
  }
}

/** Write the read-only facts file consumed by the panel plugin and diagnostics. */
export function writeFacts(input: Omit<DesktopFacts, 'schema' | 'generatedAtUnixMs' | 'settingsPath' | 'bridgeDir' | 'shell'>): void {
  const facts: DesktopFacts = {
    schema: 1,
    generatedAtUnixMs: Date.now(),
    settingsPath: `${bridgeDir()}\\${'shell-settings.json'}`,
    bridgeDir: bridgeDir(),
    shell: 'electron',
    ...input,
  }
  try {
    writeFileSync(factsPath(), `${JSON.stringify(facts, null, 2)}\n`, 'utf8')
  } catch {
    // Facts are diagnostics only; a failure must never block startup.
  }
}

export { DSH_OVERLAY_FILENAME }
