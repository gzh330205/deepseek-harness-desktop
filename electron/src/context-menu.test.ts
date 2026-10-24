import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { copyMenuTemplate, isCopyableShellUrl } from './context-menu.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

const SHELL_PAGES = ['usage-ui', 'pocket-ui', 'settings-ui', 'market-ui'] as const

test('only shell-owned file documents get the copy menu', () => {
  const documents = ['usage', 'pocket', 'settings', 'market', 'mcp']
  for (const document of documents) {
    assert.equal(isCopyableShellUrl(`file:///C:/app/dist/${document}/index.html`), true, document)
  }
  // The product window is served over loopback and keeps its own behaviour.
  assert.equal(isCopyableShellUrl('http://127.0.0.1:41729/'), false)
  assert.equal(isCopyableShellUrl('file:///C:/app/dist/usage-popover/index.html'), false)
  assert.equal(isCopyableShellUrl('file:///C:/app/dist/titlebar/index.html'), false)
  assert.equal(isCopyableShellUrl('not a url'), false)
})

test('editable fields get the full clipboard set', () => {
  const roles = copyMenuTemplate({ isEditable: true, selectionText: '' })
    .flatMap((item) => ('role' in item && item.role !== undefined ? [item.role] : []))
  assert.deepEqual(roles, ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'])
})

test('a text selection offers copy and select all', () => {
  const items = copyMenuTemplate({ isEditable: false, selectionText: '  token  ' })
  const roles = items.flatMap((item) => ('role' in item && item.role !== undefined ? [item.role] : []))
  assert.deepEqual(roles, ['copy', 'selectAll'])
  assert.ok(items.some((item) => item.type === 'separator'))
})

test('a plain right-click still offers select all', () => {
  const items = copyMenuTemplate({ isEditable: false, selectionText: '   ' })
  assert.deepEqual(items.map((item) => item.role), ['selectAll'])
})

test('shell pages allow selecting text while their chrome does not', () => {
  for (const page of SHELL_PAGES) {
    const source = readFileSync(join(HERE, page, 'index.html'), 'utf8')
    assert.match(source, /user-select:\s*text/u, `${page} must allow text selection`)
    assert.match(source, /button[^{}]*\{[^}]*user-select:\s*none/u, `${page} must keep buttons unselectable`)
  }
})

test('the main process installs the menu before any window exists', () => {
  const source = readFileSync(join(HERE, 'main.ts'), 'utf8')
  assert.match(source, /import \{ installCopyContextMenus \} from '\.\/context-menu-install\.ts'/u)
  const ready = source.indexOf('app.whenReady()')
  const install = source.indexOf('installCopyContextMenus()')
  assert.ok(ready >= 0 && install > ready, 'menu must be installed inside whenReady, before boot()')
  assert.ok(source.indexOf('installCopyContextMenus()') < source.indexOf('await boot()'))
})
