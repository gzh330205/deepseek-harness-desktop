/**
 * Pure decisions for the copy/paste context menu in the shell's own windows.
 *
 * Electron has no built-in context menu, and the shell pages deliberately had
 * `user-select: none` for an app-like feel — which also made every value in the
 * usage / pocket / market windows impossible to copy. The install side lives in
 * `context-menu-install.ts`; this file stays free of `electron` imports so the
 * tests can run under plain `node --test`.
 */

import type { MenuItemConstructorOptions } from 'electron'

import { SHELL_PAGE_DOCUMENTS } from './constants.ts'

/** Documents that get a copy menu: the shell pages plus the market window. */
export const COPYABLE_SHELL_DOCUMENTS = [...SHELL_PAGE_DOCUMENTS, '/market/index.html'] as const

export type CopyMenuItem = MenuItemConstructorOptions

export interface CopyMenuParams {
  /** True when the right-click landed in an input/textarea/contenteditable. */
  isEditable: boolean
  /** The current selection, as Electron reports it. */
  selectionText: string
}

/**
 * Only `file://` shell documents qualify. The DSH product window loads the
 * loopback HTTP app and must keep its own context-menu behaviour untouched.
 */
export function isCopyableShellUrl(rawUrl: string): boolean {
  if (!rawUrl.startsWith('file://')) return false
  let pathname: string
  try {
    pathname = new URL(rawUrl).pathname
  } catch {
    return false
  }
  return COPYABLE_SHELL_DOCUMENTS.some((document) => pathname.endsWith(document))
}

/**
 * Editable fields get the full clipboard set; a selection gets copy + select
 * all; a plain right-click still offers select-all so keyboard-free users can
 * start a selection. Never returns an empty menu.
 */
export function copyMenuTemplate(params: CopyMenuParams): CopyMenuItem[] {
  if (params.isEditable) {
    return [
      { role: 'undo', label: '撤销' },
      { role: 'redo', label: '重做' },
      { type: 'separator' },
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' },
      { role: 'selectAll', label: '全选' },
    ]
  }
  if (params.selectionText.trim().length > 0) {
    return [
      { role: 'copy', label: '复制' },
      { type: 'separator' },
      { role: 'selectAll', label: '全选' },
    ]
  }
  return [{ role: 'selectAll', label: '全选' }]
}
