/**
 * Profile-seeding tests.
 *
 * The shell boots its own profile, and `dsh` refuses to boot one that does not exist, so
 * first-run seeding is what makes an upgrade land on a working app. A migrated user's
 * plugins live in the shipped `web` profile, and the rules that carry them over without
 * ever overwriting anything are pinned here.
 *
 * Run: node --test src/profile.test.ts
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import {
  DESKTOP_PROFILE_NAME,
  repairSeededProfile,
  ensureDesktopProfile,
  harnessHomeFrom,
  installProfileDependencies,
  profileNeedsInstall,
  profilePath,
} from '../src/profile.ts'

const workDir = mkdtempSync(join(tmpdir(), 'dsh-profile-test-'))
after(() => { rmSync(workDir, { recursive: true, force: true }) })

let counter = 0
function makeHome(seed?: { bundles: string[]; dependencies?: Record<string, string>; patchReload?: string }): string {
  counter += 1
  const home = join(workDir, `home-${String(counter)}`)
  mkdirSync(home, { recursive: true })
  if (seed !== undefined) {
    const web = profilePath(home, 'web')
    mkdirSync(web, { recursive: true })
    writeFileSync(join(web, 'package.json'), `${JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: seed.dependencies ?? {},
      dsh: { profile: { bundles: seed.bundles, patchReload: seed.patchReload ?? 'live' } },
    }, null, 2)}\n`, 'utf8')
  }
  return home
}

const readDesktop = (home: string): Record<string, any> =>
  JSON.parse(readFileSync(join(profilePath(home), 'package.json'), 'utf8'))

test('DSH_HOME is honoured, and defaults to ~/.dsh', () => {
  assert.equal(harnessHomeFrom({ DSH_HOME: 'D:\\dsh-home' }, 'C:\\Users\\x'), 'D:\\dsh-home')
  assert.equal(harnessHomeFrom({}, 'C:\\Users\\x'), join('C:\\Users\\x', '.dsh'))
  assert.equal(harnessHomeFrom({ DSH_HOME: '' }, 'C:\\Users\\x'), join('C:\\Users\\x', '.dsh'))
})

test('a first run clones the user\'s own web profile, user layer included', () => {
  const home = makeHome({
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dshmarket'],
    dependencies: { dshmarket: '^1.58.0' },
  })
  // What a real profile has beyond the template: a hand-written user layer, the packages
  // the patch resolves, and plugin-manager state.
  const web = profilePath(home, 'web')
  mkdirSync(join(web, 'node_modules', 'dsh-git-panel'), { recursive: true })
  writeFileSync(join(web, 'node_modules', 'dsh-git-panel', 'package.json'), '{"name":"dsh-git-panel","version":"1.0.0"}\n', 'utf8')
  writeFileSync(join(web, 'cordis.patch.yml'), '- id: agent-preset-registry\n  config:\n    default: git-bash\n', 'utf8')
  mkdirSync(join(web, '.plugin-manager'), { recursive: true })
  writeFileSync(join(web, '.plugin-manager', 'state.json'), '{}\n', 'utf8')

  const seed = ensureDesktopProfile(home)
  assert.equal(seed.created, true)
  assert.equal(seed.seededFrom, 'cloned-web')
  assert.deepEqual(seed.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dshmarket'])
  assert.deepEqual(seed.dependencies, { dshmarket: '^1.58.0' })

  const desktop = profilePath(home)
  // The user layer is the whole point: without it the presets it defines do not exist.
  const patch = readFileSync(join(desktop, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /default: git-bash/u)
  assert.equal(existsSync(join(desktop, 'node_modules', 'dsh-git-panel', 'package.json')), true)
  assert.equal(existsSync(join(desktop, '.plugin-manager', 'state.json')), true)

  const manifest = readDesktop(home)
  assert.equal(manifest.name, `dsh-profile-${DESKTOP_PROFILE_NAME}`, '克隆出的 profile 要换成自己的名字')
  assert.equal(manifest.private, true)
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dshmarket'])
  assert.equal(manifest.dsh.profile.patchReload, 'live')

  // The source profile must be left exactly as it was.
  assert.equal(existsSync(join(web, 'cordis.patch.yml')), true)
  assert.equal(existsSync(join(web, 'node_modules', 'dsh-git-panel', 'package.json')), true)
})

test('a clone needs no install, because its node_modules came across', () => {
  const home = makeHome({ bundles: ['@deepseek-ai/dsh-base'], dependencies: { dshmarket: '^1.58.0' } })
  mkdirSync(join(profilePath(home, 'web'), 'node_modules'), { recursive: true })
  const seed = ensureDesktopProfile(home)
  assert.equal(seed.seededFrom, 'cloned-web')
  // Without this, the shell would re-run pnpm over a profile that is already complete.
  assert.equal(profileNeedsInstall(seed), false)
})

test('without a template the profile still gets the bundles a web app needs', () => {
  const home = makeHome()
  const seed = ensureDesktopProfile(home)
  assert.equal(seed.created, true)
  assert.equal(seed.seededFrom, 'default')
  assert.deepEqual(seed.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  assert.deepEqual(seed.dependencies, {})
})

test('an existing profile is never overwritten', () => {
  const home = makeHome({ bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] })
  ensureDesktopProfile(home)
  const desktop = profilePath(home)
  writeFileSync(join(desktop, 'package.json'), `${JSON.stringify({
    name: 'user-edited',
    dependencies: { mine: 'link:./mine' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'mine'] } },
  }, null, 2)}\n`, 'utf8')

  const second = ensureDesktopProfile(home)
  assert.equal(second.created, false)
  assert.equal(second.seededFrom, 'existing')
  assert.deepEqual(second.dependencies, { mine: 'link:./mine' })
  assert.equal(readDesktop(home).name, 'user-edited')
})

test('a profile is not created twice', () => {
  const home = makeHome()
  assert.equal(ensureDesktopProfile(home).created, true)
  assert.equal(ensureDesktopProfile(home).created, false)
  assert.equal(existsSync(join(profilePath(home), 'package.json')), true)
})

test('seeding uses the requested profile name, not the release default', () => {
  // The debug channel boots `--profile dsh-desktop-debug`; seeding `dsh-desktop` instead
  // leaves the host without a profile, and dsh treats that as fatal.
  const home = makeHome({ bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] })
  const seed = ensureDesktopProfile(home, 'dsh-desktop-debug')
  assert.equal(seed.path, profilePath(home, 'dsh-desktop-debug'))
  assert.equal(existsSync(join(profilePath(home, 'dsh-desktop-debug'), 'package.json')), true)
  assert.equal(existsSync(join(profilePath(home, 'dsh-desktop'), 'package.json')), false)
  const manifest = JSON.parse(readFileSync(join(seed.path, 'package.json'), 'utf8')) as { name: string }
  assert.equal(manifest.name, 'dsh-profile-dsh-desktop-debug')
})

test('the bundled pnpm is invoked without a shell and with the app binary', async () => {
  const home = makeHome({ bundles: ['@deepseek-ai/dsh-base'], dependencies: { dshmarket: '^1.58.0' } })
  const seed = ensureDesktopProfile(home)

  const calls: { command: string; args: readonly string[]; cwd: string; shell: boolean }[] = []
  const ok = await installProfileDependencies({
    path: seed.path,
    // A real install directory contains spaces; a shell would split this and cmd would
    // answer `'D:\Program' is not recognized as an internal or external command`,
    // which is exactly how a migration installed nothing.
    nodeExecutable: 'D:\\Program Files\\DSH Desktop Debug\\DSH Desktop Debug.exe',
    pnpmEntry: 'D:\\Program Files\\DSH Desktop Debug\\resources\\runtime\\dsh\\node_modules\\pnpm\\bin\\pnpm.cjs',
    run: (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd, shell: options.shell })
      assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1')
      assert.equal(options.env.DSH_DESKTOP_NODE_EXECUTABLE, command)
      return Promise.resolve({ code: 0, output: '' })
    },
  })
  assert.deepEqual(ok, { ok: true, detail: 'profile 依赖安装完成' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.shell, false, '必须不经 shell：路径带空格时会被拆开')
  assert.equal(calls[0]?.command, 'D:\\Program Files\\DSH Desktop Debug\\DSH Desktop Debug.exe')
  assert.match(String(calls[0]?.args[0]), /pnpm\.cjs$/u, 'pnpm 用 JS 入口，不用 .cmd shim')
  assert.deepEqual(calls[0]?.args.slice(1), ['install'])
  assert.equal(calls[0]?.cwd, seed.path)
})

test('a failing install is reported, never fatal', async () => {
  const home = makeHome()
  const seed = ensureDesktopProfile(home)
  const result = await installProfileDependencies({
    path: seed.path,
    pnpmEntry: 'pnpm.cjs',
    nodeExecutable: 'node',
    run: () => Promise.resolve({ code: 1, output: 'ERR_PNPM_NO_MATCHING_VERSION' }),
  })
  assert.equal(result.ok, false)
  assert.match(result.detail, /退出码 1/u)
  assert.match(result.detail, /ERR_PNPM_NO_MATCHING_VERSION/u)

  const threw = await installProfileDependencies({
    path: seed.path,
    pnpmEntry: 'pnpm.cjs',
    nodeExecutable: 'node',
    run: () => Promise.reject(new Error('spawn failed')),
  })
  assert.equal(threw.ok, false)
  assert.match(threw.detail, /spawn failed/u)
})

test('declared but missing plugins trigger a retry, not just a fresh profile', () => {
  const home = makeHome({ bundles: ['@deepseek-ai/dsh-base'], dependencies: { dshmarket: '^1.58.0' } })
  const seed = ensureDesktopProfile(home)
  // A first-run install can fail; the next start must try again.
  assert.equal(profileNeedsInstall(seed), true)

  mkdirSync(join(seed.path, 'node_modules'), { recursive: true })
  assert.equal(profileNeedsInstall(seed), false)

  // A profile that declares nothing never installs.
  const bare = makeHome()
  assert.equal(profileNeedsInstall(ensureDesktopProfile(bare)), false)
})

test('a profile seeded by the old logic is repaired from the source user layer', () => {
  // What <= 0.3.7 produced: dsh's generated skeleton patch, no user layer, no plugins.
  const home = makeHome({ bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] })
  const web = profilePath(home, 'web')
  writeFileSync(join(web, 'cordis.patch.yml'), `# 用户层\n${'- id: agent-preset-registry\n  config:\n    default: git-bash\n'.repeat(40)}`, 'utf8')
  // A `link:` plugin is a symlink beside the profile; a registry package is a plain
  // directory (the lockfile already covers it, so it needs no spec).
  const pluginSource = join(workDir, 'local-plugin')
  mkdirSync(pluginSource, { recursive: true })
  writeFileSync(join(pluginSource, 'package.json'), '{}\n', 'utf8')
  mkdirSync(join(web, 'node_modules'), { recursive: true })
  symlinkSync(pluginSource, join(web, 'node_modules', 'dsh-git-panel'), 'junction')

  const desktop = profilePath(home)
  mkdirSync(desktop, { recursive: true })
  writeFileSync(join(desktop, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-dsh-desktop', dependencies: {} }, null, 2)}\n`, 'utf8')
  writeFileSync(join(desktop, 'cordis.patch.yml'), '- id: agent-preset-registry\n  config:\n    default: standard\n', 'utf8')

  const repair = repairSeededProfile(home)
  assert.equal(repair.repaired, true)
  assert.ok(repair.copied.includes('cordis.patch.yml'))
  assert.match(readFileSync(join(desktop, 'cordis.patch.yml'), 'utf8'), /default: git-bash/u)
  // The skeleton is kept for diffing rather than deleted.
  assert.equal(existsSync(join(desktop, `cordis.patch.yml.bak-seeded-`)) || readdirSync(desktop).some(n => n.startsWith('cordis.patch.yml.bak-seeded-')), true)
  // Packages the patch names are not in package.json, so they must be reported for install.
  assert.equal(repair.missingLinks.length, 1)
  assert.match(repair.missingLinks[0] ?? '', /link:.*local-plugin$/u)
})

test('a profile the user has configured is left alone', () => {
  const home = makeHome({ bundles: ['@deepseek-ai/dsh-base'] })
  const web = profilePath(home, 'web')
  writeFileSync(join(web, 'cordis.patch.yml'), 'x'.repeat(1000), 'utf8')
  const desktop = profilePath(home)
  mkdirSync(desktop, { recursive: true })
  writeFileSync(join(desktop, 'package.json'), '{}\n', 'utf8')
  // Comparable size: this is a real user layer, not a generated skeleton.
  writeFileSync(join(desktop, 'cordis.patch.yml'), 'y'.repeat(600), 'utf8')

  const repair = repairSeededProfile(home)
  assert.equal(repair.repaired, false)
  assert.equal(readFileSync(join(desktop, 'cordis.patch.yml'), 'utf8'), 'y'.repeat(600))
})

test('a profile without a source to repair from is left alone', () => {
  const home = makeHome()
  const desktop = profilePath(home)
  mkdirSync(desktop, { recursive: true })
  writeFileSync(join(desktop, 'package.json'), '{}\n', 'utf8')
  assert.equal(repairSeededProfile(home).repaired, false)
  assert.equal(repairSeededProfile(home).missingLinks.length, 0)
})
