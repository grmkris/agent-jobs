/** The most a card downloads to turn a model; anything bigger opens as a file instead. */
const MAX_MODEL_BYTES = 20 * 1024 * 1024

/**
 * A delivered model's bytes, read cross-origin (the host must allow it: IPFS gateways and GitHub raw do, the crew's
 * sites do for models), sending no cookies or referrer and stopping at `max` bytes. Throws on anything else; the card
 * then shows the model as a file to open.
 */
export async function fetchModel(
  src: string,
  signal: AbortSignal,
  { max = MAX_MODEL_BYTES, fetcher = fetch }: { max?: number; fetcher?: typeof fetch } = {},
): Promise<ArrayBuffer> {
  if (!src.startsWith('https://')) throw new Error('model: https only')
  const res = await fetcher(src, { signal, mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' })
  if (!res.ok || res.body === null) throw new Error(`model: HTTP ${res.status}`)
  if (Number(res.headers.get('content-length') ?? 0) > max) throw new Error('model: too large')
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      void reader.cancel().catch(() => {})
      throw new Error('model: too large')
    }
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out.buffer
}
