/**
 * Legacy-install matching tests.
 *
 * The entries below are verbatim registry dumps captured on a machine with BOTH
 * installers present (2026-09-28):
 *
 * - the Tauri shell registered under the literal key `DSH Desktop`, display name
 *   `DSH Desktop`, with `InstallLocation` set;
 * - electron-builder registered under a UUID key derived from the appId, display name
 *   `DSH Desktop 0.3.0`, with `InstallLocation` **absent** and a UUID `/currentuser`
 *   suffix on `UninstallString`.
 *
 * The first version of this logic searched value data (`reg query /f … /d`), which
 * found neither entry, and compared only install locations, which made the app treat
 * its own installation as legacy. Both mistakes are pinned here.
 *
 * Run: node --test src/legacy-cleanup.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { selectLegacyInstalls, type LegacyInstall } from '../src/legacy-cleanup.ts'

const ELECTRON_INSTALL_DIR = 'C:\\Users\\gzh33\\AppData\\Local\\Programs\\DSH Desktop'
const TAURI_INSTALL_DIR = 'D:\\Program Files\\DSH Desktop'

const electronEntry: LegacyInstall = {
  key: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\94656c7c-7d35-522f-a67e-420701c356ed',
  displayName: 'DSH Desktop 0.3.0',
  displayVersion: '0.3.0',
  installLocation: '',
  uninstallString: '"C:\\Users\\gzh33\\AppData\\Local\\Programs\\DSH Desktop\\Uninstall DSH Desktop.exe" /currentuser',
}

const tauriEntry: LegacyInstall = {
  key: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\DSH Desktop',
  displayName: 'DSH Desktop',
  displayVersion: '0.2.31',
  installLocation: TAURI_INSTALL_DIR,
  uninstallString: `"${TAURI_INSTALL_DIR}\\uninstall.exe"`,
}

const unrelated: LegacyInstall = {
  key: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\d074f30d',
  displayName: 'OpenCode 2.0.16',
  displayVersion: '2.0.16',
  installLocation: '',
  uninstallString: '"C:\\Users\\gzh33\\AppData\\Local\\Programs\\@opencodedesktop\\Uninstall OpenCode.exe" /currentuser',
}

test('running from the installed build reports only the Tauri shell', () => {
  const found = selectLegacyInstalls([electronEntry, tauriEntry, unrelated], `${ELECTRON_INSTALL_DIR}\\DSH Desktop.exe`)
  assert.deepEqual(found.map(entry => entry.displayName), ['DSH Desktop'])
  assert.equal(found[0]?.key.endsWith('DSH Desktop'), true)
})

test('running unpacked still reports both other installations', () => {
  const unpacked = 'D:\\workspace\\research\\deepseek-harness-desktop\\electron\\release\\win-unpacked\\DSH Desktop.exe'
  const found = selectLegacyInstalls([electronEntry, tauriEntry, unrelated], unpacked)
  assert.deepEqual(found.map(entry => entry.displayName).sort(), ['DSH Desktop', 'DSH Desktop 0.3.0'])
})

test('an empty uninstall string is never actionable', () => {
  const broken: LegacyInstall = { ...tauriEntry, uninstallString: '' }
  assert.deepEqual(selectLegacyInstalls([broken], 'C:\\elsewhere\\DSH Desktop.exe'), [])
})

test('unrelated products are ignored', () => {
  assert.deepEqual(selectLegacyInstalls([unrelated], `${ELECTRON_INSTALL_DIR}\\DSH Desktop.exe`), [])
})

test('a different install directory is still reported', () => {
  const moved: LegacyInstall = {
    ...tauriEntry,
    key: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\DSH Desktop 2',
    installLocation: 'E:\\Apps\\DSH Desktop',
    uninstallString: '"E:\\Apps\\DSH Desktop\\uninstall.exe"',
  }
  const found = selectLegacyInstalls([moved], `${ELECTRON_INSTALL_DIR}\\DSH Desktop.exe`)
  assert.equal(found.length, 1)
})
