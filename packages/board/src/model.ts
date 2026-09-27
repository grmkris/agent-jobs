/**
 * One call to an OpenAI-compatible chat endpoint (the Vercel AI Gateway by default), returning the first JSON object
 * in the answer. Shared by Jev screening and the arbiter's proposal step; both treat the model's output as a
 * proposal to validate, never as an action.
 */
export interface ModelEndpoint {
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
}

/** Asks up to twice: a reasoning model occasionally ends without its JSON answer. */
export async function askJson<T>(
  endpoint: ModelEndpoint,
  system: string,
  user: string,
  opts: { maxTokens?: number; timeoutMs?: number } = {},
): Promise<T> {
  try {
    return await askJsonOnce<T>(endpoint, system, user, opts)
  } catch (e) {
    if (!(e as Error).message.includes('no JSON')) throw e
    return askJsonOnce<T>(endpoint, system, user, opts)
  }
}

async function askJsonOnce<T>(
  endpoint: ModelEndpoint,
  system: string,
  user: string,
  opts: { maxTokens?: number; timeoutMs?: number },
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 90_000)
  try {
    const res = await fetch(`${endpoint.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.apiKey}` },
      body: JSON.stringify({
        model: endpoint.model,
        // The gateway's reasoning models think before answering: muse-spark-1.3 used ~1.7-2k reasoning tokens on a
        // one-offer screen and ran out at 2048 (finish_reason "length", empty answer). Leave room for both.
        max_tokens: opts.maxTokens ?? 8192,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    })
    if (!res.ok) throw new Error(`model endpoint: HTTP ${res.status}`)
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const text = body.choices?.[0]?.message?.content ?? ''
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error('model answer has no JSON object')
    return JSON.parse(text.slice(start, end + 1)) as T
  } finally {
    clearTimeout(timer)
  }
}
