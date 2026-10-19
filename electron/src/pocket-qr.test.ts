import assert from 'node:assert/strict'
import { test } from 'node:test'

// An independent decoder, used only in tests: "the QR code does not scan" is the one failure a user
// cannot work around, and the only way to catch it before shipping is to decode what we render.
import jsQR from 'jsqr'

import { pocketConnectLink, pocketQrDataUrl, pocketQrMatrix } from './pocket-qr.ts'

/**
 * `jsqr` ships as CommonJS, so NodeNext types the import as the module namespace while the runtime
 * value is the function itself. The tests below are what proves which one decodes.
 */
const decodeImage = jsQR as unknown as (
  data: Uint8ClampedArray,
  width: number,
  height: number,
) => { readonly data: string } | null

/** Rasterise the module matrix the way the settings page displays it, then decode it back. */
function decode(url: string): string | undefined {
  const { count, dark } = pocketQrMatrix(url)
  const cell = 8
  const margin = 4 * cell
  const size = count * cell + margin * 2
  const pixels = new Uint8ClampedArray(size * size * 4)
  // White background, then dark modules; jsQR wants RGBA.
  for (let index = 0; index < size * size; index += 1) {
    pixels[index * 4] = 255
    pixels[index * 4 + 1] = 255
    pixels[index * 4 + 2] = 255
    pixels[index * 4 + 3] = 255
  }
  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      if (!dark(row, column)) continue
      for (let y = 0; y < cell; y += 1) {
        for (let x = 0; x < cell; x += 1) {
          const at = ((margin + row * cell + y) * size + (margin + column * cell + x)) * 4
          pixels[at] = 0
          pixels[at + 1] = 0
          pixels[at + 2] = 0
        }
      }
    }
  }
  return decodeImage(pixels, size, size)?.data
}

test('what the settings page shows decodes back to the exact address', () => {
  for (const url of [
    'http://192.168.1.7:41730/',
    'http://10.0.0.9:41730/',
    // A named tunnel is a hostname rather than an address, so the payload is shorter and the code
    // smaller — both shapes have to survive the encoder.
    'https://pocket.example.com/',
    'http://172.20.0.1:41730/?next=%2Fapi%2Fstate',
  ]) {
    assert.equal(decode(url), url, url)
  }
})

test('the rendered image is a self-contained data URL', () => {
  const dataUrl = pocketQrDataUrl('http://192.168.1.7:41730/')
  assert.match(dataUrl, /^data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+$/u)
  // Identical input, identical image: the settings page re-renders on every refresh and a code that
  // changed each time would look like the target had moved.
  assert.equal(pocketQrDataUrl('http://192.168.1.7:41730/'), dataUrl)
  assert.notEqual(pocketQrDataUrl('http://192.168.1.7:41731/'), dataUrl)
})

test('a connect link carries the address and the password, percent-encoded', () => {
  assert.equal(
    pocketConnectLink('http://192.168.1.7:41730/', 'Abcd1234'),
    'dshpocket://connect?url=http%3A%2F%2F192.168.1.7%3A41730%2F&password=Abcd1234',
  )
  // IPv6 literals: brackets and colons must not survive as raw query syntax.
  assert.equal(
    pocketConnectLink('http://[fe80::1]:41730/', 'Abcd1234'),
    'dshpocket://connect?url=http%3A%2F%2F%5Bfe80%3A%3A1%5D%3A41730%2F&password=Abcd1234',
  )
  // A password with `&` or `=` would split the query if it were not encoded; so would a space.
  assert.equal(
    pocketConnectLink('http://10.0.0.5:41730/', 'a&b=c d'),
    'dshpocket://connect?url=http%3A%2F%2F10.0.0.5%3A41730%2F&password=a%26b%3Dc%20d',
  )
  // The tunnel hostname shape the public door uses.
  assert.equal(
    pocketConnectLink('https://pocket.example.com:443/', 'Gen00001'),
    'dshpocket://connect?url=https%3A%2F%2Fpocket.example.com%3A443%2F&password=Gen00001',
  )
})

test('a connect link without a password leaves the parameter out', () => {
  const url = 'https://pocket.example.com/'
  assert.equal(pocketConnectLink(url), `dshpocket://connect?url=${encodeURIComponent(url)}`)
  assert.equal(pocketConnectLink(url, ''), pocketConnectLink(url))
  // The two shapes stay distinguishable on the wire.
  assert.notEqual(pocketConnectLink(url, 'Abcd1234'), pocketConnectLink(url))
})

test('the deep link survives a QR round trip', () => {
  for (const link of [
    pocketConnectLink('http://192.168.1.7:41730/', 'Abcd1234'),
    pocketConnectLink('http://[fe80::1]:41730/', 'Gen00001'),
    pocketConnectLink('https://pocket.example.com:443/', 'a&b=c'),
    pocketConnectLink('https://random-words-here.trycloudflare.com/'),
  ]) {
    assert.equal(decode(link), link)
  }
})
