import { describe, expect, it } from 'vitest'
import { isApiPath } from './routing.ts'
import worker from './worker.ts'

const INDEX = '<!doctype html><title>Hireling</title>'

function env(files: Record<string, string> = {}) {
  const api: string[] = []
  return {
    api,
    env: {
      API: {
        fetch: async (r: Request) => {
          api.push(new URL(r.url).pathname)
          return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
        },
      },
      // Cloudflare's single-page-application fallback: a known file, else index.html with 200.
      ASSETS: {
        fetch: async (r: Request) => {
          const path = new URL(r.url).pathname
          const type = path.endsWith('.png') ? 'image/png' : path.endsWith('.webmanifest') ? 'application/octet-stream' : 'text/html'
          return path in files ? new Response(files[path], { headers: { 'content-type': type } }) : new Response(INDEX, { headers: { 'content-type': 'text/html' } })
        },
      },
    },
  }
}

const get = (path: string, e: ReturnType<typeof env>) => worker.fetch(new Request(`https://testnet.hireling.xyz${path}`), e.env)

describe('explore worker routing', () => {
  it('sends the board API to the API, under a board prefix too', () => {
    for (const p of ['/api/get_task', '/data/jobs', '/offers/0xab.json', '/mcp', '/health']) {
      expect(isApiPath(p), p).toBe(true)
      expect(isApiPath(`/b/monad-pet${p}`), `/b/monad-pet${p}`).toBe(true)
    }
  })

  it("serves a board's pages from the app", () => {
    for (const p of ['/b/monad-pet', '/b/monad-pet/', '/b/monad-pet/job/54', '/b/monad-pet/publish', '/b/monad-pet/quotes/3', '/b/monad-pet/agent/1942']) {
      expect(isApiPath(p), p).toBe(false)
    }
  })

  it('loads a board page as the SPA, not the API', async () => {
    const e = env()
    const res = await get('/b/monad-pet/job/54', e)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(INDEX)
    expect(e.api).toEqual([])
    expect(res.headers.get('x-frame-options')).toBe('DENY')
  })

  it('proxies a board tool call', async () => {
    const e = env()
    await get('/b/monad-pet/api/get_board', e)
    expect(e.api).toEqual(['/b/monad-pet/api/get_board'])
  })

  it('answers a missing file with 404, not the app page', async () => {
    const res = await get('/apple-touch-icon.png', env())
    expect(res.status).toBe(404)
  })

  it('serves existing files, the manifest with its media type', async () => {
    const e = env({ '/apple-touch-icon.png': 'png', '/manifest.webmanifest': '{}' })
    const icon = await get('/apple-touch-icon.png', e)
    expect(icon.status).toBe(200)
    expect(icon.headers.get('content-type')).toBe('image/png')
    const manifest = await get('/manifest.webmanifest', e)
    expect(manifest.headers.get('content-type')).toBe('application/manifest+json')
  })
})
