/**
 * Files the shell hands to the DSH side: the `--patch` overlay and the facts file.
 *
 * Both keep the exact shapes the Tauri shell produced, because the bundled panel
 * plugin (`dsh-desktop-shell`) reads them unchanged.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { DSH_OVERLAY_FILENAME } from './constants.ts'
import { bridgeDir, browserToolsPath, factsPath, overlayPath, pluginEntryPath } from './paths.ts'

export interface OverlayResult {
  readonly path: string
  readonly panelInjected: boolean
}

/** The agent tool bridge's endpoint, pointed at from the overlay's MCP row. */
export interface AgentMcpEndpoint {
  readonly url: string
  readonly token: string
}

/** The direct tool-call endpoint handed to the plugin (same bridge, no MCP handshake). */
export interface NativeToolEndpoint {
  readonly callUrl: string
  readonly registeredUrl: string
  readonly token: string
}

export interface OverlayOptions {
  /** Point DSH's shipped MCP client at the bridge. Off when the plugin registers natively. */
  readonly injectMcp?: boolean
  /** Hand the plugin what it needs to register the catalog as native tools. */
  readonly nativeTools?: NativeToolEndpoint | undefined
}

/**
 * Rewrite the overlay on every launch:
 * 1. override the `web-runtime` bundle so dsh prints the authentication URL, never
 *    opens a system browser, and does not trust the LAN;
 * 2. disable DSH's built-in sidebar browser — this shell ships its own, and two browser tab
 *    types would put two "Browser" cards on the guide page and two panes in the sidebar;
 * 3. insert the panel plugin shipped with the shell, with whatever the plugin needs
 *    (currently the native tool endpoint);
 * 4. point the shipped MCP client at the shell's browser-tool bridge — unless the plugin
 *    publishes the same catalog as native tools, in which case injecting both would show
 *    the model every tool twice.
 *
 * Entry patches are matched by `id` and every field is an override: the same mechanism DSH's
 * own `apps/web/tests/no-sidebar-browser.overlay.yml` uses. DSH's browser claims no resource
 * addresses (`patterns` is omitted in its definition), so disabling it strands no link.
 */
export function writeOverlay(appVersion: string, agentMcp?: AgentMcpEndpoint, options: OverlayOptions = {}): OverlayResult {
  let body = `# 由 DSH Desktop (Electron) 每次启动生成，请勿手工编辑。
- id: web-runtime
  config:
    openBrowser: false
    printUrl: true
    surfaceContext: true
    trustedHosts: []
- id: ui-sidebar-browser
  disabled: true
`
  const rows: string[] = []
  const entry = pluginEntryPath()
  if (entry !== undefined) {
    const escaped = entry.replaceAll("'", "''")
    rows.push(`    - id: dsh-desktop-shell
      name: '${escaped}'
`)
    const native = options.nativeTools
    if (native !== undefined) {
      // Same secret discipline as the MCP row: it lives only in this file (the shell's own
      // userData directory) and in the child's memory.
      rows.push(`      config:
        nativeTools:
          url: '${native.callUrl}'
          reportUrl: '${native.registeredUrl}'
          token: '${native.token}'
`)
    }
  }
  const injectMcp = options.injectMcp ?? agentMcp !== undefined
  if (agentMcp !== undefined && injectMcp) {
    rows.push(`    - id: desktop-browser-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: desktop_browser
        transport: streamable-http
        url: '${agentMcp.url}'
        headers:
          Authorization: 'Bearer ${agentMcp.token}'
        failOnStartupError: false
`)
  }
  if (rows.length > 0) body += `- insert:\n${rows.join('')}`
  const path = overlayPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body, 'utf8')
  void appVersion
  return { path, panelInjected: entry !== undefined }
}

/**
 * Write the tool catalog for the plugin to read.
 *
 * This is the "one definition, two surfaces" half that runs on the shell side: the MCP server
 * is handed the same array in memory, so neither surface can drift from the other.
 */
export function writeBrowserToolsCatalog(tools: unknown): void {
  try {
    writeFileSync(browserToolsPath(), `${JSON.stringify({ schema: 1, tools }, null, 2)}\n`, 'utf8')
  } catch {
    // Non-fatal: without the file the plugin registers nothing and the shell falls back to MCP
    // on the next launch (the report never arrives, which reads as "not verified").
  }
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
  /**
   * The self-hosted sidebar browser, as this run ended up with it.
   *
   * `tools` and `bridge` are what the panel's run-state section reports: "the feature is on
   * but the agent sees no tools" is otherwise indistinguishable from "the shell never
   * injected the MCP row". No endpoint or token is recorded here.
   */
  readonly browser?: {
    readonly enabled: boolean
    readonly tools: number
    readonly bridge: boolean
    /** Which surface publishes the catalog: DSH-native tools or the MCP row. */
    readonly toolSurface?: 'native' | 'mcp'
    /** Why that surface: the fallback reason is user-visible on the settings page. */
    readonly toolSurfaceReason?: string
    /** How many tools the plugin reported registering natively last launch. */
    readonly nativeToolCount?: number
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
