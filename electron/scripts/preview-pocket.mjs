#!/usr/bin/env node
/**
 * Render the phone-access window in a browser with a stubbed bridge, so the layout can be looked at.
 *
 * The window is an Electron window, and no screenshot tool reaches it — the same problem
 * `preview-settings.mjs` solves for the settings page. This page has more that can look wrong without
 * being broken: two connect blocks that must not show a 148px hole when there is nothing to scan, an
 * App download that must stay hidden until asked for, and a public status that says "not started",
 * "running" or "why it failed".
 *
 * The stub is stateful, so the buttons can be clicked in the preview: the LAN switch saves, the App
 * button toggles, and `pocket()` answers like the shell does. The QR codes come from the real
 * `pocket-qr.ts`, so what you see is what the window shows.
 *
 * Usage: node scripts/preview-pocket.mjs [--out <file>]
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { pocketQrDataUrl } from '../src/pocket-qr.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const out = resolve(outIndex >= 0 && args[outIndex + 1] !== undefined ? args[outIndex + 1] : join(tmpdir(), 'dsh-pocket-preview', 'index.html'))

const pagePath = join(root, 'src', 'pocket-ui', 'index.html')
const page = readFileSync(pagePath, 'utf8')

const lanUrl = 'http://192.168.1.7:41735/'
const wanUrl = 'https://random-words-here.trycloudflare.com/'
const snapshot = {
  values: {
    pocketEnabled: true,
    pocketPort: 41735,
    pocketTunnelPort: 41731,
    pocketTunnelMode: 'quick',
    pocketTunnelDomain: '',
  },
  pocket: {
    enabled: true,
    running: true,
    port: 41735,
    url: lanUrl,
    password: 'Kf7mQ2xp',
    candidates: [
      { address: '192.168.1.7', name: 'Wi-Fi', virtual: false },
      { address: '10.1.6.35', name: 'Ethernet', virtual: false },
      { address: '172.20.0.1', name: 'vEthernet (WSL)', virtual: true },
    ],
    selected: '192.168.1.7',
    qr: pocketQrDataUrl(lanUrl),
    apkUrl: 'https://github.com/gzh330205/deepseek-harness-desktop/releases/latest/download/DSH.Pocket.apk',
    apkQr: pocketQrDataUrl('https://github.com/gzh330205/deepseek-harness-desktop/releases/latest/download/DSH.Pocket.apk', { cellSize: 3 }),
    publicAccess: {
      enabled: true,
      running: true,
      mode: 'quick',
      domain: '',
      port: 41731,
      url: wanUrl,
      password: 'sisq95te',
      customPassword: false,
      hasToken: false,
      available: true,
      qr: pocketQrDataUrl(wanUrl),
    },
  },
}

// The stub must exist before the page's own script reads it.  `save` merges, and `pocket` answers the
// current status, so the preview behaves like the real window for the things a person would click.
const stub = `  <script>
    const __state = ${JSON.stringify(snapshot)};
    window.__DSH_SETTINGS__ = {
      get: () => Promise.resolve(__state),
      save: (patch) => {
        Object.assign(__state.values, patch);
        if (patch.pocketEnabled === false) { __state.pocket.running = false; __state.pocket.url = undefined; __state.pocket.qr = undefined; }
        if (patch.pocketEnabled === true) { __state.pocket.running = true; __state.pocket.url = '${lanUrl}'; __state.pocket.qr = ${JSON.stringify(pocketQrDataUrl(lanUrl))}; }
        return Promise.resolve({ ok: true, changed: Object.keys(patch), restartRequired: false });
      },
      close: () => Promise.resolve(true),
      restart: () => Promise.resolve(true),
      pocket: (action) => {
        if (action && action.kind === 'stopTunnel') { __state.pocket.publicAccess.running = false; __state.pocket.publicAccess.url = undefined; }
        if (action && action.kind === 'startTunnel') { __state.pocket.publicAccess.running = true; __state.pocket.publicAccess.url = '${wanUrl}'; }
        return Promise.resolve(__state.pocket);
      },
    };
  </script>
`
const marker = page.lastIndexOf('  <script>')
if (marker < 0) {
  process.stderr.write('preview-pocket: 页面里找不到脚本块\n')
  process.exit(1)
}
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${page.slice(0, marker)}${stub}${page.slice(marker)}`, 'utf8')

process.stdout.write(`${JSON.stringify({ ok: true, page: `file:///${out.replace(/\\/gu, '/')}`, source: pagePath }, null, 2)}\n`)
