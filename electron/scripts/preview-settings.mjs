#!/usr/bin/env node
/**
 * Render the settings page in a browser with a stubbed bridge, so the layout can be looked at.
 *
 * The settings window is an Electron window, which means no screenshot tool can reach it — the same
 * problem `preview-market.mjs` solves for the market. The phone-access section is the first thing in
 * this page that can look wrong without being broken (a QR that does not fit, a block that keeps a
 * 148px hole when there is nothing to scan), and those are only visible by rendering it.
 *
 * The snapshot below is a realistic one, and the QR code is produced by the real `pocket-qr.ts`, so
 * what you see is what the window shows.
 *
 * Usage: node scripts/preview-settings.mjs [--out <file>]
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { pocketQrDataUrl } from '../src/pocket-qr.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const out = resolve(outIndex >= 0 && args[outIndex + 1] !== undefined ? args[outIndex + 1] : join(tmpdir(), 'dsh-settings-preview', 'index.html'))

const pagePath = join(root, 'src', 'settings-ui', 'index.html')
const page = readFileSync(pagePath, 'utf8')

const url = 'http://192.168.1.7:41730/'
const snapshot = {
  values: {
    servicePort: 41729,
    closeBehavior: 'minimizeToTray',
    proxyEnabled: false,
    httpProxy: '',
    httpsProxy: '',
    noProxy: '',
    checkDesktopOnStart: true,
    checkDshOnStart: true,
    browserEnabled: true,
    pocketEnabled: true,
    pocketPort: 41730,
  },
  pocket: {
    enabled: true,
    running: true,
    port: 41730,
    password: 'Kf7mQ2xp',
    candidates: [
      { address: '192.168.1.7', name: 'Wi-Fi', virtual: false },
      { address: '10.1.6.35', name: 'Ethernet', virtual: false },
      { address: '172.20.0.1', name: 'vEthernet (WSL)', virtual: true },
    ],
    url,
    address: '192.168.1.7',
    qr: pocketQrDataUrl(url),
  },
  facts: {
    desktopVersion: '0.3.35',
    dshVersion: '0.1.7-rc.2',
    runtimeVersion: '0.2.0-rc.2',
    runtimeSource: 'bundled',
    effectivePort: 41729,
    profileName: 'dsh-desktop',
    settingsPath: 'C:\\Users\\you\\AppData\\Roaming\\ai.deepseek.dsh-desktop\\shell-settings.json',
    defaultPort: 41729,
  },
}

// The stub must exist before the page's own script reads it.
const stub = `  <script>
    window.__DSH_SETTINGS__ = {
      get: () => Promise.resolve(${JSON.stringify(snapshot)}),
      save: () => Promise.resolve({ ok: true, changed: [], restartRequired: false }),
      close: () => Promise.resolve(true),
      restart: () => Promise.resolve(true),
      pocket: () => Promise.resolve(window.__DSH_SETTINGS__.__pocket),
    }
    window.__DSH_SETTINGS__.__pocket = ${JSON.stringify(snapshot.pocket)}
  </script>
`
const marker = page.lastIndexOf('  <script>')
if (marker < 0) {
  process.stderr.write('preview-settings: 页面里找不到脚本块\n')
  process.exit(1)
}
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${page.slice(0, marker)}${stub}${page.slice(marker)}`, 'utf8')

process.stdout.write(`${JSON.stringify({ ok: true, page: `file:///${out.replace(/\\/gu, '/')}`, source: pagePath }, null, 2)}\n`)
