import { readFileSync } from 'node:fs'
import { createServer as createHttpServer, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { build, createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AgentStartLink } from './src/components/AgentStartLink.tsx'
import { startGuide } from './start-guide-plugin.ts'
import { renderStartGuide } from './start-guide.ts'
import worker from './worker.ts'

const source = readFileSync(new URL('../../skill/start.md', import.meta.url), 'utf8')
const routes = [
  ['/start.md', 'text/markdown; charset=utf-8'],
  ['/llms.txt', 'text/plain; charset=utf-8'],
] as const

describe('agent start guide development routes', () => {
  let vite: ViteDevServer
  let http: Server
  let origin: string

  beforeAll(async () => {
    vite = await createServer({
      configFile: false,
      plugins: [startGuide()],
      server: { middlewareMode: true },
      optimizeDeps: { noDiscovery: true },
    })
    http = createHttpServer(vite.middlewares)
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    const address = http.address()
    if (address === null || typeof address === 'string') throw new Error('No development server port')
    origin = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await vite?.close()
    if (http !== undefined) await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()))
  })

  it.each(routes)('serves %s from the repo with %s', async (path, type) => {
    const response = await fetch(`${origin}${path}?reader=agent`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(type)
    expect(await response.text()).toBe(renderStartGuide(source, origin))
  })

  it.each(routes)('answers HEAD %s without a body', async (path, type) => {
    const response = await fetch(`${origin}${path}`, { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(type)
    expect(await response.text()).toBe('')
  })
})

describe('agent start guide built assets and deployed routes', () => {
  let files: Record<string, string>

  beforeAll(async () => {
    const result = await build({
      configFile: false,
      root: fileURLToPath(new URL('.', import.meta.url)),
      plugins: [startGuide()],
      logLevel: 'silent',
      build: {
        write: false,
        minify: false,
        rollupOptions: { input: fileURLToPath(new URL('start-guide.ts', import.meta.url)) },
      },
    })
    if ('on' in result) throw new Error('Unexpected build watcher')
    const output = Array.isArray(result) ? result.flatMap((bundle) => bundle.output) : result.output
    files = Object.fromEntries(output.flatMap((file) => file.type === 'asset' && typeof file.source === 'string' ? [[`/${file.fileName}`, file.source]] : []))
  })

  const api = vi.fn(async () => new Response('unexpected API request', { status: 500 }))
  const env = () => ({
    API: { fetch: api },
    ASSETS: {
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname
        const body = files[path]
        return body === undefined
          ? new Response('<html>SPA fallback</html>', { headers: { 'Content-Type': 'text/html' } })
          : new Response(request.method === 'HEAD' ? null : body, { headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(Buffer.byteLength(body)),
            ETag: 'template-etag',
          } })
      },
    },
  })

  it('emits both names from the same single source document', () => {
    expect(files['/start.md']).toBe(source)
    expect(files['/llms.txt']).toBe(source)
  })

  it.each(['https://testnet.hireling.xyz', 'https://preview.example:8443'])('serves identical bodies with URLs at %s', async (origin) => {
    const bodies = []
    for (const [path, type] of routes) {
      const response = await worker.fetch(new Request(`${origin}${path}?reader=agent`), env())
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe(type)
      expect(response.headers.get('content-length')).toBeNull()
      expect(response.headers.get('etag')).toBeNull()
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      const body = await response.text()
      expect(body).toBe(renderStartGuide(source, origin))
      expect(body).not.toContain('{{HIRELING_ORIGIN}}')
      expect(body).toContain(`claude mcp add --transport http hireling ${origin}/mcp`)
      expect(body).toContain('# Set yourself up on Hireling')
      expect(body).toContain(`${origin}/skills/connector/SKILL.md`)
      expect(body).toContain(`${origin}/skills/worker/SKILL.md`)
      expect(body).toContain(`${origin}/skills/publisher/SKILL.md`)
      expect(body).toContain('**work**, **hire**, or **work and hire**')
      expect(body).toContain('Should I work, hire, or both?')
      expect(body).toContain('never assume a role')
      expect(body).toContain('`hireling:work`, `hireling:hire`,')
      expect(body).toContain('| WORK | Find jobs, quote/apply, deliver.')
      expect(body).toContain('| HIRE | Post jobs or request quotes, pick a worker, review/approve.')
      expect(body).toContain('weekly allowance pulled from wallet[0]')
      expect(body).toContain('above it becomes an Approval in Explore')
      expect(body).toContain('bad delivery can slash it')
      expect(body).toContain('small creator bond')
      const loop = body.split('## 5. WORK only:')[1]?.split('## 6. HIRE:')[0]
      expect(loop).toBeDefined()
      expect(loop?.match(/WORK only: follow the worker skill/g)).toHaveLength(3)
      expect(loop?.match(/do not publish hires/g)).toHaveLength(3)
      expect(body).toContain('`request_quotes` → `list_quotes` →')
      expect(body).toContain('call `approve_work` only after checking the delivered work')
      bodies.push(body)
    }
    expect(bodies[0]).toBe(bodies[1])
    expect(api).not.toHaveBeenCalled()
  })

  it.each(routes)('answers deployed HEAD %s without a body', async (path, type) => {
    const response = await worker.fetch(new Request(`https://testnet.hireling.xyz${path}`, { method: 'HEAD' }), env())
    expect(response.headers.get('content-type')).toBe(type)
    expect(await response.text()).toBe('')
  })

  it.each(routes)('does not serve the SPA as a missing %s document', async (path) => {
    const missing = { ...env(), ASSETS: { fetch: async () => new Response('<html>SPA fallback</html>', { headers: { 'Content-Type': 'text/html' } }) } }
    const response = await worker.fetch(new Request(`https://testnet.hireling.xyz${path}`), missing)
    expect(response.status).toBe(404)
    expect(await response.text()).toBe('not found')
  })
})

describe('Explore onboarding examples', () => {
  it.each(['https://testnet.hireling.xyz', 'https://preview.example:8443'])('offers all three explicit role instructions at %s', (origin) => {
    vi.stubGlobal('window', { location: { origin } })
    try {
      const html = renderToStaticMarkup(createElement(AgentStartLink))
      expect(html).toContain(`href="${origin}/start.md"`)
      for (const role of ['work', 'hire', 'work and hire']) {
        expect(html).toContain(`Read ${origin}/start.md and set yourself up to ${role} on Hireling.`)
        expect(html).toContain(`aria-label="Copy ${role} setup instruction"`)
      }
      expect(html.match(/<button /g)).toHaveLength(4)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
