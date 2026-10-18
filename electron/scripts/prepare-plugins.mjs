/**
 * Copy the plugins that ship with the shell into `resources/plugins`.
 *
 * The shell injects these instead of having the user install them from the market, so every start
 * can rely on them being present. Only the **runtime** half is copied:
 *
 * - the plugin's own compiled files (`index.js`, `lib/`, `locale/`), not sources/tests/docs;
 * - the transitive runtime dependency closure resolved from the plugin's `node_modules/.pnpm`,
 *   flattened into `node_modules/<name>`.
 *
 * The dev dependencies are why copying the source directories as-is would be ~110 MB: jsdom,
 * esbuild, react, typescript are build-time only. The actual closure is schemastery + cosmokit +
 * @standard-schema/spec — a fraction of a megabyte per plugin.
 */

import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const destination = resolve(root, '..', 'resources', 'plugins')
const source = resolve(process.env.DSH_PLUGINS_SOURCE ?? 'D:\\workspace\\research\\deepseek-harness-plugins')

/** Plugins the shell owns. The ONE-WAY usage window and MCP/Skills are shell windows now. */
const PACKAGES = ['dsh-git-panel', 'dsh-run-env-manager', 'dsh-workspace-category-manager', 'dsh-sidebar-width']

/** Files that are part of a plugin's runtime surface. Everything else is source/build material. */
const KEEP_FILES = ['package.json', 'index.js', 'cordis.patch.yml']
const KEEP_DIRECTORIES = ['lib', 'locale', 'skills', 'assets']

if (!existsSync(source)) {
  console.error(`[plugins] 找不到插件源码目录：${source}（可用 DSH_PLUGINS_SOURCE 覆盖）`)
  process.exit(1)
}

/** Index every package present in a pnpm virtual store, by name. */
async function indexStore(nodeModules) {
  const index = new Map()
  const pnpm = join(nodeModules, '.pnpm')
  if (!existsSync(pnpm)) return index
  for (const entry of await readdir(pnpm)) {
    const store = join(pnpm, entry, 'node_modules')
    if (!existsSync(store)) continue
    for (const item of await readdir(store)) {
      if (item.startsWith('.')) continue
      if (item.startsWith('@')) {
        for (const inner of await readdir(join(store, item))) index.set(`${item}/${inner}`, join(store, item, inner))
      } else {
        index.set(item, join(store, item))
      }
    }
  }
  return index
}

/** Walk declared dependencies transitively; returns `Map<name, sourceDir>`. */
async function closure(pluginDir) {
  const nodeModules = join(pluginDir, 'node_modules')
  const index = await indexStore(nodeModules)
  const manifest = JSON.parse(await readFile(join(pluginDir, 'package.json'), 'utf8'))
  const pending = Object.keys(manifest.dependencies ?? {})
  const found = new Map()
  while (pending.length > 0) {
    const name = pending.shift()
    if (found.has(name)) continue
    const directory = index.get(name) ?? (existsSync(join(nodeModules, name)) ? join(nodeModules, name) : undefined)
    if (directory === undefined) {
      console.warn(`[plugins] ${manifest.name}: 运行时依赖 ${name} 未在 node_modules 中找到，跳过（可能由构建期打包）`)
      continue
    }
    found.set(name, directory)
    const dependencyManifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    for (const dependency of Object.keys(dependencyManifest.dependencies ?? {})) pending.push(dependency)
  }
  return found
}

async function copyDirectory(from, to) {
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.bin') continue
    const sourcePath = join(from, entry.name)
    const targetPath = join(to, entry.name)
    if (entry.isDirectory()) await cp(sourcePath, targetPath, { recursive: true })
    else if (entry.isFile()) await cp(sourcePath, targetPath)
  }
}

let totalFiles = 0
let totalBytes = 0
await rm(destination, { recursive: true, force: true })
await mkdir(destination, { recursive: true })

for (const name of PACKAGES) {
  const pluginDir = join(source, name)
  if (!existsSync(join(pluginDir, 'package.json'))) {
    console.error(`[plugins] 缺少插件：${pluginDir}`)
    process.exit(1)
  }
  const target = join(destination, name)
  await mkdir(target, { recursive: true })

  for (const file of KEEP_FILES) {
    if (existsSync(join(pluginDir, file))) await cp(join(pluginDir, file), join(target, file))
  }
  for (const directory of KEEP_DIRECTORIES) {
    if (existsSync(join(pluginDir, directory))) await cp(join(pluginDir, directory), join(target, directory), { recursive: true })
  }
  if (!existsSync(join(target, 'index.js'))) {
    console.error(`[plugins] ${name}: 没有 index.js，源码目录不完整`)
    process.exit(1)
  }

  // Runtime dependency closure, flattened into the plugin's own node_modules.
  const packages = await closure(pluginDir)
  for (const [dependency, directory] of packages) {
    await copyDirectory(directory, join(target, 'node_modules', dependency))
  }

  let files = 0
  let bytes = 0
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) { files += 1; bytes += (await stat(path)).size }
    }
  }
  await walk(target)
  totalFiles += files
  totalBytes += bytes
  console.log(`[plugins] ${name}: ${files} files, ${(bytes / 1024 / 1024).toFixed(2)} MiB, deps=${[...packages.keys()].join(', ')}`)
}

// A manifest so the packaged preflight (and a human) can tell what was baked in.
await writeFile(join(destination, 'plugins.json'), `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  source,
  packages: PACKAGES,
  files: totalFiles,
  bytes: totalBytes,
}, null, 2)}\n`, 'utf8')

console.log(`[plugins] ready: ${PACKAGES.length} plugins, ${totalFiles} files, ${(totalBytes / 1024 / 1024).toFixed(2)} MiB → ${relative(process.cwd(), destination)}`)
