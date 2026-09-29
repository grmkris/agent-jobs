import { describe, expect, it } from 'vitest'
import { createBoardApi } from './client.ts'

const fakeFetch = (routes: Record<string, (body: unknown, headers: Record<string, string>) => unknown>) => {
  const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = []
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body))
    calls.push({ url, body, headers })
    const route = Object.entries(routes).find(([k]) => url.endsWith(k))
    if (route === undefined) return new Response(JSON.stringify({ ok: false, code: 'not-found', message: url }), { status: 404 })
    return new Response(JSON.stringify(route[1](body, headers)), { status: 200 })
  }) as typeof fetch
  return { f, calls }
}

describe('createBoardApi', () => {
  it('addresses a board route, keeps the session in the given storage and sends it as a bearer', async () => {
    const { f, calls } = fakeFetch({
      '/b/monad-pet/api/auth_challenge': () => ({ ok: true, result: { message: 'pet.example wants you to sign in' } }),
      '/b/monad-pet/api/auth_login': () => ({ ok: true, result: { session: 'tok', address: '0x1', expiresAt: 1, boardId: 'monad-pet' } }),
      '/b/monad-pet/api/whoami': (_b, h) => ({ ok: true, result: { bearer: h.authorization } }),
      '/data/jobs?board=monad-pet': () => ({ ok: true, jobs: [] }),
    })
    const api = createBoardApi({ baseUrl: 'https://api.example/', boardId: 'monad-pet', storage: null, fetch: f })
    expect(api.apiBase).toBe('https://api.example/b/monad-pet')
    const r = await api.signIn('0x1', async () => '0xsig')
    expect(r.session).toBe('tok')
    expect(api.session()).toBe('tok')
    expect(await api.tool('whoami')).toEqual({ bearer: 'Bearer tok' })
    expect(await api.jobs()).toEqual({ ok: true, jobs: [] })
    expect(calls[0]?.body).toEqual({ address: '0x1' })
    expect(calls[1]?.body).toEqual({ message: 'pet.example wants you to sign in', signature: '0xsig' })
  })

  it('the public board has no prefix, and an unauthenticated reply clears the session', async () => {
    const { f } = fakeFetch({ '/api/get_task': () => ({ ok: false, code: 'unauthenticated', message: 'sign in' }) })
    const api = createBoardApi({ baseUrl: '', storage: null, fetch: f })
    api.setSession('stale')
    await expect(api.tool('get_task', { taskId: 'x' })).rejects.toThrow(/sign in/)
    expect(api.session()).toBeNull()
  })

  it('signInWith uses personal_sign with the hex message and the address', async () => {
    const { f } = fakeFetch({
      '/api/auth_challenge': () => ({ ok: true, result: { message: 'hi' } }),
      '/api/auth_login': (b) => ({ ok: true, result: { session: 's', address: '0x1', expiresAt: 1, boardId: 'public', echo: b } }),
    })
    const api = createBoardApi({ baseUrl: '', storage: null, fetch: f })
    const seen: unknown[] = []
    const provider = { request: async (a: { method: string; params?: unknown[] }) => { seen.push(a); return '0xsigned' } }
    const r = (await api.signInWith(provider, '0x1')) as unknown as { echo: { signature: string } }
    expect(seen[0]).toEqual({ method: 'personal_sign', params: ['0x6869', '0x1'] })
    expect(r.echo.signature).toBe('0xsigned')
  })
})
