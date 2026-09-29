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

const debug = process.env.DSH_DESKTOP_CHANNEL === 'debug'

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
  ],
  extraResources: [
    // The DSH runtime the app ships with: dsh's production dependency tree plus
    // desktop-runtime.json. Outside the asar so native modules load normally.
    { from: 'runtime/dsh', to: 'runtime/dsh' },
    // electron-builder excludes a source directory's root `node_modules`; without this
    // second entry only desktop-runtime.json is copied and the packaged app has no
    // runtime at all. The exit code is still 0, so this is silent — verify the file
    // count after packaging (scripts/verify-package.mjs does).
    { from: 'runtime/dsh/node_modules', to: 'runtime/dsh/node_modules', filter: ['**/*'] },
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
