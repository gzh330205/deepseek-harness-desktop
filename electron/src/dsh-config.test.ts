/**
 * Guards for editing the DSH profile patch from the shell.
 *
 * Three failure modes matter most:
 *  - a new MCP row written as a top-level patch: in the loader's patch semantics that is only an
 *    assertion on an existing row, so the row never mounts (`patch: entry "mcp-…" not found`);
 *  - a read/write round trip that drops comments or unrelated rows (the file is hand-edited data);
 *  - the legacy-plugin migration running twice, or leaving the old row behind so every MCP server
 *    appears twice.
 *
 * The structure assertions parse the written file and look at the document, not just the text: a
 * regex cannot tell "inside `- insert: [...]`" (mounted) from "top-level with a `name`" (assertion).
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { isMap, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml'

import { createDshConfigStore, mcpRowId, readMcpRow } from './dsh-config.ts'

const root = mkdtempSync(join(tmpdir(), 'dsh-config-'))
after(() => { rmSync(root, { recursive: true, force: true }) })

const MCP = '@deepseek-ai/dsh-mcp-client'
const HEADER = '# 用户自己的补丁：不要丢注释'

/** A profile as the old shell left it: MCP rows are top-level assertions that never mounted. */
const PATCH_BROKEN = `${HEADER}
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

# 旧壳写坏的 MCP 行：顶层 patch 只是断言，永远不会挂载
- id: mcp-broken_one
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    serverName: broken_one
    transport: streamable-http
    url: https://broken.test/mcp
`

/** A correct patch: new rows live in an insert container. */
const PATCH_CLEAN = `${HEADER}
- id: ui-chat
  name: "@deepseek-ai/dsh-client-ui-chat"
  config:
    transcriptView: compact

- insert:
    - id: mcp-native
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: native_one
        transport: streamable-http
        url: https://native.test/mcp
`

/** Mixed state: broken top-level rows plus one correct container (which is not first yet). */
const PATCH_MIXED = `${PATCH_BROKEN}
- insert:
    - id: mcp-native
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: native_one
        transport: streamable-http
        url: https://native.test/mcp
`

/** Broken rows only, no legacy plugin row left: "already done" must still repair them. */
const PATCH_REPAIR_ONLY = `${HEADER}
- id: ui-chat
  name: "@deepseek-ai/dsh-client-ui-chat"
  config:
    transcriptView: compact

- id: mcp-broken_one
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    serverName: broken_one
    transport: streamable-http
    url: https://broken.test/mcp
`

interface Fixture {
  readonly home: string
  readonly patchPath: string
}

function fixture(name: string, patch = PATCH_MIXED): Fixture {
  const home = join(root, name)
  const profile = join(home, 'profiles', 'dsh-desktop')
  mkdirSync(profile, { recursive: true })
  const patchPath = join(profile, 'cordis.patch.yml')
  writeFileSync(patchPath, patch, 'utf8')
  return { home, patchPath }
}

interface PatchShape {
  /** Top-level patch entries, including the insert container. */
  readonly top: readonly unknown[]
  /** `- insert: [...]` containers. */
  readonly containers: readonly YAMLMap[]
  /** Top-level entries that are not containers (assertions / legacy rows / old broken rows). */
  readonly topRows: readonly Record<string, unknown>[]
  /** Rows inside insert containers — the only place new rows actually mount. */
  readonly insertedRows: readonly Record<string, unknown>[]
}

function plainNode(node: unknown): Record<string, unknown> | undefined {
  if (typeof node !== 'object' || node === null) return undefined
  const toJSON = (node as { toJSON?: () => unknown }).toJSON
  const value = typeof toJSON === 'function' ? toJSON.call(node) : node
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function readPatch(patchPath: string): PatchShape {
  const doc = parseDocument(readFileSync(patchPath, 'utf8'))
  assert.deepEqual(doc.errors, [], 'the shell must leave a parseable YAML file behind')
  const contents = doc.contents as unknown as { items?: unknown[] } | null
  const top = Array.isArray(contents?.items) ? contents.items : []
  const containers: YAMLMap[] = []
  const topRows: Record<string, unknown>[] = []
  const insertedRows: Record<string, unknown>[] = []
  for (const item of top) {
    if (isMap(item) && item.items.length === 1 && item.has('insert')) {
      containers.push(item)
      const seq = item.get('insert')
      if (isSeq(seq)) {
        for (const child of (seq as YAMLSeq).items) {
          const plain = plainNode(child)
          if (plain !== undefined) insertedRows.push(plain)
        }
      }
      continue
    }
    const plain = plainNode(item)
    if (plain !== undefined) topRows.push(plain)
  }
  return { top, containers, topRows, insertedRows }
}

test('lists MCP rows from the insert container and the old top-level rows without duplicates', () => {
  const { home } = fixture('list')
  const store = createDshConfigStore({ home })
  const servers = store.listMcpServers()
  assert.deepEqual(servers.map((server) => server.serverName).sort(), ['broken_one', 'jenkins_dev', 'native_one', 'other_http'])
  assert.equal(new Set(servers.map((server) => server.id)).size, servers.length, 'a row is never counted twice')
  const jenkins = servers.find((server) => server.serverName === 'jenkins_dev')
  assert.equal(jenkins?.transport, 'stdio')
  assert.equal(jenkins?.command, 'D:\\node\\node.exe')
  assert.equal(jenkins?.env?.JENKINS_API_TOKEN, 'secret-token')
  assert.equal(jenkins?.legacy, true)
  assert.equal(servers.find((server) => server.serverName === 'native_one')?.legacy, undefined)
  assert.equal(servers.find((server) => server.serverName === 'broken_one')?.url, 'https://broken.test/mcp')
})

test('saving a server writes it inside an insert container, never as a top-level patch', () => {
  const { home, patchPath } = fixture('save', PATCH_BROKEN)
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

  const shape = readPatch(patchPath)
  assert.equal(shape.containers.length, 1)
  assert.equal(shape.top[0], shape.containers[0], 'the insert container must be the first patch')
  // The leading comment moved onto the container that is now first, instead of being dropped.
  assert.match(String(shape.containers[0]?.commentBefore), /用户自己的补丁/u)
  assert.equal(shape.topRows.some((row) => row.id === 'mcp-new_http'), false, 'the saved row must not be a top-level patch')
  // A pre-existing broken row is left for the startup repair instead of being rewritten by an
  // unrelated save; what matters here is that this save did not add another one.
  assert.deepEqual(shape.topRows.filter((row) => row.name === MCP).map((row) => row.id), ['mcp-broken_one'])
  const createdRow = shape.insertedRows.find((row) => row.id === 'mcp-new_http')
  assert.ok(createdRow !== undefined, 'the new row must be inside the insert container')
  assert.deepEqual(createdRow.config, {
    serverName: 'new_http',
    transport: 'streamable-http',
    failOnStartupError: false,
    url: 'https://new.test/mcp',
    headers: { Authorization: 'Bearer x' },
  })

  const created = store.listMcpServers().find((server) => server.serverName === 'new_http')
  assert.equal(created?.url, 'https://new.test/mcp')
  assert.equal(created?.headers?.Authorization, 'Bearer x')

  // Editing the same row (same id) updates it instead of adding a duplicate.
  assert.equal(store.saveMcpServer({ id: created?.id, serverName: 'new_http', transport: 'streamable-http', url: 'https://new2.test/mcp' }).ok, true)
  assert.equal(store.listMcpServers().filter((server) => server.serverName === 'new_http').length, 1)
  const edited = readPatch(patchPath).insertedRows.filter((row) => row.id === 'mcp-new_http')
  assert.equal(edited.length, 1)
  assert.equal((edited[0]?.config as Record<string, unknown> | undefined)?.url, 'https://new2.test/mcp')
})

test('editing a broken top-level row moves it into the insert container', () => {
  const { home, patchPath } = fixture('repair-on-save', PATCH_BROKEN)
  const store = createDshConfigStore({ home })
  const broken = store.listMcpServers().find((server) => server.serverName === 'broken_one')
  assert.ok(broken !== undefined)
  assert.equal(store.saveMcpServer({ id: broken.id, serverName: 'broken_one', transport: 'streamable-http', url: 'https://broken2.test/mcp' }).ok, true)

  const text = readFileSync(patchPath, 'utf8')
  assert.match(text, /# 旧壳写坏的 MCP 行/u, 'the row comment travels with the row')
  const shape = readPatch(patchPath)
  assert.equal(shape.topRows.some((row) => row.name === MCP), false)
  const moved = shape.insertedRows.find((row) => row.id === 'mcp-broken_one')
  assert.ok(moved !== undefined, 'the edited row must now live in the insert container')
  assert.equal((moved.config as Record<string, unknown>).url, 'https://broken2.test/mcp')
  assert.equal(store.listMcpServers().filter((server) => server.serverName === 'broken_one').length, 1)
})

test('editing a row already in the container updates it in place and keeps the container first', () => {
  const { home, patchPath } = fixture('save-existing', PATCH_CLEAN)
  const store = createDshConfigStore({ home })
  const native = store.listMcpServers().find((server) => server.serverName === 'native_one')
  assert.ok(native !== undefined)
  assert.equal(store.saveMcpServer({ id: native.id, serverName: 'native_one', transport: 'streamable-http', url: 'https://native2.test/mcp' }).ok, true)

  const shape = readPatch(patchPath)
  assert.equal(shape.containers.length, 1)
  assert.equal(shape.top[0], shape.containers[0], 'the container is pulled to the front so later overrides can hit the row')
  assert.match(String(shape.containers[0]?.commentBefore), /用户自己的补丁/u)
  assert.equal(shape.topRows.some((row) => row.name === MCP), false)
  assert.equal(shape.insertedRows.filter((row) => row.id === 'mcp-native').length, 1)
  assert.equal(store.listMcpServers().filter((server) => server.serverName === 'native_one').length, 1)
})

test('validation refuses empty names and missing command/url', () => {
  const { home } = fixture('validate')
  const store = createDshConfigStore({ home })
  assert.equal(store.saveMcpServer({ serverName: '  ', transport: 'stdio', command: 'x' }).ok, false)
  assert.equal(store.saveMcpServer({ serverName: 'no_cmd', transport: 'stdio' }).ok, false)
  assert.equal(store.saveMcpServer({ serverName: 'no_url', transport: 'streamable-http' }).ok, false)
})

test('enable/disable and remove act on rows inside the insert container', () => {
  const { home, patchPath } = fixture('toggle', PATCH_CLEAN)
  const store = createDshConfigStore({ home })
  const server = store.listMcpServers().find((entry) => entry.serverName === 'native_one')
  assert.ok(server !== undefined)
  assert.equal(store.setMcpEnabled(server.id, false).ok, true)
  assert.equal(store.listMcpServers().find((entry) => entry.id === server.id)?.enabled, false)
  assert.equal((readPatch(patchPath).insertedRows.find((row) => row.id === server.id)?.disabled), true)
  assert.equal(store.setMcpEnabled(server.id, true).ok, true)
  assert.equal(store.listMcpServers().find((entry) => entry.id === server.id)?.enabled, true)
  assert.equal((readPatch(patchPath).insertedRows.find((row) => row.id === server.id)?.disabled), undefined)
  assert.equal(store.removeMcpServer(server.id).ok, true)
  assert.equal(store.listMcpServers().some((entry) => entry.id === server.id), false)
  assert.equal(readPatch(patchPath).insertedRows.some((row) => row.id === server.id), false)
  assert.equal(store.removeMcpServer(server.id).ok, false, 'removing twice reports the missing row')
})

test('remove also drops a stray top-level MCP row', () => {
  const { home, patchPath } = fixture('toggle-broken', PATCH_BROKEN)
  const store = createDshConfigStore({ home })
  const broken = store.listMcpServers().find((server) => server.serverName === 'broken_one')
  assert.ok(broken !== undefined)
  assert.equal(store.removeMcpServer(broken.id).ok, true)
  assert.equal(readPatch(patchPath).topRows.some((row) => row.id === broken.id), false)
  assert.equal(store.listMcpServers().some((server) => server.serverName === 'broken_one'), false)
})

test('migrating the legacy plugin creates insert rows, removes the old row, and is idempotent', () => {
  const { home, patchPath } = fixture('migrate', PATCH_BROKEN)
  const store = createDshConfigStore({ home })
  const first = store.migrateLegacy()
  assert.equal(first.ok, true)
  assert.equal(first.servers, 2)
  assert.equal(first.alreadyDone, false)
  assert.equal(first.repaired, 1, 'the broken top-level MCP row is moved into the insert container')

  const text = readFileSync(patchPath, 'utf8')
  assert.doesNotMatch(text, /id: mcp-skill-manager/u, '旧插件行必须移除，否则 MCP 会出现两份')
  assert.match(text, /# 用户自己的补丁/u, 'the header comment survives the migration')
  assert.match(text, /# 旧壳写坏的 MCP 行/u, 'the broken row comment survives the repair')

  const shape = readPatch(patchPath)
  assert.equal(shape.topRows.some((row) => row.name === MCP), false, 'every MCP row must be inside the insert container')
  assert.equal(shape.topRows.some((row) => row.id === 'mcp-skill-manager'), false)
  assert.equal(shape.top[0], shape.containers[0], 'the container must be the first patch')
  assert.deepEqual(shape.insertedRows.map((row) => row.id).sort(), ['mcp-broken_one', 'mcp-jenkins_dev', 'mcp-other_http'])

  const servers = store.listMcpServers()
  const migrated = servers.filter((server) => server.legacy !== true)
  assert.deepEqual(migrated.map((server) => server.serverName).sort(), ['broken_one', 'jenkins_dev', 'other_http'])
  assert.equal(migrated.find((server) => server.serverName === 'jenkins_dev')?.env?.JENKINS_API_TOKEN, 'secret-token')

  const beforeSecond = readFileSync(patchPath, 'utf8')
  const second = store.migrateLegacy()
  assert.equal(second.ok, true)
  assert.equal(second.alreadyDone, true)
  assert.equal(second.servers, 0)
  assert.equal(second.repaired, 0)
  assert.equal(readFileSync(patchPath, 'utf8'), beforeSecond, 'a clean profile is not rewritten')
  assert.equal(store.listMcpServers().filter((server) => server.serverName === 'jenkins_dev').length, 1)
})

test('migration repairs top-level MCP rows even when there is no legacy row left', () => {
  const { home, patchPath } = fixture('repair-only', PATCH_REPAIR_ONLY)
  const logs: string[] = []
  const store = createDshConfigStore({ home, log: (line) => logs.push(line) })
  const result = store.migrateLegacy()
  assert.equal(result.ok, true)
  assert.equal(result.alreadyDone, true, 'nothing left to migrate from the legacy plugin')
  assert.equal(result.servers, 0)
  assert.equal(result.repaired, 1, 'the old write still has to be repaired')
  assert.equal(logs.some((line) => line.includes('insert')), true, 'the repair is diagnosable from the log')

  const shape = readPatch(patchPath)
  assert.equal(shape.topRows.some((row) => row.name === MCP), false)
  assert.equal(shape.top[0], shape.containers[0])
  assert.equal(shape.insertedRows.filter((row) => row.id === 'mcp-broken_one').length, 1)
  assert.match(String(shape.containers[0]?.commentBefore), /用户自己的补丁/u)

  const before = readFileSync(patchPath, 'utf8')
  const second = store.migrateLegacy()
  assert.equal(second.repaired, 0)
  assert.equal(second.alreadyDone, true)
  assert.equal(readFileSync(patchPath, 'utf8'), before, 'the repair itself is idempotent')
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

test('a missing patch file is normal (first start) and is not logged as an error', () => {
  const home = join(root, 'missing-home')
  const logged: string[] = []
  const store = createDshConfigStore({ home, log: (line) => logged.push(line) })
  assert.deepEqual(store.listMcpServers(), [])
  assert.equal(store.removeRows(['retired']).removed, 0)
  const migration = store.migrateLegacy()
  assert.equal(migration.ok, true)
  assert.equal(migration.alreadyDone, true)
  assert.equal(migration.repaired, 0)
  assert.deepEqual(logged, [], 'a profile that is not seeded yet must not look like a failure')
})

test('mcpRowId produces safe, stable ids', () => {
  assert.equal(mcpRowId('jenkins_dev'), 'mcp-jenkins_dev')
  assert.equal(mcpRowId('My Server (prod)'), 'mcp-my-server-prod')
  assert.equal(mcpRowId('  '), 'mcp-server')
  // readMcpRow ignores rows that cannot produce a usable client config.
  assert.equal(readMcpRow('x', { transport: 'stdio' }, false), undefined)
  assert.equal(readMcpRow('x', { serverName: 'x', transport: 'stdio', command: 'node' }, false)?.serverName, 'x')
})
