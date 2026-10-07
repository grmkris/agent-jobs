import { expect, test } from 'bun:test'
import { smoke } from './smoke.ts'

const origin = 'https://dev.sidequest.exchange'
const NOW = 1_791_400_000_000
const transport = (badPath?: string, override?: object): { fetcher: typeof fetch; methods: string[] } => {
  const methods: string[] = []
  const fetcher = (async (input, init) => {
    const pathname = new URL(String(input)).pathname
    if (pathname === '/mcp') {
      expect(init?.method).toBe('POST')
      const request = JSON.parse(String(init?.body)) as { method: string }
      methods.push(request.method)
      return new Response('{}', {
        status: badPath === pathname ? 200 : 401,
        headers: { 'www-authenticate': 'Bearer resource_metadata="test"' },
      })
    }
    const documents: Record<string, object> = {
      '/health': { ok: true, runtime: 'Cloudflare-Workers', network: 'monad-testnet', board: 'public' },
      '/release.json': { network: 'monad-testnet', writesOpen: true },
      '/.well-known/oauth-protected-resource': { resource: `${origin}/mcp`, authorization_servers: [origin] },
      '/.well-known/oauth-authorization-server': { issuer: origin },
      '/data/jobs': { ok: true, index: { next_block: 1, updated_at: NOW / 1000 - 60 }, jobs: [] },
    }
    return Response.json(pathname === badPath ? override : documents[pathname])
  }) as typeof fetch
  return { fetcher, methods }
}

test('smoke checks both anonymous method-specific MCP requests', async () => {
  const fake = transport()
  await smoke('dev', fake.fetcher, () => NOW)
  expect(fake.methods).toEqual(['initialize', 'tools/list'])
})

test('smoke refuses an unexpected runtime, closed writes, foreign issuer or missing bearer challenge', async () => {
  for (const [path, override] of [
    ['/health', { ok: true, runtime: 'local', network: 'monad-testnet', board: 'public' }],
    ['/release.json', { network: 'monad-testnet', writesOpen: false }],
    ['/.well-known/oauth-authorization-server', { issuer: 'https://foreign.example' }],
    [
      '/.well-known/oauth-protected-resource',
      { resource: `${origin}/mcp`, authorization_servers: ['https://foreign.example'] },
    ],
  ] as const)
    await expect(smoke('dev', transport(path, override).fetcher, () => NOW)).rejects.toThrow('mismatch')
  await expect(smoke('dev', transport('/mcp').fetcher, () => NOW)).rejects.toThrow('challenge mismatch')
})

const failure = (run: Promise<void>): Promise<string> =>
  run.then(
    () => 'passed',
    (error: unknown) => (error instanceof Error ? error.message : 'unknown'),
  )

test('smoke refuses an unbuilt or stalled index', async () => {
  const unbuilt = { ok: false, code: 'unavailable', message: 'the index is not built yet' }
  expect(await failure(smoke('dev', transport('/data/jobs', unbuilt).fetcher, () => NOW))).toBe(
    'indexer checkpoint missing',
  )
  const stale = { ok: true, index: { next_block: 1, updated_at: NOW / 1000 - 3600 }, jobs: [] }
  expect(await failure(smoke('dev', transport('/data/jobs', stale).fetcher, () => NOW))).toBe(
    'indexer checkpoint is 3600 s old',
  )
})
