/**
 * A timeout for one awaited step.
 *
 * Used where a promise can hang *without* the OS or the network noticing: an
 * `executeJavaScript` against a renderer that never produced a document, for instance. Without a
 * bound, a single wedged page blocks a tool call for the whole model turn.
 *
 * The underlying promise keeps running (it cannot be cancelled here); the point is that the
 * caller gets an actionable error instead of silence.
 */

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return await promise
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => { reject(new Error(message)) }, timeoutMs)
      promise.then(
        (value) => { resolve(value) },
        (error: unknown) => { reject(error instanceof Error ? error : new Error(String(error))) },
      )
    })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
