#!/usr/bin/env node
/**
 * Fetch the tunnel binary that the installer ships, and prove it is the one we pinned.
 *
 * Phone access over the internet needs `cloudflared`, and the decision recorded in the notes is to
 * **bundle** it rather than download it at runtime: running a third-party executable that was fetched
 * on the user's machine puts the supply-chain risk at the worst possible moment. The cost is paid
 * here, at build time, where a human can look at the result.
 *
 * Two independent checks, because either alone is weak:
 *
 *   1. **SHA-256 against the pin** — proves the bytes are the ones a previous build used.
 *   2. **Authenticode signature** — proves those bytes came from Cloudflare at all, which is the part
 *      a self-recorded hash cannot tell you. (Cloudflare publishes no checksum file for these
 *      releases, so the hash is trust-on-first-use by design and the signature is what makes it
 *      trustworthy.)
 *
 * Usage:
 *   node scripts/prepare-cloudflared.mjs              # fetch if missing, verify always
 *   node scripts/prepare-cloudflared.mjs --update-pin # record the hash of what is downloaded now
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const updatePin = process.argv.includes('--update-pin')
const platform = process.env.DSH_DESKTOP_TARGET_PLATFORM ?? 'win32'
const arch = process.env.DSH_DESKTOP_TARGET_ARCH ?? 'x64'
const key = `${platform}-${arch}`

const pinPath = join(root, 'cloudflared-pin.json')
const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
const artifact = pin.artifacts?.[key]
if (artifact === undefined) fail(`cloudflared-pin.json 没有 ${key} 的条目`)

const outputDir = join(root, 'resources', 'cloudflared')
const target = join(outputDir, platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')

function log(message) {
  process.stdout.write(`[cloudflared] ${message}\n`)
}

function fail(message) {
  process.stderr.write(`[cloudflared] ${message}\n`)
  process.exit(1)
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

/**
 * Ask Windows whether the file carries a valid signature from the expected publisher.
 *
 * @param path - File to check.
 * @returns The signer subject, or undefined when the check cannot run here.
 */
function verifySignature(path) {
  if (platform !== 'win32') return undefined
  let raw
  try {
    raw = execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$s = Get-AuthenticodeSignature -LiteralPath '${path}'; Write-Output ($s.Status.ToString() + '|' + $s.SignerCertificate.Subject)`,
    ], { encoding: 'utf8', windowsHide: true })
  } catch {
    // No PowerShell: the hash check still stands, and the build says so instead of pretending.
    return undefined
  }
  const [status = '', subject = ''] = raw.trim().split('|')
  if (status !== 'Valid') fail(`Authenticode 校验失败：${status}（${path}）`)
  return subject
}

async function download(url, destination) {
  log(`下载 ${url}`)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) fail(`下载失败：HTTP ${String(response.status)}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  writeFileSync(destination, bytes)
  return bytes.length
}

// --- already present: verify and stop ------------------------------------------------------
if (existsSync(target) && !updatePin) {
  const actual = sha256(target)
  if (actual !== artifact.sha256) {
    fail(`随包 cloudflared 的哈希与 pin 不一致（${actual}）；先删除 ${target} 重新准备，或确认是否换了版本`)
  }
  const signer = verifySignature(target)
  log(`已就绪 ${target}（${(statSync(target).size / 1024 / 1024).toFixed(1)} MiB，哈希与 pin 一致${signer === undefined ? '，未做签名校验' : `，签名者 ${signer.split(',')[0] ?? signer}`}）`)
  process.exit(0)
}

// --- fetch ---------------------------------------------------------------------------------
mkdirSync(outputDir, { recursive: true })
const staging = `${target}.download`
try {
  await download(artifact.url, staging)
  const actual = sha256(staging)

  if (updatePin) {
    const bytes = statSync(staging).size
    const signer = verifySignature(staging)
    const updated = {
      ...pin,
      version: artifact.url.match(/download\/([^/]+)\//u)?.[1] ?? pin.version,
      artifacts: { ...pin.artifacts, [key]: { ...artifact, sha256: actual, bytes } },
    }
    writeFileSync(pinPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8')
    log(`pin 已更新：sha256=${actual} bytes=${String(bytes)}${signer === undefined ? '' : ` signer=${signer}`}`)
  } else if (actual !== artifact.sha256) {
    fail(`下载到的 cloudflared 哈希与 pin 不一致：实际 ${actual}，pin ${artifact.sha256}。`
      + '如果这是有意升级版本，更新 cloudflared-pin.json 的 url 后运行 --update-pin 并复核签名者。')
  } else {
    const signer = verifySignature(staging)
    if (signer !== undefined && !signer.includes('Cloudflare')) {
      fail(`下载到的 cloudflared 签名者不是 Cloudflare：${signer}`)
    }
    log(signer === undefined ? '哈希与 pin 一致（未做签名校验：本机没有可用的签名检查）' : `哈希与 pin 一致，签名者 ${signer.split(',')[0] ?? signer}`)
  }

  renameSync(staging, target)
  log(`已就绪 ${target}（${(statSync(target).size / 1024 / 1024).toFixed(1)} MiB）`)
} catch (error) {
  rmSync(staging, { force: true })
  fail(`准备失败：${error instanceof Error ? error.message : String(error)}`)
}
