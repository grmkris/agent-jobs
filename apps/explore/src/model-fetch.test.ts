import { describe, expect, it } from 'vitest'
import { fetchModel } from './model-fetch.ts'

/** A fetch double answering one response, recording what it was asked. */
function answering(response: () => Response) {
  const seen: RequestInit[] = []
  // SAFETY: the double takes the (url, init) pair fetchModel passes and returns a Response.
  const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
    seen.push(init ?? {})
    return response()
  }) as typeof fetch
  return { fetcher, seen }
}
const signal = new AbortController().signal

describe('fetchModel', () => {
  it('reads the bytes cross-origin without cookies or referrer', async () => {
    const { fetcher, seen } = answering(() => new Response(new Uint8Array([1, 2, 3])))
    expect(new Uint8Array(await fetchModel('https://m.example/a.stl', signal, { fetcher }))).toEqual(
      new Uint8Array([1, 2, 3]),
    )
    expect(seen[0]).toMatchObject({ mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' })
  })

  it('refuses non-https, failed reads and anything past the cap, declared or streamed', async () => {
    const ok = answering(() => new Response('x'))
    await expect(fetchModel('http://m.example/a.stl', signal, { fetcher: ok.fetcher })).rejects.toThrow('https only')
    expect(ok.seen).toEqual([])
    await expect(
      fetchModel(
        'https://m.example/a.stl',
        signal,
        answering(() => new Response('no', { status: 403 })),
      ),
    ).rejects.toThrow('HTTP 403')
    const declared = answering(() => new Response('x', { headers: { 'content-length': '999' } }))
    await expect(fetchModel('https://m.example/a.stl', signal, { max: 10, fetcher: declared.fetcher })).rejects.toThrow(
      'too large',
    )
    const streamed = answering(() => new Response('x'.repeat(50)))
    await expect(fetchModel('https://m.example/a.stl', signal, { max: 10, fetcher: streamed.fetcher })).rejects.toThrow(
      'too large',
    )
  })
})
