/**
 * BLAKE2b-512, because the app's runtime does not ship it.
 *
 * minisign's `ED` (prehashed) signatures — which is what Tauri's signer produces — cover
 * BLAKE2b-512 of the file. Node can hash that through OpenSSL, but Electron ships BoringSSL,
 * where `crypto.createHash('blake2b512')` throws `Digest method not supported`:
 *
 *   node -e "require('node:crypto').createHash('blake2b512')"                        -> works
 *   ELECTRON_RUN_AS_NODE=1 electron -e "require('node:crypto').createHash('blake2b512')" -> throws
 *
 * Relying on OpenSSL meant the *app* could never verify a downloaded installer, so every
 * update failed with `Digest method not supported`. The scripts and unit tests all ran on
 * Node, which has the digest, so nothing caught it.
 *
 * Correctness is pinned by tests that compare this implementation against OpenSSL over
 * random inputs, every length around the 128-byte block boundary, and the RFC 7693 vectors.
 */

import { createHash } from 'node:crypto'

/** BLAKE2b IV: the SHA-512 constants, stored as (low, high) pairs per 64-bit word. */
const IV = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
])

/** Message schedule, 12 rounds of 16 indices (RFC 7693). */
const SIGMA = new Uint8Array([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
  11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4,
  7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8,
  9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13,
  2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9,
  12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11,
  13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10,
  6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5,
  10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
])

const BLOCK = 128

/** 64-bit state is kept as (low, high) pairs: `v[2i]`, `v[2i + 1]`. */
type State = Uint32Array

/**
 * The BLAKE2b mixing function, with the four fixed rotation amounts inlined.
 *
 * @param v - Working state, 32 words (16 pairs).
 * @param m - Message words, 32 words (16 pairs).
 * @param a - Index of the first of the four 64-bit words, in pairs.
 */
function mix(v: State, m: State, a: number, b: number, c: number, d: number, x: number, y: number): void {
  const al = 2 * a
  const bl = 2 * b
  const cl = 2 * c
  const dl = 2 * d
  const xl = 2 * x
  const yl = 2 * y

  // a = a + b + x. A message word is 64 bits, so its high half counts too: dropping it
  // silently zeroes every fourth byte onwards (`'aaaaa'` hashed as `'aaaa\0'`).
  let sum = v[al]! + v[bl]! + m[xl]!
  v[al] = sum >>> 0
  v[al + 1] = (v[al + 1]! + v[bl + 1]! + m[xl + 1]! + Math.floor(sum / 4294967296)) >>> 0
  // d = rotr64(d ^ a, 32): a plain swap of the halves.
  let lo = (v[dl]! ^ v[al]!) >>> 0
  let hi = (v[dl + 1]! ^ v[al + 1]!) >>> 0
  v[dl] = hi
  v[dl + 1] = lo

  // c = c + d
  sum = v[cl]! + v[dl]!
  v[cl] = sum >>> 0
  v[cl + 1] = (v[cl + 1]! + v[dl + 1]! + Math.floor(sum / 4294967296)) >>> 0
  // b = rotr64(b ^ c, 24)
  lo = (v[bl]! ^ v[cl]!) >>> 0
  hi = (v[bl + 1]! ^ v[cl + 1]!) >>> 0
  v[bl] = ((lo >>> 24) | (hi << 8)) >>> 0
  v[bl + 1] = ((hi >>> 24) | (lo << 8)) >>> 0

  // a = a + b + y
  sum = v[al]! + v[bl]! + m[yl]!
  v[al] = sum >>> 0
  v[al + 1] = (v[al + 1]! + v[bl + 1]! + m[yl + 1]! + Math.floor(sum / 4294967296)) >>> 0
  // d = rotr64(d ^ a, 16)
  lo = (v[dl]! ^ v[al]!) >>> 0
  hi = (v[dl + 1]! ^ v[al + 1]!) >>> 0
  v[dl] = ((lo >>> 16) | (hi << 16)) >>> 0
  v[dl + 1] = ((hi >>> 16) | (lo << 16)) >>> 0

  // c = c + d
  sum = v[cl]! + v[dl]!
  v[cl] = sum >>> 0
  v[cl + 1] = (v[cl + 1]! + v[dl + 1]! + Math.floor(sum / 4294967296)) >>> 0
  // b = rotr64(b ^ c, 63), which is a rotate *left* by one.
  lo = (v[bl]! ^ v[cl]!) >>> 0
  hi = (v[bl + 1]! ^ v[cl + 1]!) >>> 0
  v[bl] = ((lo << 1) | (hi >>> 31)) >>> 0
  v[bl + 1] = ((hi << 1) | (lo >>> 31)) >>> 0
}

/** Incremental BLAKE2b-512 over unkeyed input. */
export class Blake2b512 {
  private readonly h: State
  private readonly v: State
  private readonly m: State
  private readonly block = new Uint8Array(BLOCK)
  private blockLength = 0
  private readonly counter = new Uint32Array(2)

  constructor() {
    this.h = new Uint32Array(IV)
    // Parameter block word 0: digest length 64, no key, fanout 1, depth 1.
    this.h[0] = (this.h[0]! ^ 0x0101_0040) >>> 0
    this.v = new Uint32Array(32)
    this.m = new Uint32Array(32)
  }

  /** Absorb bytes. Splitting a message across calls is equivalent to one call. */
  update(data: Uint8Array): this {
    let offset = 0
    if (this.blockLength > 0 && data.length > 0) {
      const take = Math.min(BLOCK - this.blockLength, data.length)
      this.block.set(data.subarray(0, take), this.blockLength)
      this.blockLength += take
      offset = take
      // Only compress once more input follows. Compressing the moment the buffer fills
      // would make a message whose length is an exact multiple of the block size end on a
      // spurious zero block, which is a different digest (found by feeding 64-byte chunks).
      if (this.blockLength === BLOCK && data.length > offset) {
        this.count(BLOCK)
        this.compress(this.block, 0, false)
        this.blockLength = 0
      }
    }
    // Strictly greater: the last full block must stay buffered, because a final block is
    // compressed with the "last block" flag.
    while (data.length - offset > BLOCK) {
      this.count(BLOCK)
      this.compress(data, offset, false)
      offset += BLOCK
    }
    if (data.length - offset > 0) {
      this.block.set(data.subarray(offset), 0)
      this.blockLength = data.length - offset
    }
    return this
  }

  /** Finish and return the 64-byte digest. The instance must not be reused afterwards. */
  digest(): Uint8Array {
    this.count(this.blockLength)
    this.block.fill(0, this.blockLength)
    this.compress(this.block, 0, true)
    const out = new Uint8Array(64)
    for (let i = 0; i < 16; i++) {
      const word = this.h[i]!
      out[i * 4] = word & 0xff
      out[i * 4 + 1] = (word >>> 8) & 0xff
      out[i * 4 + 2] = (word >>> 16) & 0xff
      out[i * 4 + 3] = (word >>> 24) & 0xff
    }
    return out
  }

  /** The byte counter is 128-bit; two words cover any installer. */
  private count(bytes: number): void {
    const low = (this.counter[0]! + bytes) >>> 0
    if (low < this.counter[0]!) this.counter[1] = (this.counter[1]! + 1) >>> 0
    this.counter[0] = low
  }

  /**
   * Compress one 128-byte block into the state.
   *
   * @param source - Array holding the block; full blocks are compressed straight out of the
   * caller's buffer, so this is not always `this.block`.
   * @param offset - Where the block starts in `source`.
   * @param last - Whether this is the final block.
   */
  private compress(source: Uint8Array, offset: number, last: boolean): void {
    const m = this.m
    for (let i = 0; i < 32; i++) {
      const at = offset + i * 4
      m[i] = (source[at]! | (source[at + 1]! << 8) | (source[at + 2]! << 16) | (source[at + 3]! << 24)) >>> 0
    }

    const v = this.v
    v.set(this.h, 0)
    v.set(IV, 16)
    v[24] = (v[24]! ^ this.counter[0]!) >>> 0
    v[25] = (v[25]! ^ this.counter[1]!) >>> 0
    if (last) {
      v[28] = ~v[28]! >>> 0
      v[29] = ~v[29]! >>> 0
    }

    for (let round = 0; round < 12; round++) {
      const s = round * 16
      mix(v, m, 0, 4, 8, 12, SIGMA[s]!, SIGMA[s + 1]!)
      mix(v, m, 1, 5, 9, 13, SIGMA[s + 2]!, SIGMA[s + 3]!)
      mix(v, m, 2, 6, 10, 14, SIGMA[s + 4]!, SIGMA[s + 5]!)
      mix(v, m, 3, 7, 11, 15, SIGMA[s + 6]!, SIGMA[s + 7]!)
      mix(v, m, 0, 5, 10, 15, SIGMA[s + 8]!, SIGMA[s + 9]!)
      mix(v, m, 1, 6, 11, 12, SIGMA[s + 10]!, SIGMA[s + 11]!)
      mix(v, m, 2, 7, 8, 13, SIGMA[s + 12]!, SIGMA[s + 13]!)
      mix(v, m, 3, 4, 9, 14, SIGMA[s + 14]!, SIGMA[s + 15]!)
    }

    for (let i = 0; i < 16; i++) {
      this.h[i] = (this.h[i]! ^ v[i]! ^ v[i + 16]!) >>> 0
    }
  }
}

/**
 * BLAKE2b-512 of `content`.
 *
 * Uses the runtime's own digest when it has one (Node/OpenSSL, and the release scripts), and
 * this implementation when it does not (Electron/BoringSSL).
 *
 * @param content - Bytes to hash.
 */
export function blake2b512(content: Uint8Array): Uint8Array {
  try {
    return createHash('blake2b512').update(content).digest()
  } catch {
    const hasher = new Blake2b512()
    hasher.update(content)
    return hasher.digest()
  }
}

/** Chunk size for the fallback path: big enough to be fast, small enough to yield often. */
const CHUNK_BYTES = 4 * 1024 * 1024

/**
 * BLAKE2b-512 without blocking the event loop for the whole file.
 *
 * An installer is ~190 MB. When the runtime has BLAKE2b this is a single fast call; when it
 * does not, the JavaScript implementation would otherwise freeze the window (and the update
 * progress bar) for several seconds, so it yields between chunks.
 *
 * @param content - Bytes to hash.
 * @param onProgress - Called with the number of bytes hashed so far.
 */
export async function blake2b512Chunked(
  content: Uint8Array,
  onProgress?: (processed: number) => void,
): Promise<Uint8Array> {
  try {
    const digest = createHash('blake2b512').update(content).digest()
    onProgress?.(content.length)
    return digest
  } catch {
    // BoringSSL: no BLAKE2b.
  }
  const hasher = new Blake2b512()
  for (let offset = 0; offset < content.length; offset += CHUNK_BYTES) {
    const end = Math.min(offset + CHUNK_BYTES, content.length)
    hasher.update(content.subarray(offset, end))
    onProgress?.(end)
    await new Promise<void>((resolve) => { setImmediate(resolve) })
  }
  return hasher.digest()
}
