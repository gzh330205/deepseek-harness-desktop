/**
 * GitHub-source parsing and admission.
 *
 * The inputs here are messy on purpose: they come from the community catalog (where they are wrapped
 * in `dsh plugin --profile … add "…"` and may be quoted), from a user pasting a browser URL, and from
 * the two spec shapes pnpm accepts (`github:owner/repo`, a release tarball URL). Every accepted shape
 * in these tests was taken from the real catalog or from what pnpm documents.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  githubRawUrl,
  githubSpec,
  inspectGithubPlugin,
  lifecycleScripts,
  parseGithubInput,
  readGithubPlugin,
} from './market-github.ts'

test('every way a GitHub source is written resolves to the same owner/repo', () => {
  const expected = { owner: 'CAI-MH', repo: 'dsh-quality-review' }
  for (const input of [
    'CAI-MH/dsh-quality-review',
    'github:CAI-MH/dsh-quality-review',
    'https://github.com/CAI-MH/dsh-quality-review',
    'https://github.com/CAI-MH/dsh-quality-review.git',
    'github:CAI-MH/dsh-quality-review#main',
    'https://github.com/CAI-MH/dsh-quality-review/tree/main',
    // The catalog's own wording, quotes and all.
    'dsh plugin --profile web add github:CAI-MH/dsh-quality-review',
  ]) {
    const source = parseGithubInput(input)
    assert.equal(source?.owner, expected.owner, input)
    assert.equal(source?.repo, expected.repo, input)
  }
  // A ref survives; a trailing path inside the repo does not become one.
  assert.equal(parseGithubInput('github:a/b#v1.2.3')?.ref, 'v1.2.3')
  assert.equal(parseGithubInput('https://github.com/a/b/tree/v1.2.3/sub')?.ref, 'v1.2.3')
  assert.equal(parseGithubInput('a/b')?.ref, undefined)
})

test('release tarball URLs are kept verbatim as the spec, but still identify the repo', () => {
  const pinned = 'dsh plugin --profile web add "https://github.com/benrong2048-boop/dsh-prompt-polish/releases/download/v0.2.3/benrong-dsh-prompt-polish-0.2.3.tgz"'
  const latest = 'https://github.com/Funny1Potato/dsh-outsourcing-expert/releases/latest/download/dsh-outsourcing-expert.tgz'
  const first = parseGithubInput(pinned)
  assert.deepEqual(
    { owner: first?.owner, repo: first?.repo },
    { owner: 'benrong2048-boop', repo: 'dsh-prompt-polish' },
  )
  assert.match(first?.tarball ?? '', /releases\/download\/v0\.2\.3\/.*\.tgz$/u)
  assert.equal(githubSpec(first!), 'https://github.com/benrong2048-boop/dsh-prompt-polish/releases/download/v0.2.3/benrong-dsh-prompt-polish-0.2.3.tgz')
  // A tarball URL with no tag still works, and a repository becomes a `github:` spec.
  assert.equal(githubSpec(parseGithubInput(latest)!), latest)
  assert.equal(githubSpec(parseGithubInput('a/b')!), 'github:a/b')
  assert.equal(githubSpec(parseGithubInput('github:a/b#dev')!), 'github:a/b#dev')
})

test('anything that is not a GitHub reference is refused, not guessed', () => {
  for (const input of ['', '   ', 'dsh-cost-meter', '@scope/name', 'https://example.com/a/b', 'just some words', 'a/b/c/d']) {
    assert.equal(parseGithubInput(input), undefined, input)
  }
})

test('the manifest is read from raw.githubusercontent at the named ref, HEAD by default', () => {
  assert.equal(githubRawUrl({ owner: 'a', repo: 'b' }), 'https://raw.githubusercontent.com/a/b/HEAD/package.json')
  assert.equal(githubRawUrl({ owner: 'a', repo: 'b', ref: 'v1' }), 'https://raw.githubusercontent.com/a/b/v1/package.json')
  assert.equal(githubRawUrl({ owner: 'a', repo: 'b' }, 'dsh.json'), 'https://raw.githubusercontent.com/a/b/HEAD/dsh.json')
})

test('admission is the same rule as the npm path, applied to the repository manifest', () => {
  const plugin = readGithubPlugin({ owner: 'CAI-MH', repo: 'dsh-quality-review' }, {
    name: 'dsh-quality-review',
    version: '0.1.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  assert.ok('plugin' in plugin, JSON.stringify(plugin))
  if ('plugin' in plugin) {
    assert.equal(plugin.plugin.name, 'dsh-quality-review')
    assert.equal(plugin.plugin.version, '0.1.0')
    assert.equal(plugin.plugin.spec, 'github:CAI-MH/dsh-quality-review')
    assert.deepEqual(plugin.plugin.scripts, [])
  }

  // An ordinary GitHub project is refused with a reason, exactly like an ordinary npm package.
  const refused = readGithubPlugin({ owner: 'a', repo: 'b' }, { name: 'left-pad', version: '1.0.0' })
  assert.ok('reason' in refused)
  if ('reason' in refused) assert.match(refused.reason, /没有声明 dsh/u)
  // A manifest with no name cannot be registered, so it is refused for that reason instead.
  const unnamed = readGithubPlugin({ owner: 'a', repo: 'b' }, { version: '1.0.0' })
  assert.ok('reason' in unnamed)
  if ('reason' in unnamed) assert.match(unnamed.reason, /没有 name/u)
  // A non-plugin cannot be smuggled in via a `dsh.client`-only manifest either.
  const clientOnly = readGithubPlugin({ owner: 'a', repo: 'b' }, { name: 'x', dsh: { client: { platform: 'web' } } })
  assert.ok('reason' in clientOnly)
})

test('install scripts are surfaced, because they run on this machine', () => {
  assert.deepEqual(lifecycleScripts({ scripts: { build: 'tsc', prepare: 'npm run build', test: 'node --test' } }), ['prepare'])
  assert.deepEqual(lifecycleScripts({ scripts: { preinstall: 'x', install: 'y', postinstall: 'z' } }), ['preinstall', 'install', 'postinstall'])
  assert.deepEqual(lifecycleScripts({ scripts: { prepare: '   ' } }), [], 'an empty script is not a script')
  assert.deepEqual(lifecycleScripts({ scripts: 'nope' }), [])
  assert.deepEqual(lifecycleScripts(null), [])
  const plugin = readGithubPlugin({ owner: 'a', repo: 'b' }, {
    name: 'a-plugin',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    scripts: { postinstall: 'node ./setup.js' },
  })
  assert.ok('plugin' in plugin)
  if ('plugin' in plugin) assert.deepEqual(plugin.plugin.scripts, ['postinstall'])
})

test('inspection fetches the manifest, and explains a missing repository as such', async () => {
  const asked: string[] = []
  const found = await inspectGithubPlugin(url => {
    asked.push(url)
    return Promise.resolve({ name: '@benrong/dsh-prompt-polish', version: '0.2.3', dsh: { bundle: { patch: './cordis.patch.yml' } } })
  }, 'dsh plugin --profile web add "https://github.com/benrong2048-boop/dsh-prompt-polish/releases/latest/download/x.tgz"')
  assert.deepEqual(asked, ['https://raw.githubusercontent.com/benrong2048-boop/dsh-prompt-polish/HEAD/package.json'])
  assert.ok('plugin' in found)
  if ('plugin' in found) {
    assert.equal(found.plugin.name, '@benrong/dsh-prompt-polish', 'the repo declares the real package name')
    assert.match(found.plugin.spec, /^https:\/\/github\.com\/.*\.tgz$/u)
  }

  const missing = await inspectGithubPlugin(() => Promise.reject(new Error('获取失败：HTTP 404')), 'owner/private-repo')
  assert.ok('reason' in missing)
  if ('reason' in missing) assert.match(missing.reason, /仓库不存在、是私有的/u)

  const nonsense = await inspectGithubPlugin(() => Promise.resolve({}), 'not a repo')
  assert.ok('reason' in nonsense)
  if ('reason' in nonsense) assert.match(nonsense.reason, /不是一个 GitHub 仓库地址/u)
})
