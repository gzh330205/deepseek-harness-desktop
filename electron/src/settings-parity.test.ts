/**
 * Settings parity between the shell and the bundled DSH panel plugin.
 *
 * The settings document has three writers — the shell's reader/merger, the panel plugin's
 * validator, and the two UIs that submit patches. The plugin rejects unknown keys loudly, so
 * a field added on one side and forgotten on the other either breaks saving or silently
 * drops a user's choice. That is exactly the failure this repository has hit before, and it
 * is not reachable by unit-testing the shell alone.
 *
 * This test therefore reads the plugin and the shell's settings page as *text* and asserts
 * the field is present on every side. It is a drift guard, not a behaviour test: it cannot
 * prove the plugin validates correctly, only that it was not forgotten.
 *
 * Run: node --test src/settings-parity.test.ts
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

const pluginHost = read('../../src-tauri/resources/dsh-desktop-shell/index.js')
const pluginClient = read('../../src-tauri/resources/dsh-desktop-shell/client.js')
const shellSettingsPage = read('../src/settings-ui/index.html')

test('the plugin host half knows the browser switch', () => {
  // Defaults: an absent file means the feature is on, with the tool surface on `auto`, a 30-second
  // idle window before control is handed back.
  assert.match(
    pluginHost,
    /browser:\s*\{\s*enabled:\s*true,\s*agentTools:\s*'auto',\s*autoReleaseSeconds:\s*30\s*\}/u,
  )
  // The patch whitelist rejects unknown keys, so the section must be listed.
  assert.match(pluginHost, /\['closeBehavior',\s*'proxy',\s*'service',\s*'updates',\s*'browser'\]/u)
  // Validation of the field itself.
  assert.match(pluginHost, /browser\.enabled 必须是布尔值/u)
  // The upgrade path (`withDefaults`) must fill it too.
  assert.match(pluginHost, /enabled:\s*browser\.enabled !== false/u)
})

test('the idle hand-back window is a setting on every side', () => {
  // Shell: typed, read with a clamp, and pushed into the browser manager.
  const shellSettings = read('../src/settings.ts')
  assert.match(shellSettings, /autoReleaseSeconds:\s*number/u)
  assert.match(shellSettings, /autoReleaseSeconds:\s*clampBrowserAutoRelease\(browserRecord\.autoReleaseSeconds\)/u)
  const shellMain = read('../src/main.ts')
  assert.match(shellMain, /browserPanel\.setAutoReleaseSeconds\(shellSettings\.browser\.autoReleaseSeconds\)/u)

  // Plugin host: validated, clamped on the upgrade path, and defaulted.
  assert.match(pluginHost, /browser\.autoReleaseSeconds 必须是数字/u)
  assert.match(pluginHost, /autoReleaseSeconds:\s*clampAutoReleaseSeconds\(browser\.autoReleaseSeconds\)/u)
  assert.match(pluginHost, /const AUTO_RELEASE_MIN = 5/u)

  // Plugin client: an editable field that reaches the saved patch.
  assert.match(pluginClient, /browserAutoRelease/u)
  assert.match(pluginClient, /autoReleaseSeconds:\s*Number\.isFinite\(settings\.browser\?\.autoReleaseSeconds\)/u)
})

test('the tool-surface setting is known on every side that validates or submits it', () => {
  // Plugin host: the accepted values, the patch validator, and the upgrade path.
  assert.match(pluginHost, /const TOOL_SURFACES = \['auto', 'native', 'mcp'\]/u)
  assert.match(pluginHost, /browser\.agentTools 必须是/u)
  assert.match(pluginHost, /agentTools:\s*TOOL_SURFACES\.includes\(browser\.agentTools\)/u)

  // Shell: the settings type and the reader both carry it, and the shell decides from it.
  const shellSettings = read('../src/settings.ts')
  assert.match(shellSettings, /agentTools:\s*'auto' \| 'native' \| 'mcp'/u)
  assert.match(shellSettings, /browserRecord\.agentTools === 'native' \|\| browserRecord\.agentTools === 'mcp'/u)
  const shellMain = read('../src/main.ts')
  assert.match(shellMain, /decideToolSurface\(shellSettings\.browser\.agentTools/u)

  // Plugin client: the control is rendered and the saved patch carries the value (a control
  // that never reaches the patch would look saved and silently do nothing).
  assert.match(pluginClient, /browserAgentTools/u)
  assert.match(pluginClient, /agentTools:\s*\['auto', 'native', 'mcp'\]\.includes\(settings\.browser\?\.agentTools\)/u)
})

test('the plugin client half submits the browser switch and gates the tab on it', () => {
  // The submitted patch carries both browser fields (multi-line object: match across newlines).
  assert.match(pluginClient, /browser:\s*\{[\s\S]{0,200}?enabled:\s*settings\.browser\?\.enabled !== false/u)
  assert.match(pluginClient, /browser:\s*draft\.browser/u)
  assert.match(pluginClient, /patchBrowser/u)
  // The tab registration must consult the saved setting before registering.
  assert.match(pluginClient, /settings\.browser\.enabled === false/u)
})

test('the shell settings page renders and submits the browser switch', () => {
  // Rendered (fill) and submitted (collect) — a checkbox in the markup alone would be a
  // silent no-op.
  const occurrences = shellSettingsPage.split('browserEnabled').length - 1
  assert.ok(occurrences >= 3, `expected the switch in markup, fill and collect, found ${String(occurrences)}`)
  assert.match(shellSettingsPage, /browserEnabled: document\.getElementById\('browserEnabled'\)\.checked/u)
})
