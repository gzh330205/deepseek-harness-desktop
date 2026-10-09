/**
 * electron-builder configuration for the Electron shell.
 *
 * Two decisions worth knowing about:
 *
 * 1. `publish` is intentionally null. The update channel is our own minisign +
 *    `latest.json` design (docs/update-channel-design.md); electron-updater's
 *    Windows signature check is skipped entirely when `app-update.yml` has no
 *    `publisherName`, so it must not be the integrity gate.
 * 2. `appId` reuses the identifier the Tauri shell already ships, and the app sets
 *    its userData directory to the same `%APPDATA%\ai.deepseek.dsh-desktop` path, so
 *    an existing user keeps `shell-settings.json` and the DSH panel keeps reading the
 *    same bridge directory.
 *
 * `DSH_DESKTOP_CHANNEL=debug` builds a second, fully separate product: its own appId,
 * product name, install directory, shortcut, userData and default port, so it can be
 * installed and run next to the shipping Tauri app without disturbing it. That build is
 * never published — `scripts/release-electron.mjs` only knows the release channel.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { asarUnpackPatterns } from './scripts/asar-unpack.mjs'

const debug = process.env.DSH_DESKTOP_CHANNEL === 'debug'

/**
 * The runtime goes **inside** the ASAR, and only the files that cannot be loaded from an archive
 * are unpacked beside it.
 *
 * Why: the prepared runtime is ~12,400 files, and an installer pays per file, not per byte
 * (measured on this machine: 12.4k files = 18.5 s, the same 360 MiB as one file = 0.2 s). Inside
 * the ASAR the whole tree is one file on disk. The `physical` list in the manifest is produced by
 * `prepare-runtime.mjs` (executables, native modules, shell scripts, plus a magic-byte sniff for
 * extension-less binaries), and `verify-package.mjs` fails the build if any of it did not land in
 * `app.asar.unpacked`.
 */
const runtimeRoot = join(dirname(fileURLToPath(import.meta.url)), 'runtime', 'dsh')
const runtimeManifestPath = join(runtimeRoot, 'desktop-runtime.json')
const physicalRuntimeFiles = existsSync(runtimeManifestPath)
  ? JSON.parse(readFileSync(runtimeManifestPath, 'utf8')).physical ?? []
  : []
if (physicalRuntimeFiles.length === 0) {
  // Never ship an ASAR-packed runtime with nothing unpacked: the `.node`/`.exe` files inside an
  // archive are exactly what makes the app refuse to start.
  throw new Error('electron-builder: runtime/dsh/desktop-runtime.json has no physical file list; run `pnpm runtime:prepare`')
}

export default {
  appId: debug ? 'ai.deepseek.dsh-desktop.debug' : 'ai.deepseek.dsh-desktop',
  productName: debug ? 'DSH Desktop Debug' : 'DSH Desktop',
  // Baked into the packaged package.json: the app reads it to pick its default port,
  // userData directory and DSH profile without needing environment variables.
  extraMetadata: { dshDesktopChannel: debug ? 'debug' : 'release' },
  copyright: 'Copyright © 2026 DeepSeek Harness Desktop',
  // A separate output directory: building the debug channel must not clobber the release
  // artifacts (and vice versa).
  directories: { output: debug ? 'release-debug' : 'release', buildResources: 'build' },
  asar: true,
  // Every .pak is ~0.9 MB and the default set is 55 locales: 49 MB of the payload for
  // languages this product does not ship. Updates are full downloads today, so this is
  // the cheapest size win available.
  electronLanguages: ['en-US', 'zh-CN'],
  // The Tauri shell relies on CREATE_NO_WINDOW; this shell relies on Electron's own
  // Node mode, which the fuse must allow.
  electronFuses: { runAsNode: true },
  files: [
    'dist/**/*',
    'package.json',
    // The DSH runtime, packed into the ASAR (`resources/app.asar/dsh/**`). The second entry is the
    // same workaround `extraResources` needed: electron-builder excludes a source directory's root
    // `node_modules`, and the exit code is still 0 when it does — `verify-package.mjs` catches it.
    //
    // Note that builder *also* silently skips its own hardcoded `excludedNames`/`excludedExts`
    // (`.gitkeep`, `.gitignore`, `pnpm-lock.yaml`, `*.obj`, …). `prepare-runtime.mjs` prunes exactly
    // that set so the manifest counts only what can actually be packed; otherwise the packaged
    // file-count check fails with the tree and the archive disagreeing by those entries.
    { from: 'runtime/dsh', to: 'dsh', filter: ['**/*'] },
    { from: 'runtime/dsh/node_modules', to: 'dsh/node_modules', filter: ['**/*'] },
  ],
  // Everything in the manifest's `physical` list, escaped for builder's glob matcher.
  //
  // The prefix is the **source** path (`runtime/dsh/...`), not the destination it lands at inside
  // the archive (`dsh/...`): builder feeds the pattern the original file path and applies `to:` only
  // when writing the archive. Getting this wrong is silent — the runtime is packed, nothing is
  // unpacked, and the app then refuses to start — so `verify-package.mjs` asserts the physical half
  // really exists under `app.asar.unpacked`.
  asarUnpack: asarUnpackPatterns(physicalRuntimeFiles, 'runtime/dsh'),
  extraResources: [
    // The DSH panel plugin travels with the installer and is injected via --patch.
    { from: '../src-tauri/resources/dsh-desktop-shell', to: 'dsh-desktop-shell' },
    // Tray and window icons (tray.ts reads these from process.resourcesPath).
    { from: '../src-tauri/icons/icon.png', to: 'icon.png' },
    { from: '../src-tauri/icons/icon.ico', to: 'tray.ico' },
  ],
  win: {
    icon: '../src-tauri/icons/icon.ico',
    target: [{ target: 'nsis', arch: ['x64'] }],
    // No code-signing certificate: the minisign signature in latest.json is the gate.
    forceCodeSigning: false,
  },
  nsis: {
    oneClick: false,
    // The debug channel installs per machine (admin): a separate directory under
    // Program Files is the clearest possible separation from the per-user Tauri install.
    perMachine: debug,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: debug ? 'DSH Desktop Debug' : 'DSH Desktop',
    // Translates the Tauri updater's /UPDATE switch into a silent install.
    include: 'scripts/installer-bridge.nsh',
    // Data lives outside the install directory and is shared with the Tauri shell.
    deleteAppDataOnUninstall: false,
    runAfterFinish: true,
    // No spaces: GitHub replaces spaces with dots when uploading assets, and the
    // manifest URL must match the uploaded name byte for byte.
    artifactName: debug ? 'DSH.Desktop-Debug_${version}_x64-setup.${ext}' : 'DSH.Desktop_${version}_x64-setup.${ext}',
    installerLanguages: ['zh_CN', 'en_US'],
    language: '2052',
  },
  // The update channel is ours; electron-builder must not write latest.yml here.
  publish: null,
  compression: 'maximum',
}
