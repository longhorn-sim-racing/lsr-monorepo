/**
 * Small helpers the Drive and Graph clients share. Kept apart from text.ts on purpose: the clients load
 * with the connectors (search, the Connections page, the room's actions), and text.ts pulls in the file
 * parsers (pdf.js, exceljs, mammoth), which only the sync jobs need.
 */

/** Reads a response body up to `maxBytes`; null when there's more (the caller marks it too large). Stops reading as soon as it's over */
export async function readCapped(response: Response, maxBytes: number): Promise<Buffer | null> {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {})
    return null
  }
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > maxBytes) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks, size)
}

/** Waits `ms`, or rejects as soon as `signal` aborts */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop)
      resolve()
    }, ms)
    const stop = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener("abort", stop, { once: true })
  })
}
