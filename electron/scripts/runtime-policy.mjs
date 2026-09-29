/**
 * Which files a packaged runtime may contain.
 *
 * Only the files this build can actually load belong in the tree. Shipping other
 * platforms' and other architectures' binaries is dead weight — and it is how a real
 * failure happened: two ARM64 conpty files (`third_party/conpty/<v>/win10-arm64/`) were
 * shipped, hashed into `desktop-runtime.json`, and did not survive an NSIS install
 * (`win-unpacked` had them; the installed tree had the directory but it was empty). The
 * shell then refused to start with "随包运行时文件损坏或不完整".
 *
 * Two rules follow, and both are enforced by scripts/prepare-runtime.mjs:
 *   1. foreign platform/arch binaries are pruned before packaging;
 *   2. they can never enter the integrity set, so a packaging quirk cannot brick a user
 *      over a file the app would never load anyway.
 *
 * Kept as a module (not inlined in the build script) so it is covered by tests: the names
 * third-party packages use are irregular — node-pty says `win10-arm64`, pnpm says
 * `reflink.win32-arm64-msvc-….node`, sharp says `sharp-darwin-arm64`, koffi says
 * `win32_x64` — and a rule that misses one of them is exactly the bug this guards against.
 *
 * The decision is token-based and relative to the target: `win32` is foreign when building
 * for macOS and native when building for Windows, so a single hard-coded blacklist would
 * be wrong in one of the two directions.
 */

/** Every platform token any package might use for a directory or file name. */
const PLATFORM_TOKENS = [
  'darwin', 'macos', 'osx', 'ios',
  'linux', 'android', 'freebsd', 'openbsd', 'netbsd', 'sunos', 'aix',
  'win32', 'win64', 'win10', 'windows', 'mingw',
]

/** Architecture tokens. `x86` is deliberately absent: `x86_64` means x64. */
const ARCH_TOKENS = [
  'arm64', 'aarch64', 'armv7', 'armv7l', 'armhf', 'armel',
  'ia32', 'ppc64', 'ppc64le', 's390x', 'riscv64', 'loong64', 'mips64', 'mips64el',
  'x64', 'amd64',
]

/** Tokens that describe the platform being built for, per Node's `process.platform`. */
const OWN_PLATFORM = {
  win32: ['win32', 'win64', 'win10', 'windows', 'mingw'],
  darwin: ['darwin', 'macos', 'osx', 'ios'],
  linux: ['linux'],
}

/** Tokens that describe the architecture being built for, per Node's `process.arch`. */
const OWN_ARCH = {
  x64: ['x64', 'amd64'],
  arm64: ['arm64', 'aarch64'],
  ia32: ['ia32'],
}

const alternation = (tokens) => new RegExp(`(^|[/._-])(?:${tokens.join('|')})([/._-]|$)`, 'u')

/**
 * True when a runtime-tree-relative path belongs to another platform or architecture and
 * must not be shipped.
 *
 * @param relativePath - Path inside the runtime.
 * @param platform - Target platform, e.g. `win32`.
 * @param arch - Target architecture, e.g. `x64`.
 * @returns Whether the path names a foreign platform or architecture.
 */
export function isForeignPlatformPath(relativePath, platform = 'win32', arch = 'x64') {
  const path = String(relativePath).replace(/\\/gu, '/').toLowerCase()

  const ownPlatform = OWN_PLATFORM[platform] ?? [platform]
  const ownArch = OWN_ARCH[arch] ?? [arch]
  const foreignPlatform = PLATFORM_TOKENS.filter(token => !ownPlatform.includes(token))
  const foreignArch = ARCH_TOKENS.filter(token => !ownArch.includes(token))

  return alternation(foreignPlatform).test(path) || alternation(foreignArch).test(path)
}
