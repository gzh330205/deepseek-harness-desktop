/**
 * Pure helpers for reading dsh's startup output.
 *
 * Ported from `redact_auth_token` / `parse_dsh_web_auth_url` in the Tauri shell.
 * The ordering bug those tests guard against is preserved: redaction must never
 * feed navigation, or the page lands on `?token=***` and stays at 401.
 */

/** Replace the one-time token value with `***`, keeping the rest of the line intact. */
export function redactAuthToken(line: string): string {
  const index = line.indexOf('token=')
  if (index < 0) return line
  const valueStart = index + 'token='.length
  let valueEnd = valueStart
  while (valueEnd < line.length && !/[\s&"'<>]/u.test(line[valueEnd] ?? '')) valueEnd += 1
  return `${line.slice(0, index)}token=***${line.slice(valueEnd)}`
}

/**
 * Extract the one-time authentication URL from a dsh stdout line.
 * Only loopback URLs carrying a non-empty, non-redacted `token` are accepted.
 */
export function parseDshWebAuthUrl(line: string): URL | undefined {
  const start = line.indexOf('http://')
  if (start < 0) return undefined
  const rest = line.slice(start)
  const end = rest.search(/\s/u)
  const candidate = end < 0 ? rest : rest.slice(0, end)
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return undefined
  }
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) return undefined
  const token = url.searchParams.get('token')
  if (token === null || token === '' || token === '***') return undefined
  return url
}

/** The same URL without the one-time token: the address the page should end up on. */
export function bareUrl(url: URL): string {
  const copy = new URL(url.href)
  copy.searchParams.delete('token')
  copy.search = copy.search === '?' ? '' : copy.search
  return copy.href
}
