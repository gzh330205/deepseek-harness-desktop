/**
 * Unit tests for the two pure output helpers.
 *
 * The ordering rule they encode is not cosmetic: the Tauri shell once shipped a
 * release (0.2.29) where redaction ran before parsing, so the webview was handed
 * `?token=***` and the user landed on a 401 page. These tests exist so the Electron
 * shell cannot repeat it.
 *
 * Run: node --test src/dsh-output.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { bareUrl, parseDshWebAuthUrl, redactAuthToken } from '../src/dsh-output.ts'

test('redaction keeps the rest of the line with its delimiters', () => {
  assert.equal(
    redactAuthToken('dsh web: http://127.0.0.1:41729/?token=SECRET-VALUE extra'),
    'dsh web: http://127.0.0.1:41729/?token=*** extra',
  )
  assert.equal(redactAuthToken('GET /?token=SECRET&foo=1'), 'GET /?token=***&foo=1')
  assert.equal(redactAuthToken('no token here'), 'no token here')
})

test('parsing rejects the redacted placeholder that redaction produces', () => {
  const line = 'dsh web: http://127.0.0.1:41729/?token=REAL-TOKEN'
  assert.equal(parseDshWebAuthUrl(redactAuthToken(line)), undefined)
  assert.equal(parseDshWebAuthUrl(line)?.searchParams.get('token'), 'REAL-TOKEN')
})

test('parsing only accepts loopback urls with a usable token', () => {
  assert.equal(parseDshWebAuthUrl('http://example.com/?token=x'), undefined)
  assert.equal(parseDshWebAuthUrl('http://127.0.0.1:41729/'), undefined)
  assert.equal(parseDshWebAuthUrl('not a url'), undefined)
  assert.equal(parseDshWebAuthUrl('http://[::1]:41729/?token=x')?.hostname, '[::1]')
})

test('bare address is the same route without the credential', () => {
  const url = new URL('http://127.0.0.1:41729/?token=abc&keep=1')
  assert.equal(bareUrl(url), 'http://127.0.0.1:41729/?keep=1')
  assert.equal(bareUrl(new URL('http://127.0.0.1:41729/?token=abc')), 'http://127.0.0.1:41729/')
})
