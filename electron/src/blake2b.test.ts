/**
 * BLAKE2b-512 tests.
 *
 * The implementation exists because Electron's BoringSSL has no BLAKE2b, so it is always
 * compared against OpenSSL here rather than being trusted. Two bugs found while writing it
 * are kept as explicit regression cases: the high half of a 64-bit message word being
 * dropped, and compressing a full buffer early so an exact multiple of the block size ended
 * on a spurious zero block.
 *
 * Run: node --test src/blake2b.test.ts
 */

import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { test } from 'node:test'

import { Blake2b512, blake2b512, blake2b512Chunked } from '../src/blake2b.ts'

/** The reference: OpenSSL, which Node has and Electron does not. */
const reference = (content: Uint8Array): string => createHash('blake2b512').update(content).digest('hex')

const hashed = (content: Uint8Array, chunkSize?: number): string => {
  const hasher = new Blake2b512()
  if (chunkSize === undefined) {
    hasher.update(content)
  } else {
    for (let offset = 0; offset < content.length; offset += chunkSize) {
      hasher.update(content.subarray(offset, Math.min(offset + chunkSize, content.length)))
    }
  }
  return Buffer.from(hasher.digest()).toString('hex')
}

test('RFC 7693 and the published vectors', () => {
  assert.equal(
    hashed(Buffer.alloc(0)),
    '786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce',
  )
  assert.equal(
    hashed(Buffer.from('abc')),
    'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923',
  )
})

test('every length around the block boundary matches OpenSSL', () => {
  const lengths = [
    ...Array.from({ length: 300 }, (_unused, index) => index),
    383, 384, 385, 511, 512, 513, 1023, 1024, 1025, 4095, 4096, 4097, 100_000,
  ]
  for (const length of lengths) {
    const data = randomBytes(length)
    assert.equal(hashed(data), reference(data), `length ${String(length)}`)
  }
})

test('splitting the input across calls does not change the digest', () => {
  // A digest that depends on how the caller chunked its input is not a hash function. This
  // is also the path the app uses: an installer is hashed in 4 MiB chunks.
  const data = randomBytes(4096 + 37)
  const expected = reference(data)
  for (const chunkSize of [1, 7, 63, 64, 65, 127, 128, 129, 1000, 4096, 4097]) {
    assert.equal(hashed(data, chunkSize), expected, `chunk size ${String(chunkSize)}`)
  }
})

test('a byte in the high half of the first word still counts', () => {
  // Regression: the high half of each 64-bit message word was never added, so a 5-byte
  // input hashed as if its fifth byte were zero.
  assert.notEqual(hashed(Buffer.from('aaaaa')), hashed(Buffer.from('aaaa\x00')))
  assert.equal(hashed(Buffer.from('aaaaa')), reference(Buffer.from('aaaaa')))
  assert.equal(hashed(Buffer.from('aaaaaa')), reference(Buffer.from('aaaaaa')))
})

test('an exact multiple of the block size does not end on an extra zero block', () => {
  // Regression: compressing as soon as the buffer filled produced a trailing zero block for
  // a 128-byte input, which is a different digest.
  for (const length of [128, 256, 384, 512]) {
    const data = randomBytes(length)
    assert.equal(hashed(data), reference(data), `single call, length ${String(length)}`)
    assert.equal(hashed(data, 64), reference(data), `two 64-byte calls, length ${String(length)}`)
    assert.equal(hashed(data, 128), reference(data), `128-byte calls, length ${String(length)}`)
  }
})

test('a 20 MiB message with non-zero words everywhere matches OpenSSL', () => {
  const data = randomBytes(20 * 1024 * 1024)
  assert.equal(hashed(data, 4 * 1024 * 1024), reference(data))
})

test('the convenience helper uses a digest the runtime has, and agrees either way', () => {
  const data = randomBytes(1000)
  assert.equal(Buffer.from(blake2b512(data)).toString('hex'), reference(data))
})

test('the chunked helper yields and reports progress', async () => {
  const data = randomBytes(9 * 1024 * 1024)
  const seen: number[] = []
  const digest = await blake2b512Chunked(data, (processed) => { seen.push(processed) })
  assert.equal(Buffer.from(digest).toString('hex'), reference(data))
  // On Node this takes the OpenSSL shortcut and reports once; the JavaScript path reports
  // per chunk. Either way the caller learns the total.
  assert.equal(seen.at(-1), data.length)
})
