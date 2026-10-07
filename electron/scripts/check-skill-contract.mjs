/**
 * Check the built-in skill against the *real* `@deepseek-ai/dsh-skill` registry.
 *
 * `browser-skill.test.ts` pins the field contract in the repo (portable, runs everywhere). This
 * script is the other half: it loads the registry that actually ships with a DSH install, drives
 * `register()` → `get()`, and therefore fails the moment DSH's load-time requirements change.
 * Run it after updating the bundled DSH runtime (see docs/sidebar-browser-integration.md §9).
 *
 * It also registers a deliberately broken copy (no `source`) and asserts that the registry
 * rejects it — so a green run proves the check has teeth rather than proving nothing happened.
 *
 * Usage (Node 22+/any ESM host):
 *   node electron/scripts/check-skill-contract.mjs
 * With a non-default DSH install, point at its entry so the sibling node_modules is found:
 *   DSH_DESKTOP_DSH_ENTRY='...\@deepseek-ai\dsh\lib\bin.js' node electron/scripts/check-skill-contract.mjs
 */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')

/** Locate the DSH runtime's `node_modules`, where `dsh-skill` and `cordis` live. */
function nodeModulesDir() {
  const candidates = []
  const entry = process.env.DSH_DESKTOP_DSH_ENTRY
  if (typeof entry === 'string' && entry !== '') {
    // .../node_modules/@deepseek-ai/dsh/lib/bin.js → .../node_modules
    candidates.push(resolve(dirname(entry), '..', '..', '..', '..'))
  }
  // Installed builds keep the runtime inside the app ASAR, with the physical half beside it.
  candidates.push('D:\\Program Files\\DSH Desktop\\resources\\app.asar.unpacked\\dsh\\node_modules')
  candidates.push('D:\\Program Files\\DSH Desktop\\resources\\app.asar\\dsh\\node_modules')
  candidates.push('D:\\Program Files\\DSH Desktop\\resources\\runtime\\dsh\\node_modules')
  for (const candidate of candidates) {
    if (existsSync(join(candidate, '@deepseek-ai', 'dsh-skill', 'lib', 'index.js'))) return candidate
  }
  return undefined
}

const nodeModules = nodeModulesDir()
if (nodeModules === undefined) {
  console.log('SKILL_CONTRACT SKIP（找不到 dsh-skill：设置 DSH_DESKTOP_DSH_ENTRY 后重试）')
  process.exit(0)
}

const { Context } = await import(pathToFileURL(join(nodeModules, '@deepseek-ai', 'cordis', 'lib', 'index.js')).href)
const skillPackage = await import(pathToFileURL(join(nodeModules, '@deepseek-ai', 'dsh-skill', 'lib', 'index.js')).href)
const { BROWSER_SKILL } = await import(pathToFileURL(join(repoRoot, 'src-tauri', 'resources', 'dsh-desktop-shell', 'browser-skill.js')).href)

/** Mount the real registry on a real Cordis context — the same composition `dsh web` builds. */
async function mountRegistry() {
  const ctx = new Context()
  const fork = ctx.plugin(skillPackage.default ?? skillPackage.SkillRegistry)
  if (typeof fork?.then === 'function') await fork
  await new Promise((resolve) => setTimeout(resolve, 50))
  const registry = ctx.get?.('skills') ?? ctx.skills
  if (registry === undefined) throw new Error('Cordis 上下文里没有 skills 服务')
  return registry
}

const problems = []

// 1) Our real skill must list, load, and come back with its instructions.
{
  const registry = await mountRegistry()
  registry.register(BROWSER_SKILL)
  const summaries = await registry.list({})
  if (!summaries.some((entry) => entry.name === BROWSER_SKILL.name)) {
    problems.push(`技能 ${BROWSER_SKILL.name} 没有出现在目录里`)
  }
  const loaded = await registry.get(BROWSER_SKILL.name, {})
  if (loaded === undefined) problems.push('get() 返回 undefined：技能加载不到')
  else {
    if (loaded.content !== BROWSER_SKILL.content) problems.push('get() 返回的内容与注册的不一致')
    if (loaded.source !== BROWSER_SKILL.source) problems.push(`get() 丢掉了 source（${String(loaded.source)}）`)
  }
}

// 2) The check must be able to fail: a copy without `source` has to be rejected with the exact
//    message users saw when this field was missing.
{
  const registry = await mountRegistry()
  const broken = { ...BROWSER_SKILL }
  delete broken.source
  registry.register(broken)
  let rejected = false
  try {
    await registry.get(BROWSER_SKILL.name, {})
  } catch (error) {
    rejected = /source must be a string/u.test(String(error?.message ?? error))
  }
  if (!rejected) problems.push('缺少 source 的定义竟然加载成功了——这个核对脚本没有鉴别力')
}

if (problems.length > 0) {
  console.log(`SKILL_CONTRACT FAIL\n- ${problems.join('\n- ')}`)
  process.exit(1)
}
console.log(`SKILL_CONTRACT PASS（${BROWSER_SKILL.name} 能注册、能加载、内容一致；缺 source 会被拒）`)
