/**
 * Guards for editing the DSH profile patch from the shell.
 *
 * Two failure modes matter most:
 *  - a read/write round trip that drops comments or unrelated rows (the file is hand-edited data);
 *  - the legacy-plugin migration running twice, or leaving the old row behind so every MCP server
 *    appears twice.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { createDshConfigStore, mcpRowId, readMcpRow } from './dsh-config.ts'

const root = mkdtempSync(join(tmpdir(), 'dsh-config-'))
after(() => { rmSync(root, { recursive: true, force: true }) })

const PATCH = `# 用户自己的补丁：不要丢注释
- id: ui-chat
  name: "@deepseek-ai/dsh-client-ui-chat"
  config:
    transcriptView: compact

# 旧插件留下的 MCP 记录（迁移来源）
- id: mcp-skill-manager
  name: dsh-mcp-skill-manager
  config:
    mcpServers:
      - serverName: jenkins_dev
        transport: stdio
        command: D:\\node\\node.exe
        args:
          - jenkins-mcp\\dist\\index.js
        env:
          JENKINS_URL: http://10.0.0.5:8080
          JENKINS_API_TOKEN: secret-token
        enabled: true
      - serverName: other_http
        transport: streamable-http
        url: https://example.test/mcp
    skills: []
    skillLinks:
      - name: linked-skill
        target: C:\\skills\\linked-skill
        enabled: true
  disabled: false

- id: oneway-usage-monitor
  name: dsh-oneway-usage-monitor
  config:
    baseUrl: https://oneway.example.test
    refreshSeconds: 300
    sessionCookie: '[{"name":"a"}]'
  disabled: false

- id: mcp-native
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    serverName: native_one
    transport: streamable-http
    url: https://native.test/mcp
`

interface Fixture {
  readonly home: string
  readonly patchPath: string
}

function fixture(name: string, patch = PATCH): Fixture {
  const home = join(root, name)
  const profile = join(home, 'profiles', 'dsh-desktop')
  mkdirSync(profile, { recursive: true })
  const patchPath = join(profile, 'cordis.patch.yml')
  writeFileSync(patchPath, patch, 'utf8')
  return { home, patchPath }
}

test('lists native and legacy MCP servers without losing either', () => {
  const { home } = fixture('list')
  const store = createDshConfigStore({ home })
  const servers = store.listMcpServers()
  const names = servers.map((server) => server.serverName).sort()
  assert.deepEqual(names, ['jenkins_dev', 'native_one', 'other_http'])
  const jenkins = servers.find((server) => server.serverName === 'jenkins_dev')
  assert.equal(jenkins?.transport, 'stdio')
  assert.equal(jenkins?.command, 'D:\\node\\node.exe')
  assert.equal(jenkins?.env?.JENKINS_API_TOKEN, 'secret-token')
  assert.equal(jenkins?.legacy, true)
  assert.equal(servers.find((server) => server.serverName === 'native_one')?.legacy, undefined)
})

test('saving a server adds a native row and keeps every comment and unrelated row', () => {
  const { home, patchPath } = fixture('save')
  const store = createDshConfigStore({ home })
  const result = store.saveMcpServer({
    serverName: 'new_http',
    transport: 'streamable-http',
    url: 'https://new.test/mcp',
    headers: { Authorization: 'Bearer x' },
    enabled: true,
  })
  assert.equal(result.ok, true)
  const text = readFileSync(patchPath, 'utf8')
  assert.match(text, /# 用户自己的补丁：不要丢注释/u, 'comments must survive')
  assert.match(text, /id: "ui-chat"|id: ui-chat/u)
  assert.match(text, /id: mcp-new_http/u)
  assert.match(text, /name: "@deepseek-ai\/dsh-mcp-client"|name: '@deepseek-ai\/dsh-mcp-client'/u)

  const created = store.listMcpServers().find((server) => server.serverName === 'new_http')
  assert.equal(created?.url, 'https://new.test/mcp')
  assert.equal(created?.headers?.Authorization, 'Bearer x')

  // Editing the same row (same id) replaces it instead of adding a duplicate.
  assert.equal(store.saveMcpServer({ id: created?.id, serverName: 'new_http', transport: 'streamable-http', url: 'https://new2.test/mcp' }).ok, true)
  assert.equal(store.listMcpServers().filter((server) => server.serverName === 'new_http').length, 1)
})

test('validation refuses empty names and missing command/url', () => {
  const { home } = fixture('validate')
  const store = createDshConfigStore({ home })
  assert.equal(store.saveMcpServer({ serverName: '  ', transport: 'stdio', command: 'x' }).ok, false)
  assert.equal(store.saveMcpServer({ serverName: 'no_cmd', transport: 'stdio' }).ok, false)
  assert.equal(store.saveMcpServer({ serverName: 'no_url', transport: 'streamable-http' }).ok, false)
})

test('enable/disable and remove only touch the requested row', () => {
  const { home } = fixture('toggle')
  const store = createDshConfigStore({ home })
  const server = store.listMcpServers().find((entry) => entry.serverName === 'native_one')
  assert.ok(server !== undefined)
  assert.equal(store.setMcpEnabled(server.id, false).ok, true)
  assert.equal(store.listMcpServers().find((entry) => entry.id === server.id)?.enabled, false)
  assert.equal(store.setMcpEnabled(server.id, true).ok, true)
  assert.equal(store.listMcpServers().find((entry) => entry.id === server.id)?.enabled, true)
  assert.equal(store.removeMcpServer(server.id).ok, true)
  assert.equal(store.listMcpServers().some((entry) => entry.id === server.id), false)
  assert.equal(store.removeMcpServer(server.id).ok, false, 'removing twice reports the missing row')
})

test('migrating the legacy plugin creates native rows, removes the old row, and is idempotent', () => {
  const { home, patchPath } = fixture('migrate')
  const store = createDshConfigStore({ home })
  const first = store.migrateLegacy()
  assert.equal(first.ok, true)
  assert.equal(first.servers, 2)
  assert.equal(first.alreadyDone, false)
  const text = readFileSync(patchPath, 'utf8')
  assert.doesNotMatch(text, /id: mcp-skill-manager/u, '旧插件行必须移除，否则 MCP 会出现两份')
  assert.match(text, /# 用户自己的补丁/u)
  const servers = store.listMcpServers()
  const migrated = servers.filter((server) => server.legacy !== true)
  assert.deepEqual(migrated.map((server) => server.serverName).sort(), ['jenkins_dev', 'native_one', 'other_http'])
  assert.equal(migrated.find((server) => server.serverName === 'jenkins_dev')?.env?.JENKINS_API_TOKEN, 'secret-token')

  const second = store.migrateLegacy()
  assert.equal(second.ok, true)
  assert.equal(second.alreadyDone, true)
  assert.equal(second.servers, 0)
  assert.equal(store.listMcpServers().filter((server) => server.serverName === 'jenkins_dev').length, 1)
})

test('the legacy ONE-WAY session can be read for the usage window migration', () => {
  const { home } = fixture('usage')
  const store = createDshConfigStore({ home })
  assert.deepEqual(store.readLegacyUsageConfig(), {
    baseUrl: 'https://oneway.example.test',
    refreshSeconds: 300,
    sessionCookie: '[{"name":"a"}]',
  })
})

test('skills list directory bundles, flat markdown, and links (removable only when a link)', () => {
  const home = join(root, 'skills-home')
  const skillsRoot = join(home, 'skills')
  mkdirSync(skillsRoot, { recursive: true })
  mkdirSync(join(skillsRoot, 'bundle'), { recursive: true })
  writeFileSync(join(skillsRoot, 'bundle', 'SKILL.md'), '---\nname: bundle-skill\ndescription: from frontmatter\n---\n\n# Body\n', 'utf8')
  writeFileSync(join(skillsRoot, 'flat.md'), '# flat skill\n', 'utf8')
  const outside = join(root, 'outside-skill')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'SKILL.md'), '---\nname: outside\ndescription: linked outside\n---\n', 'utf8')
  symlinkSync(outside, join(skillsRoot, 'outside-link'), 'junction')

  const store = createDshConfigStore({ home })
  const skills = store.listSkills()
  assert.deepEqual(skills.map((skill) => skill.name).sort(), ['bundle-skill', 'flat', 'outside'])
  assert.equal(skills.find((skill) => skill.name === 'bundle-skill')?.kind, 'bundle')
  assert.equal(skills.find((skill) => skill.name === 'bundle-skill')?.description, 'from frontmatter')
  assert.equal(skills.find((skill) => skill.name === 'flat')?.kind, 'file')
  assert.equal(skills.find((skill) => skill.name === 'outside')?.linked, true)

  // Adding a link from another directory is a junction, not a copy.
  const added = join(root, 'added-skill')
  mkdirSync(added, { recursive: true })
  writeFileSync(join(added, 'SKILL.md'), '---\nname: added\ndescription: added link\n---\n', 'utf8')
  assert.equal(store.addSkillLink(added).ok, true)
  assert.equal(readlinkSync(join(skillsRoot, 'added')) !== undefined, true)
  assert.equal(store.addSkillLink(added).ok, false, 'a name collision is refused')
  assert.equal(store.addSkillLink(join(root, 'nope')).ok, false, 'a directory without SKILL.md is refused')

  assert.equal(store.removeSkillLink('added').ok, true)
  assert.equal(existsSync(join(skillsRoot, 'added')), false)
  assert.equal(store.removeSkillLink('bundle').ok, false, 'real directories are never deleted by the shell')
})

test('a broken patch file is reported instead of overwritten', () => {
  const home = join(root, 'broken-home')
  const profile = join(home, 'profiles', 'dsh-desktop')
  mkdirSync(profile, { recursive: true })
  const patchPath = join(profile, 'cordis.patch.yml')
  writeFileSync(patchPath, '{ not: [ valid', 'utf8')
  const logged: string[] = []
  const store = createDshConfigStore({ home, log: (line) => logged.push(line) })
  assert.equal(store.saveMcpServer({ serverName: 'x', transport: 'stdio', command: 'x' }).ok, false)
  assert.equal(readFileSync(patchPath, 'utf8'), '{ not: [ valid', 'the broken file is left untouched')
  assert.equal(logged.length > 0, true)
})

test('mcpRowId produces safe, stable ids', () => {
  assert.equal(mcpRowId('jenkins_dev'), 'mcp-jenkins_dev')
  assert.equal(mcpRowId('My Server (prod)'), 'mcp-my-server-prod')
  assert.equal(mcpRowId('  '), 'mcp-server')
  // readMcpRow ignores rows that cannot produce a usable client config.
  assert.equal(readMcpRow('x', { transport: 'stdio' }, false), undefined)
  assert.equal(readMcpRow('x', { serverName: 'x', transport: 'stdio', command: 'node' }, false)?.serverName, 'x')
})
