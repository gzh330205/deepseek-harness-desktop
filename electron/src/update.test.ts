/**
 * Update-channel tests.
 *
 * The manifest shape is shared with the Tauri clients, so parsing is pinned here, and
 * the verification step is exercised against the real signature fixture: a manifest
 * signature must gate the file that actually landed on disk.
 *
 * Run: node --test src/update.test.ts
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

import { downloadInstaller, fetchManifest, installerFileName, isNewer, verifyInstaller } from '../src/update.ts'

const fixture = (name: string): Buffer => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)))
const conf = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../src-tauri/tauri.conf.json', import.meta.url)), 'utf8'),
) as { plugins: { updater: { pubkey: string } } }
const publicKey = conf.plugins.updater.pubkey
const signature = fixture('artifact.txt.sig').toString('utf8')

const workDir = mkdtempSync(join(tmpdir(), 'dsh-update-test-'))
after(() => { rmSync(workDir, { recursive: true, force: true }) })

/** Serve bytes on loopback so the download path is exercised for real. */
async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.notEqual(address, null)
  const port = typeof address === 'object' && address !== null ? address.port : 0
  try {
    await run(`http://127.0.0.1:${String(port)}`)
  } finally {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
}

test('client versions only move forward', () => {
  assert.equal(isNewer('0.3.0', '0.2.26'), true)
  assert.equal(isNewer('0.2.26', '0.2.26'), false)
  assert.equal(isNewer('0.2.26', '0.3.0'), false)
  assert.equal(isNewer('0.3.0-rc.1', '0.3.0'), false)
})

test('installer file name matches the electron-builder artifact name', () => {
  assert.equal(installerFileName('0.3.0'), 'DSH.Desktop_0.3.0_x64-setup.exe')
})

test('the manifest is parsed with unknown fields ignored', async () => {
  await withServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({
      version: '0.3.1',
      notes: 'https://example.invalid/notes',
      pub_date: '2026-09-28T00:00:00Z',
      platforms: { 'windows-x86_64': { signature, url: 'https://example.invalid/setup.exe' } },
      // A future field must not break the older clients or this parser.
      shell: { minimum: '0.3.0' },
    }))
  }, async (origin) => {
    const manifest = await fetchManifest(`${origin}/latest.json`)
    assert.equal(manifest.version, '0.3.1')
    assert.equal(manifest.entry.signature, signature)
    assert.equal(isNewer(manifest.version, '0.3.0'), true)
  })
})

test('a malformed manifest is rejected before anything is downloaded', async () => {
  await withServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ version: '0.3.1', platforms: {} }))
  }, async (origin) => {
    await assert.rejects(() => fetchManifest(`${origin}/latest.json`), /windows-x86_64/u)
  })
  await withServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({
      version: '0.3.1',
      platforms: { 'windows-x86_64': { signature, url: 'http://insecure.invalid/x.exe' } },
    }))
  }, async (origin) => {
    await assert.rejects(() => fetchManifest(`${origin}/latest.json`), /https/u)
  })
})

test('a download is streamed to disk and can be verified byte for byte', async () => {
  const artifact = fixture('artifact.txt')
  await withServer((_request, response) => {
    response.setHeader('content-length', String(artifact.length))
    response.end(artifact)
  }, async (origin) => {
    const destination = join(workDir, 'downloaded.exe')
    const sizes: number[] = []
    await downloadInstaller(`${origin}/setup.exe`, destination, ({ received }) => { sizes.push(received) })
    assert.deepEqual(readFileSync(destination), artifact)
    assert.ok(sizes.length > 0, 'progress must be reported')
    assert.deepEqual(await verifyInstaller(destination, signature, publicKey), { ok: true })
  })
})

test('a truncated download is rejected instead of being installed', async () => {
  const artifact = fixture('artifact.txt')
  await withServer((_request, response) => {
    // Promise a longer body than is sent.
    response.setHeader('content-length', String(artifact.length + 10))
    response.end(artifact)
  }, async (origin) => {
    const destination = join(workDir, 'truncated.exe')
    // Either our own length check or the transport itself must fail the download;
    // what matters is that it never resolves as a usable installer.
    await assert.rejects(
      () => downloadInstaller(`${origin}/setup.exe`, destination, () => {}),
      /不完整|terminated|other side closed/u,
    )
  })
})

test('a file that does not match the manifest signature is rejected', async () => {
  const tampered = join(workDir, 'tampered.exe')
  copyFileSync(fileURLToPath(new URL('./fixtures/artifact.txt', import.meta.url)), tampered)
  writeFileSync(tampered, Buffer.concat([readFileSync(tampered), Buffer.from('!')]))
  const result = await verifyInstaller(tampered, signature, publicKey)
  assert.equal(result.ok, false)

  const empty = join(workDir, 'empty.exe')
  writeFileSync(empty, Buffer.alloc(0))
  assert.equal((await verifyInstaller(empty, signature, publicKey)).ok, false)
})
