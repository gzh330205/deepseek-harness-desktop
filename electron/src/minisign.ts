/**
 * Minisign verification against the key already deployed in `src-tauri/tauri.conf.json`.
 *
 * Why this exists: `electron-updater` on Windows verifies the downloaded installer
 * with Authenticode against `publisherName` from `app-update.yml`, and returns early
 * when that field is absent. Without a code-signing certificate the field is absent,
 * so electron-updater performs **no** integrity check at all. Reusing the minisign
 * key pair the Tauri shell already published keeps a real trust root without buying
 * a certificate, and lets one manifest serve both generations of the app.
 *
 * Formats, as produced by `tauri signer sign`:
 * - the `.sig` file / `latest.json` `signature` field: base64 of a four-line minisign
 *   signature file;
 * - the public key field: base64 of the two-line minisign public key file.
 *
 * A signature block is `alg(2) || keyId(8) || signature(64)`. `Ed` signs the file
 * bytes; `ED` signs the BLAKE2b-512 digest first — Tauri emits `ED`.
 */

import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto'

import { blake2b512Chunked } from './blake2b.ts'

/** SPKI prefix for a raw Ed25519 public key. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

export interface MinisignPublicKey {
  readonly keyId: string
  readonly key: KeyObject
}

/** Options for {@link verifyMinisign}. */
export interface MinisignOptions {
  /** Called with the number of bytes hashed so far; only the prehashed `ED` path hashes. */
  readonly onProgress?: (processed: number, total: number) => void
  /** Digest implementation; tests inject the JavaScript BLAKE2b-512 the app has to use. */
  readonly digest?: (content: Buffer, onProgress?: (processed: number, total: number) => void) => Promise<Uint8Array>
}

export type MinisignResult = { readonly ok: true } | { readonly ok: false; readonly reason: string }

function decodeBase64(text: string, what: string): Buffer | string {
  const compact = text.trim()
  if (compact === '') return `${what} 为空`
  const buffer = Buffer.from(compact, 'base64')
  if (buffer.length === 0) return `${what} 不是合法 base64`
  return buffer
}

/** Lines of a decoded minisign text block, ignoring blanks. */
function blockLines(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(line => line !== '')
}

/**
 * Decode the public key field from `tauri.conf.json`.
 *
 * Accepts both shapes in the wild: the base64 of the whole two-line key file (what
 * this repository ships) and the bare base64 key blob.
 */
export function decodePublicKey(publicKeyField: string): MinisignPublicKey | string {
  const decoded = decodeBase64(publicKeyField, '公钥字段')
  if (typeof decoded === 'string') return decoded
  let blob: Buffer | undefined
  const asText = decoded.toString('utf8')
  if (asText.includes('untrusted comment')) {
    const line = blockLines(asText)[1]
    if (line === undefined) return '公钥文件缺少 key 行'
    const inner = decodeBase64(line, '公钥行')
    if (typeof inner === 'string') return inner
    blob = inner
  } else {
    blob = decoded
  }
  if (blob.length !== 42) return `公钥长度异常：${String(blob.length)}（期望 42）`
  const algorithm = blob.subarray(0, 2).toString('ascii')
  if (algorithm !== 'Ed') return `公钥算法不支持：${algorithm}`
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, blob.subarray(10, 42)]),
    format: 'der',
    type: 'spki',
  })
  return { keyId: blob.subarray(2, 10).toString('hex'), key }
}

/**
 * Verify one artifact against one signature.
 *
 * @param content - Exact bytes the client downloaded.
 * @param signatureField - `signature` from the manifest, or the contents of a `.sig`.
 * @param publicKeyField - `plugins.updater.pubkey` from `tauri.conf.json`.
 * @param options - Progress reporting, and an injected digest for tests.
 */
export async function verifyMinisign(
  content: Buffer,
  signatureField: string,
  publicKeyField: string,
  options: MinisignOptions = {},
): Promise<MinisignResult> {
  const publicKey = decodePublicKey(publicKeyField)
  if (typeof publicKey === 'string') return { ok: false, reason: publicKey }

  const decodedSignature = decodeBase64(signatureField, '签名字段')
  if (typeof decodedSignature === 'string') return { ok: false, reason: decodedSignature }

  const signatureText = decodedSignature.toString('utf8')
  const lines = blockLines(signatureText)
  // A minisign signature file is: untrusted comment, signature, trusted comment, global signature.
  if (lines.length < 2) return { ok: false, reason: '签名块缺少签名行' }
  const blobText = lines[1]
  if (blobText === undefined) return { ok: false, reason: '签名块缺少签名行' }
  const blob = Buffer.from(blobText, 'base64')
  if (blob.length !== 74) return { ok: false, reason: `签名长度异常：${String(blob.length)}（期望 74）` }

  const algorithm = blob.subarray(0, 2).toString('ascii')
  const keyId = blob.subarray(2, 10).toString('hex')
  if (keyId !== publicKey.keyId) {
    return { ok: false, reason: `签名 keyId ${keyId} 与公钥 ${publicKey.keyId} 不匹配` }
  }

  let message: Buffer
  // `ED` covers BLAKE2b-512 of the file, and the app's runtime (BoringSSL) has no BLAKE2b —
  // see blake2b.ts. The digest is injectable so tests can force the JavaScript path that
  // Electron actually uses, rather than the one Node happens to have.
  if (algorithm === 'ED') {
    const digest = options.digest
    const bytes = digest === undefined
      ? await blake2b512Chunked(content, (processed) => { options.onProgress?.(processed, content.length) })
      : await digest(content, options.onProgress)
    message = Buffer.from(bytes)
  }
  else if (algorithm === 'Ed') message = content
  else return { ok: false, reason: `签名算法不支持：${algorithm}` }

  const signature = blob.subarray(10, 74)
  const valid = verifySignature(null, message, publicKey.key, signature)
  return valid ? { ok: true } : { ok: false, reason: '签名校验失败：内容与签名不匹配' }
}
