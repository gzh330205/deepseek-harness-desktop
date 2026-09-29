/**
 * The update channel: one `latest.json` manifest, minisign as the only integrity gate.
 *
 * Flow: manifest → version comparison → download with progress → **verify the bytes on
 * disk** → install with `/S --updated`.
 *
 * electron-updater deliberately plays no part here. Its Windows signature check
 * returns early when `app-update.yml` carries no `publisherName`, which is exactly the
 * situation for an unsigned build, so it would install an unverified installer.
 * See docs/update-channel-design.md.
 */

import { createWriteStream } from 'node:fs'
import { readFile, rm, stat } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawn } from 'node:child_process'

import { DEFAULT_UPDATE_MANIFEST_URL, UPDATE_MANIFEST_URL_ENV } from './constants.ts'
import { compareVersions } from './gates.ts'
import { verifyMinisign, type MinisignResult } from './minisign.ts'

/**
 * The public key from `src-tauri/tauri.conf.json`, injected at build time by
 * `build.mjs` so the private key's counterpart has exactly one source of truth.
 */
declare const __DSH_UPDATE_PUBKEY__: string

export interface UpdateEntry {
  readonly signature: string
  readonly url: string
}

export interface UpdateManifest {
  readonly version: string
  readonly notes?: string
  readonly pubDate?: string
  readonly entry: UpdateEntry
}

export function updatePublicKey(): string {
  return __DSH_UPDATE_PUBKEY__
}

/** Manifest location, overridable so a rehearsal can point at a prerelease asset. */
export function manifestUrl(): string {
  const override = process.env[UPDATE_MANIFEST_URL_ENV]
  return override === undefined || override === '' ? DEFAULT_UPDATE_MANIFEST_URL : override
}

/**
 * Fetch and validate the manifest.
 *
 * Unknown fields are ignored on purpose: the same file is read by the Tauri clients,
 * so new keys must stay additive.
 */
export async function fetchManifest(url: string, timeoutMs = 20_000): Promise<UpdateManifest> {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`更新清单请求失败：HTTP ${String(response.status)}`)
  const raw = await response.json() as Record<string, unknown>
  const version = raw.version
  if (typeof version !== 'string' || version === '') throw new Error('更新清单缺少 version')
  const platforms = raw.platforms
  if (typeof platforms !== 'object' || platforms === null) throw new Error('更新清单缺少 platforms')
  const windows = (platforms as Record<string, unknown>)['windows-x86_64']
  if (typeof windows !== 'object' || windows === null) throw new Error('更新清单缺少 windows-x86_64')
  const entry = windows as Record<string, unknown>
  const signature = entry.signature
  const entryUrl = entry.url
  if (typeof signature !== 'string' || signature === '') throw new Error('更新清单缺少 signature')
  if (typeof entryUrl !== 'string' || !entryUrl.startsWith('https://')) {
    throw new Error('更新清单的 url 必须是 https')
  }
  return {
    version,
    ...(typeof raw.notes === 'string' ? { notes: raw.notes } : {}),
    ...(typeof raw.pub_date === 'string' ? { pubDate: raw.pub_date } : {}),
    entry: { signature, url: entryUrl },
  }
}

/** Whether `candidate` should replace `current`. Clients never accept a downgrade. */
export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0
}

/** Installer file name for a version; matches the artifact name electron-builder emits. */
export function installerFileName(version: string): string {
  return `DSH.Desktop_${version}_x64-setup.exe`
}

export interface DownloadProgress {
  readonly received: number
  readonly total: number
}

/**
 * Stream a URL to disk, reporting progress. No resume: the file is re-fetched whole,
 * which keeps the verified bytes unambiguously tied to one download.
 */
export async function downloadInstaller(
  url: string,
  destination: string,
  onProgress: (progress: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(url, { redirect: 'follow', signal: signal ?? AbortSignal.timeout(30 * 60_000) })
  if (!response.ok) throw new Error(`安装包下载失败：HTTP ${String(response.status)}`)
  if (response.body === null) throw new Error('安装包下载失败：响应没有 body')
  const total = Number(response.headers.get('content-length') ?? '0')
  let received = 0
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length
      onProgress({ received, total })
      callback(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), counter, createWriteStream(destination))
  if (total > 0 && received !== total) {
    throw new Error(`安装包下载不完整：${String(received)}/${String(total)} 字节`)
  }
}

/**
 * Verify a downloaded installer against the manifest signature.
 *
 * This is the only place a downloaded artifact becomes trustworthy; the caller must
 * refuse to install when it returns not-ok.
 */
export async function verifyInstaller(
  path: string,
  signature: string,
  publicKey = updatePublicKey(),
  onProgress?: (processed: number, total: number) => void,
): Promise<MinisignResult> {
  const info = await stat(path)
  if (info.size === 0) return { ok: false, reason: '安装包为空文件' }
  const content = await readFile(path)
  return await verifyMinisign(content, signature, publicKey, onProgress === undefined ? {} : { onProgress })
}

/** Remove a downloaded installer, e.g. after a failed verification. */
export async function discardInstaller(path: string): Promise<void> {
  await rm(path, { force: true })
}

/**
 * Launch the verified installer.
 *
 * - `/S` is NSIS silent;
 * - `--updated` is electron-builder's "preserve user data" signal;
 * - `/DSHPID` names the process the installer should wait for (and only that one);
 * - `--force-run` is required for the app to come back: `installSection.nsh` starts the
 *   app after an assisted install only when `${isForceRun} ${andIf} ${Silent}`, and
 *   electron-updater passes the same flag for the same reason (`NsisUpdater.doInstall`).
 *
 * Without `--force-run` a silent update installs and then leaves the user with no
 * running app — verified on a real install, see docs/electron-p3-verification.md.
 */
export function launchInstaller(path: string, pid: number = process.pid): void {
  // `/DSHPID` lets the installer wait for *this* process instead of hunting for anything
  // called `DSH Desktop.exe`. Name-based matching is too broad: a per-user and a per-machine
  // install, or a debug and a release build, share the image name, and killing the wrong one
  // takes down a running app that the install was never meant to touch.
  const child = spawn(path, ['/S', '--updated', '--force-run', `/DSHPID=${String(pid)}`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })
  child.unref()
}
