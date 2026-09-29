/**
 * Minisign verification tests, using a real signature produced by
 * `tauri signer sign` with this repository's own key over
 * `fixtures/artifact.txt`. Nothing here is secret: the signature verifies against the
 * public key that already ships in `src-tauri/tauri.conf.json`.
 *
 * Run: node --test src/minisign.test.ts
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { Blake2b512 } from '../src/blake2b.ts'
import { decodePublicKey, verifyMinisign } from '../src/minisign.ts'

/**
 * The digest Electron actually uses: BoringSSL has no BLAKE2b, so the app always falls back
 * to the JavaScript implementation. Node does have it, which is exactly why the fallback
 * needs to be forced here instead of being taken for granted.
 */
const javaScriptDigest = async (content: Buffer): Promise<Uint8Array> => {
  const hasher = new Blake2b512()
  hasher.update(content)
  return hasher.digest()
}

const fixture = (name: string): Buffer => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)))
const conf = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../src-tauri/tauri.conf.json', import.meta.url)), 'utf8'),
) as { plugins: { updater: { pubkey: string } } }

const publicKey = conf.plugins.updater.pubkey
const artifact = fixture('artifact.txt')
const signature = fixture('artifact.txt.sig').toString('utf8')

test('the shipped public key decodes to a 42-byte Ed25519 key', () => {
  const decoded = decodePublicKey(publicKey)
  assert.notEqual(typeof decoded, 'string')
  if (typeof decoded === 'string') return
  assert.equal(decoded.keyId, '2224c5c18b99b908')
})

test('a signature made with this key verifies against the shipped key', async () => {
  assert.deepEqual(await verifyMinisign(artifact, signature, publicKey), { ok: true })
})

test('it still verifies when the runtime has no BLAKE2b (Electron/BoringSSL)', async () => {
  // The bug this guards: verification used `crypto.createHash('blake2b512')`, which works on
  // Node and throws "Digest method not supported" on Electron — so the app could never
  // verify a downloaded installer, and every update failed.
  const result = await verifyMinisign(artifact, signature, publicKey, { digest: javaScriptDigest })
  assert.deepEqual(result, { ok: true })
})

test('the fallback digest still rejects a tampered artifact', async () => {
  const tampered = Buffer.from(artifact)
  tampered[0] = (tampered[0] ?? 0) ^ 0x01
  const result = await verifyMinisign(tampered, signature, publicKey, { digest: javaScriptDigest })
  assert.equal(result.ok, false)
})

test('a tampered artifact fails', async () => {
  const tampered = Buffer.from(artifact)
  tampered[0] = (tampered[0] ?? 0) ^ 0x01
  const result = await verifyMinisign(tampered, signature, publicKey)
  assert.equal(result.ok, false)
})

test('a signature from another key is rejected by key id', async () => {
  // Same algorithm and length, different key id.
  const blob = Buffer.from(Buffer.from(signature.trim(), 'base64').toString('utf8').split('\n')[1] ?? '', 'base64')
  const forged = Buffer.from(blob)
  forged.write('deadbeefdeadbeef', 2, 'hex')
  const lines = Buffer.from(signature.trim(), 'base64').toString('utf8').split('\n')
  lines[1] = forged.toString('base64')
  const forgedSignature = Buffer.from(lines.join('\n'), 'utf8').toString('base64')
  const result = await verifyMinisign(artifact, forgedSignature, publicKey)
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.reason : '', /keyId/u)
})

test('malformed input is reported, never thrown', async () => {
  assert.equal((await verifyMinisign(artifact, '', publicKey)).ok, false)
  assert.equal((await verifyMinisign(artifact, 'not base64 !!!', publicKey)).ok, false)
  assert.equal((await verifyMinisign(artifact, signature, '')).ok, false)
  assert.equal((await verifyMinisign(artifact, signature, Buffer.from('short').toString('base64'))).ok, false)
})
