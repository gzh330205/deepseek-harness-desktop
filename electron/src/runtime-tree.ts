/**
 * Verification of the DSH runtime that ships inside the app.
 *
 * `scripts/prepare-runtime.mjs` writes `desktop-runtime.json` next to the bundled tree.
 * At startup the shell checks that the tree is the one that was packaged: same platform,
 * same Electron, and byte-identical files where execution actually happens (the dsh entry
 * point and every native module).
 *
 * Hashing the whole tree would cost seconds on every launch; hashing the ~10 files that
 * load native code and the entry point costs milliseconds and covers the parts an
 * attacker or a corrupt install would have to change to run code.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface RuntimeManifest {
  readonly schema: number
  readonly shell: string
  readonly dsh: string
  readonly electron: string
  readonly v8: string
  readonly node: string
  readonly platform: string
  readonly arch: string
  readonly entry: string
  readonly files: number
  readonly bytes: number
  readonly listDigest: string
  readonly critical: Readonly<Record<string, string>>
}

export type RuntimeVerification =
  | { readonly ok: true; readonly manifest: RuntimeManifest; readonly entryPath: string }
  | { readonly ok: false; readonly reason: string; readonly detail?: string }

export const RUNTIME_MANIFEST_FILENAME = 'desktop-runtime.json'

/** Path of the dsh entry point inside an unpacked runtime root. */
export function runtimeEntryPath(root: string, manifest: RuntimeManifest): string {
  return join(root, manifest.entry)
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function readRuntimeManifest(root: string): RuntimeManifest | string {
  const path = join(root, RUNTIME_MANIFEST_FILENAME)
  if (!existsSync(path)) return `随包运行时缺少 ${RUNTIME_MANIFEST_FILENAME}`
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as RuntimeManifest
    if (parsed.schema !== 1) return `运行时清单 schema 不受支持：${String(parsed.schema)}`
    if (typeof parsed.entry !== 'string' || typeof parsed.critical !== 'object' || parsed.critical === null) {
      return '运行时清单缺少 entry / critical'
    }
    return parsed
  } catch (error) {
    return `运行时清单无法解析：${String(error)}`
  }
}

/**
 * Verify one bundled runtime.
 *
 * @param options.root - Directory holding `desktop-runtime.json` and `node_modules/`.
 * @param options.electron - `process.versions.electron` of the running shell.
 * @param options.platform - `process.platform`.
 * @param options.arch - `process.arch`.
 */
export function verifyRuntime(options: {
  readonly root: string
  readonly electron: string
  readonly platform: string
  readonly arch: string
}): RuntimeVerification {
  const manifest = readRuntimeManifest(options.root)
  if (typeof manifest === 'string') return { ok: false, reason: 'manifest-unreadable', detail: manifest }

  if (manifest.platform !== options.platform || manifest.arch !== options.arch) {
    return {
      ok: false,
      reason: 'platform-mismatch',
      detail: `运行时为 ${manifest.platform}-${manifest.arch}，当前为 ${options.platform}-${options.arch}`,
    }
  }
  // The bundled runtime is released with one exact Electron, whose V8 fingerprint the
  // bundled native addon whitelists. A different Electron cannot load it.
  if (manifest.electron !== options.electron) {
    return {
      ok: false,
      reason: 'electron-mismatch',
      detail: `运行时随 Electron ${manifest.electron} 打包，当前为 ${options.electron}`,
    }
  }

  const entryPath = runtimeEntryPath(options.root, manifest)
  if (!existsSync(entryPath)) {
    return { ok: false, reason: 'entry-missing', detail: manifest.entry }
  }

  for (const [relativePath, expected] of Object.entries(manifest.critical)) {
    const path = join(options.root, relativePath)
    if (!existsSync(path)) {
      return { ok: false, reason: 'file-missing', detail: relativePath }
    }
    const size = statSync(path).size
    if (size === 0) return { ok: false, reason: 'file-empty', detail: relativePath }
    let actual: string
    try {
      actual = sha256(path)
    } catch (error) {
      return { ok: false, reason: 'file-unreadable', detail: `${relativePath}: ${String(error)}` }
    }
    if (actual !== expected) {
      return { ok: false, reason: 'hash-mismatch', detail: relativePath }
    }
  }

  return { ok: true, manifest, entryPath }
}

/** Human-readable repair guidance for a failed verification. */
export function describeRuntimeFailure(verification: Extract<RuntimeVerification, { ok: false }>): string {
  const suffix = verification.detail === undefined ? '' : `（${verification.detail}）`
  switch (verification.reason) {
    case 'platform-mismatch':
    case 'electron-mismatch':
      return `随包运行时与当前应用不匹配${suffix}。请重新安装本应用。`
    case 'entry-missing':
    case 'file-missing':
    case 'file-empty':
    case 'hash-mismatch':
      return `随包运行时文件损坏或不完整${suffix}。请重新安装本应用。`
    case 'manifest-unreadable':
      return `随包运行时清单不可读${suffix}。请重新安装本应用。`
    default:
      return `随包运行时校验失败${suffix}。请重新安装本应用。`
  }
}
