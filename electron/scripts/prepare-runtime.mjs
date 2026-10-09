#!/usr/bin/env node
/**
 * Materialize the DSH runtime that ships inside the app.
 *
 * The shell is released as one unit with its runtime (docs/update-channel-design.md), so
 * this script:
 *   1. installs the pinned dsh production dependency tree for one target platform;
 *   2. refuses to continue unless the bundled native addon whitelists the V8 fingerprint
 *      of the Electron build we ship — the S1 failure mode, caught at build time;
 *   3. prunes what a runtime never loads (declarations, source maps, sources, tests,
 *      other platforms' prebuilds), and reports the size it saved;
 *   4. writes `desktop-runtime.json`: versions, platform, file count, a list digest, and
 *      per-file hashes for the files that matter (the entry point and every native
 *      module).
 *
 * Output: `electron/runtime/dsh` (build artifact, git-ignored). electron-builder packs this tree
 * into the application ASAR (`resources/app.asar/dsh/**`, one file on disk instead of 12k), and
 * unpacks only the `physical` list from the manifest — see `asar-unpack.mjs`.
 *
 * Usage: node scripts/prepare-runtime.mjs [--force] [--keep-staging]
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isForeignPlatformPath } from './runtime-policy.mjs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(root, '..')
const force = process.argv.includes('--force')
const keepStaging = process.argv.includes('--keep-staging')

const pin = JSON.parse(readFileSync(join(root, 'runtime-pin.json'), 'utf8'))
const shellManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const dshVersion = pin.dsh
const electronVersion = shellManifest.devDependencies.electron
const targetPlatform = process.env.DSH_DESKTOP_TARGET_PLATFORM ?? 'win32'
const targetArch = process.env.DSH_DESKTOP_TARGET_ARCH ?? 'x64'

const staging = join(root, '.runtime-build')
const output = join(root, 'runtime', 'dsh')
const runtimeRoot = join(output, 'node_modules', '@deepseek-ai', 'dsh')

function log(message) {
  process.stdout.write(`${message}\n`)
}

function fail(message) {
  process.stderr.write(`错误：${message}\n`)
  process.exit(1)
}

/** Recursive size, in bytes. */
function measure(directory) {
  let bytes = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) bytes += measure(path)
    else if (entry.isFile()) bytes += statSync(path).size
  }
  return bytes
}

const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`

/**
 * Run npm through its JavaScript entry point.
 *
 * `spawnSync('npm.cmd')` fails with EINVAL on Node 20+ (the `.cmd` spawn mitigation), and
 * going through a shell would drag quoting rules into a build script.
 */
function npm(args, cwd) {
  const entry = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(entry)) {
    execFileSync(process.execPath, [entry, ...args], { cwd, stdio: 'inherit' })
    return
  }
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd, stdio: 'inherit', shell: true })
}

// 1. Install the pinned production tree for this target only, plus the package manager.
//
// dsh forwards `dsh plugin …` to `pnpm` resolved from PATH (`execa('pnpm', …)`, exit 127
// with "pnpm was not found"), so a profile's plugins can only be managed if a pnpm ships
// with the app. Pinning it here also keeps plugin installs off the user's global pnpm.
const pnpmVersion = pin.pnpm
const installedMarker = join(staging, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const upToDate = existsSync(installedMarker)
  && JSON.parse(readFileSync(installedMarker, 'utf8')).version === dshVersion
  && existsSync(join(staging, 'node_modules', 'pnpm', 'package.json'))
  && JSON.parse(readFileSync(join(staging, 'node_modules', 'pnpm', 'package.json'), 'utf8')).version === pnpmVersion
if (force || !upToDate) {
  log(`==> 安装 dsh@${dshVersion} + pnpm@${pnpmVersion}（${targetPlatform}-${targetArch}，仅生产依赖）`)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  writeFileSync(join(staging, 'package.json'), `${JSON.stringify({ name: 'dsh-runtime-staging', private: true }, null, 2)}\n`, 'utf8')
  npm([
    'install',
    `@deepseek-ai/dsh@${dshVersion}`,
    `pnpm@${pnpmVersion}`,
    '--omit=dev',
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    `--os=${targetPlatform}`,
    `--cpu=${targetArch}`,
  ], staging)
} else {
  log(`==> 复用已有 staging（dsh@${dshVersion} + pnpm@${pnpmVersion}）`)
}

const stagedNodeModules = join(staging, 'node_modules')
if (!existsSync(stagedNodeModules)) fail('安装后找不到 node_modules')

// 2. Build-time guard: the addon must whitelist the Electron we ship.
log('==> 校验原生插件与 Electron 的 V8 指纹')
const v8 = execFileSync(
  join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
  ['-p', 'process.versions.v8'],
  { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true },
).toString().trim()
log(`    Electron ${electronVersion} → V8 ${v8}`)

const addonPattern = /node-addon-require-builtin-/
const addonFiles = []
const walk = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (entry.isFile() && entry.name.endsWith('.node') && addonPattern.test(path)) addonFiles.push(path)
  }
}
walk(stagedNodeModules)
if (addonFiles.length === 0) fail('随包运行时里找不到 node-addon-require-builtin 的预构建二进制')
const whitelisted = addonFiles.some((path) => readFileSync(path).includes(Buffer.from(v8, 'utf8')))
if (!whitelisted) {
  fail(
    `随包 dsh 的原生插件不接受 Electron ${electronVersion}（V8 ${v8}）。\n`
    + '这会让 dsh 以 Unsupported/no-context 启动失败。请调整 runtime-pin.json 里的 dsh 版本或 electron 版本。',
  )
}
log(`    ✔ 白名单包含该指纹（检查了 ${String(addonFiles.length)} 个原生模块）`)

// 3. Copy the pristine cache to the packaged location, then prune the copy.
//
// Pruning the cache instead would make a re-run start from an already-damaged tree, and
// the first version of this script did exactly that: a `docs?` directory rule deleted
// `yaml/dist/doc/directives.js`, which is required at runtime. The policy below is
// deliberately narrow — declarations, source maps, sources, build caches, other
// platforms — and never touches directories whose names merely look like documentation.
rmSync(output, { recursive: true, force: true })
mkdirSync(dirname(output), { recursive: true })
cpSync(stagedNodeModules, join(output, 'node_modules'), { recursive: true })

const PRUNE_DIRECTORY = /(^|\/)(tests?|__tests?__|__mocks__)(\/|$)/u
const PRUNE_FILE = [
  /\.d\.(ts|mts|cts)$/u,      // declarations
  /\.map$/u,                  // source maps
  /\.tsbuildinfo$/u,
  /\.pdb$/u,                  // debug symbols: never loaded, 10 MiB of node-pty's conpty
  /\.lib$/u,                  // link-time import library (koffi)
  /\.exp$/u,
  /\.ilk$/u,
  /\.gypi$/u,                 // node-gyp build configuration
  /\.vcxproj(\.filters)?$/u,
  /^binding\.sln$/u,
  /**
   * What electron-builder never copies, mirrored here.
   *
   * `app-builder-lib` has a hardcoded `excludedNames` / `excludedExts` list (`.git`, `.gitkeep`,
   * `.gitignore`, `.npmignore`, `pnpm-lock.yaml`, `package-lock.json`, `__pycache__`, `*.d.ts`,
   * `*.obj`, …) and silently skips those entries. The manifest decides what the runtime *is*, and
   * `verify-package.mjs` compares it against the archive, so any file we count but builder drops
   * makes the packaged check fail — pnpm 11 ships `…/undici/lib/llhttp/.gitkeep`, which is exactly
   * how this was found. Pruning them here keeps `清单 == 实际进包` true by construction.
   */
  /^(\.git|\.hg|\.svn|CVS|RCS|SCCS|__pycache__|\.DS_Store|thumbs\.db|\.gitignore|\.gitkeep|\.gitattributes|\.npmignore|\.idea|\.vs|\.flowconfig|\.jshintrc|\.eslintrc|\.circleci|\.yarn-integrity|\.yarn-metadata\.json|yarn-error\.log|yarn\.lock|package-lock\.json|npm-debug\.log|pnpm-lock\.yaml|bun\.lock|bun\.lockb|appveyor\.yml|\.travis\.yml|circle\.yml|\.nyc_output|\.husky|\.github|electron-builder\.env)$/u,
  /\.(iml|hprof|orig|pyc|pyo|rbc|swp|csproj|sln|suo|xproj|cc|mk|a|o|obj|forge-meta)$/u,
]
/** Extensions that are executed, dlopen'd, or read by a shell: they cannot live in an ASAR. */
const PHYSICAL_EXTENSIONS = ['.exe', '.dll', '.node', '.com', '.cmd', '.bat', '.ps1', '.sh', '.so', '.dylib']
/**
 * A binary with no extension (some projects ship one): sniff the magic bytes.
 *
 * `MZ` (PE), `\x7fELF`, and Mach-O's 0xFEEDFACE/0xFEEDFACF/0xCAFEBABE.
 */
function looksExecutable(path) {
  try {
    const handle = openSync(path, 'r')
    const buffer = Buffer.alloc(4)
    const read = readSync(handle, buffer, 0, 4, 0)
    closeSync(handle)
    if (read < 4) return false
    const [a, b, c, d] = buffer
    if (a === 0x4d && b === 0x5a) return true                                        // PE
    if (a === 0x7f && b === 0x45 && c === 0x4c && d === 0x46) return true             // ELF
    const magic = buffer.readUInt32BE(0)
    return magic === 0xfeedface || magic === 0xfeedfacf || magic === 0xcafebabe
  } catch {
    return false
  }
}
/** Other platforms' and architectures' binaries: never loadable here. */
const foreign = (relativePath) => isForeignPlatformPath(relativePath, targetPlatform, targetArch)

const packagedNodeModules = join(output, 'node_modules')
let removedFiles = 0
let removedBytes = 0
const prune = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const relativePath = relative(packagedNodeModules, path).split(sep).join('/')
    if (entry.isDirectory()) {
      if (PRUNE_DIRECTORY.test(relativePath) || foreign(relativePath)) {
        removedBytes += measure(path)
        rmSync(path, { recursive: true, force: true })
        removedFiles += 1
        continue
      }
      prune(path)
      continue
    }
    if (!entry.isFile()) continue
    const prunable = PRUNE_FILE.some(pattern => pattern.test(entry.name))
      || (/\.ts$/u.test(entry.name) && /(^|\/)src\//u.test(relativePath))
      || foreign(relativePath)
    if (!prunable) continue
    removedBytes += statSync(path).size
    rmSync(path, { force: true })
    removedFiles += 1
  }
}
const stagedBytes = measure(packagedNodeModules)
prune(packagedNodeModules)
const prunedBytes = measure(packagedNodeModules)
log(`==> 裁剪：移除 ${String(removedFiles)} 项 / ${mib(removedBytes)}，${mib(stagedBytes)} → ${mib(prunedBytes)}`)

// 3b. Prove the pruned tree still loads before it is packaged.
//
// The failure this guards against is silent at prune time and fatal at startup: a rule
// that removes something a plugin require()s only surfaces when dsh boots.
log('==> 校验裁剪后的运行时可以加载')
const prunedEntry = join(output, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const nodeMode = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
const electronBinary = join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
try {
  const printed = execFileSync(electronBinary, [prunedEntry, '--version'], { env: nodeMode, windowsHide: true }).toString().trim()
  if (!printed.includes(dshVersion)) fail(`裁剪后的运行时 --version 输出异常：${printed}`)
  // `web --help` composes the profile and loads the plugin set: a broader load test.
  execFileSync(electronBinary, [prunedEntry, 'web', '--help'], { env: nodeMode, windowsHide: true, stdio: 'pipe' })
} catch (error) {
  fail(`裁剪后的运行时无法加载，说明裁剪规则删掉了运行期需要的文件：\n${String(error)}`)
}
log('    ✔ --version 与 web --help 均正常')

// 3c. Shims that make the bundled tools reachable from the dsh child's PATH.
//
// The shell prepends this directory to PATH and sets DSH_DESKTOP_NODE_EXECUTABLE to its
// own binary, so `pnpm` inside a profile runs on the packaged Electron in Node mode —
// no second Node runtime on the machine. `node` is shimmed too because plugin install
// scripts expect it.
//
// **Nothing here may depend on those variables existing.** DSH scrubs every `DSH_`-prefixed variable
// out of the environment it hands to children (`scrubbedParentEnv` in `dsh-subprocess`), and its
// plugin installer runs `pnpm add` through exactly that path: the variables are gone while `PATH`
// still finds this shim. That is how "install plugin" failed with `cannot find the bundled pnpm`
// even though the app was running and healthy. So the shim locates the app binary from its own
// location and sets `ELECTRON_RUN_AS_NODE` itself; the variables stay as a first-choice hint (they
// are more precise in a prepared, unpacked tree).
const shimDir = join(output, 'bin')
mkdirSync(shimDir, { recursive: true })
/** Resolve the app binary the same way in both shims: hint, then the install root, then plain node. */
const appBinary = [
  'set "DSH_NODE=%DSH_DESKTOP_NODE_EXECUTABLE%"',
  'rem %~dp0 is <install>\\resources\\app.asar.unpacked\\dsh\\bin, so the app binary is four levels up.',
  'rem Both product names this repository ships: the release channel and the debug channel.',
  'if not defined DSH_NODE if exist "%~dp0..\\..\\..\\..\\DSH Desktop.exe" set "DSH_NODE=%~dp0..\\..\\..\\..\\DSH Desktop.exe"',
  'if not defined DSH_NODE if exist "%~dp0..\\..\\..\\..\\DSH Desktop Debug.exe" set "DSH_NODE=%~dp0..\\..\\..\\..\\DSH Desktop Debug.exe"',
]
// No parenthesised blocks anywhere in these shims: `cmd` parses a whole `( … )` block before running
// it, so a stray bracket in an echoed message breaks the script even on a branch that is never taken
// (an error line containing "(this shim only works inside DSH Desktop)" did exactly that, and only in
// the prepared tree, because the packaged layout never reaches that branch). `goto` labels instead.
writeFileSync(join(shimDir, 'pnpm.cmd'), [
  '@echo off',
  'setlocal',
  'rem Bundled pnpm: runs on the app\'s own Electron in Node mode. See prepare-runtime.mjs.',
  ...appBinary,
  'set "DSH_PNPM_JS=%DSH_DESKTOP_PNPM_ENTRY%"',
  'if not defined DSH_PNPM_JS set "DSH_PNPM_JS=%~dp0..\\node_modules\\pnpm\\bin\\pnpm.cjs"',
  'rem `if exist` cannot see inside app.asar - it is one file, not a directory - so the packaged',
  'rem location is taken on trust once the prepared tree\'s relative path is absent.',
  'if not exist "%DSH_PNPM_JS%" set "DSH_PNPM_JS=%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\pnpm\\bin\\pnpm.cjs"',
  'rem Without this the app binary would open the GUI instead of running the script.',
  'set "ELECTRON_RUN_AS_NODE=1"',
  'if defined DSH_NODE goto :runWithApp',
  'if exist "%~dp0..\\node_modules\\pnpm\\bin\\pnpm.cjs" goto :runWithNode',
  'echo DSH Desktop: cannot find the bundled pnpm - this shim only works inside DSH Desktop. 1>&2',
  'exit /b 1',
  ':runWithApp',
  '"%DSH_NODE%" "%DSH_PNPM_JS%" %*',
  'goto :eof',
  'rem A prepared tree next to a development checkout: an ordinary node is enough.',
  ':runWithNode',
  'node "%DSH_PNPM_JS%" %*',
  '',
].join('\r\n'), 'utf8')
writeFileSync(join(shimDir, 'node.cmd'), [
  '@echo off',
  'setlocal',
  'rem Node shell for plugin install scripts; the app binary in Node mode. Same rule as pnpm.cmd:',
  'rem the environment may have been scrubbed of our DSH_-prefixed variables, and no `( … )` blocks.',
  ...appBinary,
  'set "ELECTRON_RUN_AS_NODE=1"',
  'if defined DSH_NODE goto :runWithApp',
  'node %*',
  'goto :eof',
  ':runWithApp',
  '"%DSH_NODE%" %*',
  '',
].join('\r\n'), 'utf8')

// Prove the shim resolves before packaging: a broken shim only surfaces when a user tries
// to install a plugin.
const pnpmEntryPath = join(output, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
const shimEnv = { ...process.env, DSH_DESKTOP_NODE_EXECUTABLE: electronBinary, ELECTRON_RUN_AS_NODE: '1' }
const shimCheck = execFileSync(`"${join(shimDir, 'pnpm.cmd')}" --version`, {
  env: shimEnv,
  windowsHide: true,
  shell: true,
}).toString().trim()
if (!/^\d+\.\d+\.\d+/u.test(shimCheck)) fail(`随包 pnpm shim 不可用，输出：${shimCheck}`)
log(`    ✔ 随包 pnpm shim 可用（相对路径分支，pnpm ${shimCheck}）`)
// The packaged app cannot use the relative path (pnpm ships inside app.asar, the shim outside it),
// so the env-var branch is the one that ships: exercise it here rather than in production.
const shimCheckViaEnv = execFileSync(`"${join(shimDir, 'pnpm.cmd')}" --version`, {
  env: { ...shimEnv, DSH_DESKTOP_PNPM_ENTRY: pnpmEntryPath },
  windowsHide: true,
  shell: true,
}).toString().trim()
if (!/^\d+\.\d+\.\d+/u.test(shimCheckViaEnv)) fail(`随包 pnpm shim 的 DSH_DESKTOP_PNPM_ENTRY 分支不可用，输出：${shimCheckViaEnv}`)
log(`    ✔ 随包 pnpm shim 可用（DSH_DESKTOP_PNPM_ENTRY 分支，pnpm ${shimCheckViaEnv}）`)
// The ASAR branch only exists in the packaged layout (it is derived from the shim's own location),
// so `verify-package.mjs` exercises it against `release/win-unpacked` instead.

const entryRelative = 'node_modules/@deepseek-ai/dsh/lib/bin.js'
const entryPath = join(output, entryRelative)
if (!existsSync(entryPath)) fail(`随包运行时缺少入口 ${entryRelative}`)

const files = []
/** The manifest describes the tree; it is not part of it. Re-running prepare leaves the previous
 *  run's copy behind, and counting it made the packaged file count off by one — which
 *  `verify-package.mjs` then refused (`清单声明 N + 1`). */
const MANIFEST_FILENAME = 'desktop-runtime.json'
const collect = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) collect(path)
    else if (entry.isFile() && entry.name !== MANIFEST_FILENAME) files.push(relative(output, path).split(sep).join('/'))
  }
}
collect(output)
files.sort()

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const listDigest = createHash('sha256')
  .update(files.map(file => `${file}:${String(statSync(join(output, file)).size)}`).join('\n'))
  .digest('hex')

// Hash only what matters for integrity: the entry point, the tool shims, and every native
// module. Hashing the whole tree at startup would cost seconds; these are the files that
// execute.
const critical = {}
for (const file of files) {
  // Foreign binaries are excluded twice over: they are pruned above, and they can never
  // enter the integrity set even if one slips through — hashing a file the app will never
  // load is how a working install got refused once already.
  if (foreign(file)) continue
  if (file === entryRelative
    || file === 'bin/pnpm.cmd'
    || file === 'bin/node.cmd'
    || file.endsWith('.node') || file.endsWith('.dll') || file.endsWith('.exe')) {
    critical[file] = sha256(join(output, file))
  }
}

// What electron-builder must keep outside `app.asar`. Extension first (the common case), then a
// magic-byte sniff for the rare extension-less binary — the sniff only runs where the extension
// says nothing, so it costs ~600 four-byte reads.
const physical = files.filter((file) => {
  if (foreign(file)) return false
  const lower = file.toLowerCase()
  if (PHYSICAL_EXTENSIONS.some(extension => lower.endsWith(extension))) return true
  const name = file.slice(file.lastIndexOf('/') + 1)
  if (name.includes('.')) return false
  return looksExecutable(join(output, file))
})

const manifest = {
  schema: 1,
  shell: shellManifest.version,
  dsh: dshVersion,
  pnpm: pnpmVersion,
  electron: electronVersion,
  v8,
  node: process.versions.node,
  platform: targetPlatform,
  arch: targetArch,
  entry: entryRelative,
  files: files.length,
  bytes: measure(output),
  listDigest,
  critical,
  // Files that must stay physical: the whole tree is packed into `app.asar` (12.4k small files
  // would otherwise have to be written one by one at install time), and only these cannot be
  // loaded from inside an archive — Electron runs/loads them through the filesystem, and a
  // `.cmd` cannot be read by cmd.exe. `electron-builder.config.mjs` turns this list into
  // `asarUnpack`, and `verify-package.mjs` asserts every entry really landed in
  // `app.asar.unpacked` (a missing pattern is a startup failure, not a slow install).
  physical,
}
writeFileSync(join(output, 'desktop-runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

log(`==> 运行时清单已写出：${String(files.length)} 个文件 / ${mib(manifest.bytes)}，关键文件 ${String(Object.keys(critical).length)} 个，需物理落盘 ${String(physical.length)} 个`)
log(`    entry sha256 ${critical[entryRelative]?.slice(0, 16) ?? '(缺失)'}…`)
// Staging is kept as a cache: a repeat build with the same pin skips the install.
if (keepStaging === false && process.argv.includes('--clean-staging')) {
  rmSync(staging, { recursive: true, force: true })
}
log('==> 完成')
