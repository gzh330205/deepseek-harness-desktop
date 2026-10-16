#!/usr/bin/env node
/**
 * Render the market page outside the app, so its layout can be looked at.
 *
 * Why this exists: the market window is an Electron window, which means neither a screenshot tool nor
 * the sidebar browser can see it — and "the layout is ugly" is not something unit tests can answer.
 * This builds a copy of the page with a **stub** `__DSH_MARKET__` bridge returning realistic fixture
 * data (taken from the real community catalog when a copy is around), so the exact same HTML/CSS/JS can
 * be opened in a browser and reviewed, or screenshotted.
 *
 * It is a development tool: nothing here ships, and it never touches the user's profile.
 *
 * Usage: node scripts/preview-market.mjs [--out <file>] [--entries <n>] [--page-size <n>]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}

const pagePath = [join(root, 'dist', 'market', 'index.html'), join(root, 'src', 'market-ui', 'index.html')].find(candidate => existsSync(candidate))
if (pagePath === undefined) {
  process.stderr.write('preview-market: 找不到市场页面（先运行 node build.mjs）\n')
  process.exit(1)
}

const catalogPath = [
  join(root, '..', '.tmp-dshmarket', 'plugins.json'),
  join(tmpdir(), 'dshmarket-plugins.json'),
].find(candidate => existsSync(candidate))

/** Fallback fixture, so the preview still works without a catalog copy on disk. */
const fallback = {
  categories: { ui: { en: 'UI Enhancements', zh: 'UI 增强' }, tools: { en: 'Tools', zh: '工具' } },
  plugins: [
    { name: 'dsh-cost-meter', owner: 'example', category: 'ui', npm: 'dsh-cost-meter', version: '1.8.26', stars: 42, downloads: 1200, capabilities: ['fs-read'], description: { zh: '用量与花费统计面板。', en: 'Usage and cost meter.' } },
    { name: 'dsh-win-notify', owner: 'example', category: 'tools', version: '0.1.0', stars: 7, downloads: 90, capabilities: ['exec'], description: { zh: '任务完成时发 Windows 通知。' } },
  ],
}

const catalog = catalogPath === undefined ? fallback : JSON.parse(readFileSync(catalogPath, 'utf8'))
const rawEntries = Array.isArray(catalog.plugins) ? catalog.plugins : []
const vocabulary = catalog.categories !== null && typeof catalog.categories === 'object' && !Array.isArray(catalog.categories) ? catalog.categories : {}

const wanted = Number(arg('--entries', '160'))
const counts = new Map()
for (const entry of rawEntries) {
  const key = typeof entry.category === 'string' ? entry.category : ''
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

// Realistic fixture: round-robin across the busiest categories, keeping whole entries (including the
// ones with no npm mapping, which is a state the UI has to render honestly).
const ordered = [...counts.entries()].sort((left, right) => right[1] - left[1]).map(([id]) => id)
const byCategory = new Map(ordered.map(id => [id, rawEntries.filter(entry => (entry.category ?? '') === id)]))
const entries = []
const cursors = new Map(ordered.map(id => [id, 0]))
while (entries.length < wanted) {
  let added = false
  for (const id of ordered) {
    const bucket = byCategory.get(id) ?? []
    const cursor = cursors.get(id) ?? 0
    if (cursor >= bucket.length) continue
    entries.push(bucket[cursor])
    cursors.set(id, cursor + 1)
    added = true
    if (entries.length >= wanted) break
  }
  if (!added) break
}

const categoryList = ordered
  .filter(id => id !== '')
  .map(id => {
    const label = vocabulary[id]
    return {
      id,
      ...(label !== null && typeof label === 'object'
        ? { ...(typeof label.en === 'string' ? { en: label.en } : {}), ...(typeof label.zh === 'string' ? { zh: label.zh } : {}) }
        : {}),
    }
  })
const categoryCounts = Object.fromEntries(counts)

const page = readFileSync(pagePath, 'utf8')
const fixture = JSON.stringify({ entries, categoryList, categoryCounts, total: entries.length })
  // A `</script>` inside a JSON string would end the block; escape every `<` for safety.
  .replace(/</gu, '\\u003c')

const stub = `  <script>
    // Preview harness only (scripts/preview-market.mjs): a stub bridge with fixture data, so the real
    // page can be rendered and reviewed in a browser. Nothing here exists in the app.
    const FIXTURE = JSON.parse(${JSON.stringify(fixture)})
    const sorted = (list, sort) => {
      const copy = [...list]
      if (sort === 'name') return copy.sort((a, b) => a.name.localeCompare(b.name))
      if (sort === 'added') return copy.sort((a, b) => String(b.added ?? '').localeCompare(String(a.added ?? '')))
      if (sort === 'downloads') return copy.sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0))
      return copy.sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0))
    }
    window.__DSH_MARKET__ = {
      browse: async request => {
        const query = String(request?.query ?? '').trim().toLowerCase()
        const category = String(request?.category ?? '')
        const pageSize = Number(request?.pageSize ?? 40)
        const page = Number(request?.page ?? 0)
        let list = FIXTURE.entries.filter(entry => category === '' || entry.category === category)
        if (query !== '') {
          list = list.filter(entry => JSON.stringify(entry).toLowerCase().includes(query))
        }
        list = sorted(list, request?.sort ?? 'stars')
        return {
          categories: FIXTURE.categoryList,
          categoryCounts: FIXTURE.categoryCounts,
          updated: new Date().toISOString(),
          total: list.length,
          page,
          pageSize,
          entries: list.slice(page * pageSize, page * pageSize + pageSize),
          installed: ['dsh-plugin-kit'],
        }
      },
      installed: async () => ({ items: [
        { name: 'dsh-plugin-kit', spec: 'link:D:/workspace/research/deepseek-harness-plugins/dsh-plugin-kit' },
        { name: '@changfenhuang/dsh-genui', spec: 'github:omdsh-dev/dsh-genui' },
      ] }),
      profileDir: async () => 'C:\\\\Users\\\\gzh33\\\\.dsh\\\\profiles\\\\dsh-desktop',
      search: async () => ({ ok: true, packages: [], skipped: [], page: { from: 0, size: 20, hasMore: false, scanned: 0 } }),
      act: async (action, name) => ({ ok: true, action, name, spec: name, code: 0, output: '', bundleRegistered: true }),
      updates: async () => ([
        { name: 'dsh-cost-meter', current: '1.8.26', latest: '1.9.0', hasUpdate: true, source: 'registry' },
        { name: '@changfenhuang/dsh-genui', current: 'github:omdsh-dev/dsh-genui', hasUpdate: false, source: 'other', reason: '不是 registry 版本，无法比较' },
      ]),
      log: async () => ({ entries: [
        { at: '2026-10-16T01:22:58.865Z', action: 'install', name: 'dsh-cost-meter', spec: 'dsh-cost-meter@1.8.26', ok: true, code: 0, ms: 1573 },
        { at: '2026-10-16T01:25:11.004Z', action: 'install', name: 'dsh-nope', spec: 'dsh-nope@9.9.9', ok: false, code: 1, kind: 'not-found', message: 'registry 上没有这个包', output: 'ERR_PNPM_FETCH_404  Not found' },
      ], path: 'C:\\\\Users\\\\gzh33\\\\AppData\\\\Roaming\\\\ai.deepseek.dsh-desktop\\\\market.log' }),
      diagnose: async () => ([
        { severity: 'error', code: 'missing-install', subject: 'dsh-absent', message: '声明了依赖 dsh-absent（1.0.0），但 node_modules 里没有它', hint: '在市场里重新安装这个插件' },
        { severity: 'warn', code: 'not-registered', subject: 'dsh-half', message: 'dsh-half 已安装，但没有登记进 dsh.profile.bundles，这个 profile 不会加载它', hint: '在市场里重装一次' },
      ]),
      copyDiagnostics: async () => ({ ok: true }),
      // The GitHub stubs declare an install script on purpose: the two-step warning is the part of
      // that flow worth looking at, and a stub that returns no scripts would never show it.
      inspectGithub: async input => ({ ok: true, name: 'preview-plugin', version: '1.0.0', spec: input, scripts: ['prepare', 'postinstall'] }),
      installGithub: async input => ({ ok: true, action: 'install', name: 'preview-plugin', spec: input, code: 0, output: 'preview', bundleRegistered: true }),
      close: async () => true,
      onView: () => () => {},
    }
  </script>
`

// Inject before the page's own script so `window.__DSH_MARKET__` exists when the page reads it.
const marker = page.lastIndexOf('  <script>')
if (marker < 0) {
  process.stderr.write('preview-market: 页面里找不到脚本块\n')
  process.exit(1)
}
const preview = `${page.slice(0, marker)}${stub}${page.slice(marker)}`

const out = resolve(arg('--out', join(tmpdir(), 'dsh-market-preview', 'index.html')))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, preview, 'utf8')

process.stdout.write(`${JSON.stringify({
  ok: true,
  page: out,
  source: pagePath,
  catalog: catalogPath ?? '(内置小样本)',
  entries: entries.length,
  categories: categoryList.length,
  installedView: `file:///${out.replace(/\\/gu, '/')}#installed`,
}, null, 2)}\n`)
