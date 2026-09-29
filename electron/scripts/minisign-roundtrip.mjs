#!/usr/bin/env node
/**
 * Prove the update-channel bridge end to end, locally, without publishing anything.
 *
 * 1. build a stand-in artifact of realistic size;
 * 2. sign it with the repository's existing Tauri/minisign private key, exactly as the
 *    release script does for the real installer;
 * 3. verify the resulting `.sig` with the shell's own verifier and the public key that
 *    already ships in `tauri.conf.json`;
 * 4. prove a single flipped byte is rejected.
 *
 * Usage: node scripts/minisign-roundtrip.mjs [sizeInMiB]
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { verifyMinisign } from '../src/minisign.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(root, '..')
const sizeMiB = Number(process.argv[2] ?? '8')
const keyPath = resolve(repoRoot, process.env.DSH_DESKTOP_SIGNING_KEY_PATH ?? 'src-tauri/keys/dsh-desktop.key')
const password = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? ''
const conf = JSON.parse(readFileSync(join(repoRoot, 'src-tauri', 'tauri.conf.json'), 'utf8'))
const publicKey = conf.plugins.updater.pubkey

const workDir = mkdtempSync(join(tmpdir(), 'dsh-minisign-'))
const artifactPath = join(workDir, 'DSH Desktop_0.3.0_x64-setup.exe')

try {
  writeFileSync(artifactPath, randomBytes(sizeMiB * 1024 * 1024))
  const artifact = readFileSync(artifactPath)

  process.stdout.write(`artifact: ${String(sizeMiB)} MiB, ${String(artifact.length)} bytes\n`)
  // Call the CLI entry with `node` directly: going through a shell swallows an empty
  // `-p` argument, and an empty password is exactly this key's configuration.
  execFileSync(process.execPath, [join(repoRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'),
    'signer', 'sign', artifactPath], {
    cwd: repoRoot,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      // Only one of the two key sources may be set: clap rejects both together.
      TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyPath, 'utf8'),
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password,
    },
  })

  const signature = readFileSync(`${artifactPath}.sig`, 'utf8').trim()
  const good = await verifyMinisign(artifact, signature, publicKey)

  const tampered = Buffer.from(artifact)
  const lastIndex = tampered.length - 1
  tampered[lastIndex] = (tampered[lastIndex] ?? 0) ^ 0x01
  const bad = await verifyMinisign(tampered, signature, publicKey)

  const verdict = good.ok && bad.ok === false
  process.stdout.write(`${JSON.stringify({
    ok: verdict,
    artifactBytes: artifact.length,
    signatureChars: signature.length,
    signatureIsSingleLine: !signature.includes('\n'),
    verifyGenuine: good,
    verifyTampered: bad,
  }, null, 2)}\n`)
  process.exit(verdict ? 0 : 1)
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
