/**
 * Build the Electron shell with esbuild.
 *
 * Three output shapes:
 * - the main process is ESM (`dist/main.js`);
 * - a sandboxed preload must be CommonJS (`dist/preload.cjs`), hence its own build call;
 * - the launcher and update documents are plain files copied into `dist/`.
 *
 * The update public key is injected here, read from `src-tauri/tauri.conf.json`, so
 * the minisign trust root has exactly one source of truth across both shells.
 */

import { build } from 'esbuild'
import { copyFile, cp, mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const out = resolve(root, 'dist')

const updateKey = JSON.parse(await readFile(resolve(root, 'update-key.json'), 'utf8'))
const publicKey = updateKey.pubkey
if (typeof publicKey !== 'string' || publicKey === '') {
  throw new Error('build: src-tauri/tauri.conf.json 缺少 plugins.updater.pubkey，无法注入更新公钥')
}

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  // `yaml` is CommonJS and its generated code does `require('process')`, which esbuild cannot turn
  // into an ESM import. Bundling it produced a main.js that threw "Dynamic require of process is not
  // supported" before the app even started, so it stays external and ships as a real dependency
  // inside the ASAR (`electron-builder.config.mjs` adds it to `files`).
  external: ['electron', 'yaml'],
  sourcemap: true,
  logLevel: 'warning',
  define: { __DSH_UPDATE_PUBKEY__: JSON.stringify(publicKey) },
}

await build({
  ...shared,
  entryPoints: [resolve(root, 'src/main.ts')],
  outfile: resolve(out, 'main.js'),
  format: 'esm',
})

await build({
  ...shared,
  entryPoints: [resolve(root, 'src/preload.ts')],
  outfile: resolve(out, 'preload.cjs'),
  format: 'cjs',
})

await cp(resolve(root, 'src/launcher'), resolve(out, 'launcher'), { recursive: true })
await cp(resolve(root, 'src/titlebar'), resolve(out, 'titlebar'), { recursive: true })
await cp(resolve(root, 'src/settings-ui'), resolve(out, 'settings'), { recursive: true })
await cp(resolve(root, 'src/market-ui'), resolve(out, 'market'), { recursive: true })
await cp(resolve(root, 'src/pocket-ui'), resolve(out, 'pocket'), { recursive: true })
await cp(resolve(root, 'src/usage-ui'), resolve(out, 'usage'), { recursive: true })
await cp(resolve(root, 'src/mcp-ui'), resolve(out, 'mcp'), { recursive: true })
// The strip shows the same logo the window and tray use.
await copyFile(resolve(root, 'build', 'icons', '32x32.png'), resolve(out, 'titlebar', 'icon.png'))
// The launcher page shows the product logo. Ship the real artwork (a Tauri-generated
// derivative of `icons/whale-original.png`) rather than an emoji: an emoji renders as
// whatever the OS font decides, which is not this product's logo.
await copyFile(resolve(root, 'build', 'icons', '128x128@2x.png'), resolve(out, 'launcher', 'logo.png'))
await cp(resolve(root, 'src/update'), resolve(out, 'update'), { recursive: true })
process.stdout.write('[build] dist ready\n')
