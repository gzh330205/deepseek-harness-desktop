#!/usr/bin/env node
/**
 * Publish-time acceptance: download the *published* artifact through the manifest's own
 * URL and verify it with the public key the app ships.
 *
 * This is the only check that catches the classic GitHub failure mode where the
 * uploaded asset name and the manifest URL disagree (spaces become dots on upload) and
 * every client 404s. It also proves the published bytes still carry the signature we
 * generated locally.
 *
 * Usage: node scripts/verify-published.mjs [manifestUrl]
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { verifyMinisign } from '../src/minisign.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(root, '..')
const manifestUrl = process.argv[2]
  ?? 'https://github.com/gzh330205/deepseek-harness-desktop/releases/latest/download/latest.json'
const publicKey = JSON.parse(readFileSync(join(repoRoot, 'src-tauri', 'tauri.conf.json'), 'utf8')).plugins.updater.pubkey

const workDir = mkdtempSync(join(tmpdir(), 'dsh-verify-published-'))
try {
  process.stdout.write(`清单：${manifestUrl}\n`)
  const response = await fetch(manifestUrl, { redirect: 'follow' })
  if (!response.ok) throw new Error(`清单请求失败：HTTP ${String(response.status)}`)
  const manifest = await response.json()
  const entry = manifest.platforms['windows-x86_64']
  if (entry === undefined) throw new Error('清单缺少 windows-x86_64')
  process.stdout.write(`版本：${manifest.version}\n产物：${entry.url}\n`)

  const destination = join(workDir, basename(new URL(entry.url).pathname))
  // curl is used when available: it honours the environment proxy, and Node's fetch
  // does not.
  let downloaded = false
  try {
    execFileSync('curl', ['-sSL', '--fail', '-o', destination, entry.url], { stdio: ['ignore', 'ignore', 'inherit'] })
    downloaded = existsSync(destination)
  } catch {
    downloaded = false
  }
  if (!downloaded) {
    process.stdout.write('（curl 不可用，改用 fetch 下载）\n')
    const artifact = await fetch(entry.url, { redirect: 'follow' })
    if (!artifact.ok) throw new Error(`产物请求失败：HTTP ${String(artifact.status)}`)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(destination, Buffer.from(await artifact.arrayBuffer()))
  }

  const size = statSync(destination).size
  process.stdout.write(`已下载：${(size / 1024 / 1024).toFixed(1)} MiB\n`)
  const result = await verifyMinisign(readFileSync(destination), entry.signature, publicKey)
  process.stdout.write(`${JSON.stringify({ ok: result.ok, version: manifest.version, bytes: size, url: entry.url, reason: result.ok ? undefined : result.reason }, null, 2)}\n`)
  process.exit(result.ok ? 0 : 1)
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
