import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  POCKET_PASSWORD_ALPHABET,
  POCKET_PASSWORD_LENGTH,
  constantTimeEqual,
  createPocketRateLimiter,
  createPocketSessions,
  generatePocketPassword,
  readCookie,
  validatePocketPassword,
} from './pocket-auth.ts'

test('a generated password only uses characters that cannot be misread', () => {
  const password = generatePocketPassword()
  assert.equal(password.length, POCKET_PASSWORD_LENGTH)
  for (const character of password) {
    assert.ok(POCKET_PASSWORD_ALPHABET.includes(character), `${character} 不在字母表里`)
    // The alphabet is the whole point: 0/O and 1/l/I are the pairs people mistype off a screen.
    assert.ok(!'0O1lI'.includes(character), `${character} 是有歧义的字符`)
  }
})

test('the byte source decides the password, so the generator is testable', () => {
  const bytes = Buffer.alloc(POCKET_PASSWORD_LENGTH)
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index
  const password = generatePocketPassword(() => bytes)
  const expected = [...bytes].map(byte => POCKET_PASSWORD_ALPHABET[byte % POCKET_PASSWORD_ALPHABET.length]).join('')
  assert.equal(password, expected)
})

test('a password has to be long enough, short enough and alphanumeric', () => {
  assert.equal(validatePocketPassword('Abcd1234'), undefined)
  assert.match(String(validatePocketPassword('Abc123')), /长度/u)
  assert.match(String(validatePocketPassword('a'.repeat(65))), /长度/u)
  assert.match(String(validatePocketPassword('abcd-1234')), /字母和数字/u)
})

test('a password of only digits or only letters is accepted, because length carries the entropy', () => {
  // Documented on purpose: refusing these would push users toward shorter, "clever" passwords.
  assert.equal(validatePocketPassword('12345678'), undefined)
  assert.equal(validatePocketPassword('abcdefgh'), undefined)
})

test('secrets compare equal regardless of content, including at different lengths', () => {
  assert.equal(constantTimeEqual('abcd1234', 'abcd1234'), true)
  assert.equal(constantTimeEqual('abcd1234', 'abcd1235'), false)
  assert.equal(constantTimeEqual('abcd1234', 'abcd12345'), false)
  assert.equal(constantTimeEqual('', ''), true)
})

test('five wrong passwords lock that client for a minute', () => {
  let clock = 1_000
  const limiter = createPocketRateLimiter({ now: () => clock })
  for (let attempt = 0; attempt < 4; attempt += 1) {
    assert.equal(limiter.check('10.0.0.9').allowed, true)
    limiter.fail('10.0.0.9')
  }
  assert.equal(limiter.check('10.0.0.9').allowed, true, '第 4 次失败后还没到阈值')
  limiter.fail('10.0.0.9')

  const locked = limiter.check('10.0.0.9')
  assert.equal(locked.allowed, false)
  assert.equal(locked.reason, 'ip')
  assert.equal(locked.retryAfterSeconds, 60)

  // Another client is unaffected: locking everyone out on one attacker is how a gateway
  // becomes a denial-of-service against its own owner.
  assert.equal(limiter.check('10.0.0.10').allowed, true)

  clock += 59_000
  assert.equal(limiter.check('10.0.0.9').allowed, false)
  clock += 1_000
  assert.equal(limiter.check('10.0.0.9').allowed, true)
})

test('a locked client cannot extend its own lock by hammering', () => {
  let clock = 0
  const limiter = createPocketRateLimiter({ now: () => clock })
  for (let attempt = 0; attempt < 5; attempt += 1) limiter.fail('1.2.3.4')
  const until = limiter.check('1.2.3.4').retryAfterSeconds
  for (let attempt = 0; attempt < 10; attempt += 1) {
    limiter.fail('1.2.3.4')
    clock += 1_000
  }
  assert.ok(limiter.check('1.2.3.4').retryAfterSeconds <= until, '锁定期不该被越试越长')
})

test('a correct password clears the failures behind it', () => {
  let clock = 0
  const limiter = createPocketRateLimiter({ now: () => clock })
  for (let attempt = 0; attempt < 4; attempt += 1) limiter.fail('10.0.0.9')
  limiter.succeed('10.0.0.9')
  for (let attempt = 0; attempt < 4; attempt += 1) {
    limiter.fail('10.0.0.9')
    clock += 1
  }
  assert.equal(limiter.check('10.0.0.9').allowed, true)
})

test('many clients failing at once trips the global lock', () => {
  let clock = 1_000
  const limiter = createPocketRateLimiter({ now: () => clock, globalMaxFailures: 3, globalLockMs: 30_000 })
  for (const address of ['a', 'b', 'c']) limiter.fail(address)
  const locked = limiter.check('brand-new-client')
  assert.equal(locked.allowed, false)
  assert.equal(locked.reason, 'global')
  clock += 30_000
  assert.equal(limiter.check('brand-new-client').allowed, true)
})

test('a session is valid for this process only', () => {
  const sessions = createPocketSessions()
  const token = sessions.issue()
  assert.equal(sessions.verify(token), true)

  // A restarted shell gets a new secret, which is exactly the promise made to the user:
  // "signed in until DSH restarts".
  assert.equal(createPocketSessions().verify(token), false)
})

test('tampered, expired and future-dated sessions are refused', () => {
  let clock = 1_000
  const sessions = createPocketSessions({ now: () => clock, ttlMs: 5_000 })
  const token = sessions.issue()
  assert.equal(sessions.verify(token), true)
  assert.equal(sessions.verify(`${token}x`), false)
  assert.equal(sessions.verify(token.replace(/^\d+/u, String(clock + 1_000))), false)
  assert.equal(sessions.verify('not-a-session'), false)
  assert.equal(sessions.verify(''), false)
  assert.equal(sessions.verify(undefined), false)

  clock += 5_001
  assert.equal(sessions.verify(token), false)
})

test('rotating the password invalidates every session at once', () => {
  const sessions = createPocketSessions()
  const before = sessions.issue()
  const generation = sessions.version()
  sessions.rotate()
  assert.ok(sessions.version() > generation)
  assert.equal(sessions.verify(before), false)
  assert.equal(sessions.verify(sessions.issue()), true)
})

test('a cookie is read by name and nothing else', () => {
  assert.equal(readCookie('a=1; pocket_session=abc; b=2', 'pocket_session'), 'abc')
  assert.equal(readCookie('pocket_session=abc', 'pocket_session'), 'abc')
  assert.equal(readCookie('other=abc', 'pocket_session'), undefined)
  assert.equal(readCookie(undefined, 'pocket_session'), undefined)
  assert.equal(readCookie('pocket_session=', 'pocket_session'), '')
  // A cookie whose name merely ends with ours must not be mistaken for it.
  assert.equal(readCookie('not_pocket_session=abc', 'pocket_session'), undefined)
})
