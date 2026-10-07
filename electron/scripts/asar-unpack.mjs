/**
 * Turn the runtime's physical-file list into `asarUnpack` patterns.
 *
 * Why the runtime lives inside `app.asar` at all: the prepared tree is ~12,400 files, and an
 * installer that has to create each one spends its whole time in per-file overhead (measured:
 * 18.5 s for 12.4k files vs 0.2 s for the same bytes as one file). Packing it into the ASAR makes
 * it *one* file, and `asarUnpack` keeps out only what cannot be loaded from an archive:
 * executables, native modules, and shell scripts.
 *
 * `asarUnpack` entries are glob patterns matched by electron-builder, so the paths have to be
 * escaped — and builder's matcher has two quirks a naive escape gets wrong:
 *   - brace expansion ignores character classes, so `{` and `}` become `?` (one character);
 *   - a leading `!` is a negation, so it is written `@(!)`.
 * Package paths in this tree really do contain `@`, `+`, `(` and `)`, so this is not theoretical.
 */

/** Characters electron-builder's matcher treats as special. */
const SPECIAL = /[[\]{}()*?+@#]/gu

/**
 * Escape one path for use as an `asarUnpack` pattern.
 *
 * @param path - App-relative `/`-separated path.
 * @returns An equivalent glob with every special character neutralised.
 */
export function escapeAsarPattern(path) {
  const escaped = String(path).replace(SPECIAL, character => (character === '{' || character === '}' ? '?' : `[${character}]`))
  return escaped.startsWith('!') ? `@(!)${escaped.slice(1)}` : escaped
}

/**
 * Patterns for every file that must stay outside the ASAR.
 *
 * `prefix` is the path **relative to the app directory on disk** (e.g. `runtime/dsh`), because
 * electron-builder matches `asarUnpack` against the original source path and applies the FileSet's
 * `to:` only when writing the archive. In the archive the same tree appears under `dsh/...`, and its
 * unpacked twin under `app.asar.unpacked/dsh/...`.
 *
 * @param files - Paths from the manifest's `physical` list.
 * @param prefix - Source path of the runtime tree, relative to the app directory.
 * @returns Glob patterns for `asarUnpack`.
 */
export function asarUnpackPatterns(files, prefix = 'dsh') {
  return [...files].map(file => escapeAsarPattern(`${prefix}/${file}`))
}
