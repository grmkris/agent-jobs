import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

type Stage = 'dev' | 'prod'
interface StageFile {
  readonly stage: Stage
  readonly network: string
  readonly origin: string
}

const root = resolve(import.meta.dirname, '../..')
const readStage = (stage: Stage): StageFile => {
  const file = JSON.parse(readFileSync(resolve(root, `infra/${stage}.json`), 'utf8')) as Partial<StageFile>
  if (
    file.stage !== stage ||
    typeof file.network !== 'string' ||
    typeof file.origin !== 'string' ||
    !file.origin.startsWith('https://')
  )
    throw new Error(`invalid infra/${stage}.json`)
  return file as StageFile
}

const body = async (response: Response): Promise<Record<string, unknown>> => {
  try {
    const value: unknown = await response.json()
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('JSON object expected')
    return value as Record<string, unknown>
  } catch {
    throw new Error(`invalid JSON response (HTTP ${response.status})`)
  }
}
export const smoke = async (stage: Stage, fetcher: typeof fetch = fetch): Promise<void> => {
  const infra = readStage(stage)
  const get = (path: string) =>
    fetcher(new URL(path, infra.origin), { redirect: 'error', signal: AbortSignal.timeout(20_000) })
  const health = await get('/health')
  if (health.status !== 200) throw new Error(`health HTTP ${health.status}`)
  const healthBody = await body(health)
  const expectedHealth = { ok: true, runtime: 'Cloudflare-Workers', network: infra.network, board: 'public' }
  for (const [key, value] of Object.entries(expectedHealth))
    if (healthBody[key] !== value) throw new Error(`health ${key} mismatch`)

  const release = await get('/release.json')
  if (release.status !== 200) throw new Error(`release HTTP ${release.status}`)
  const releaseBody = await body(release)
  if (releaseBody.network !== infra.network || releaseBody.writesOpen !== true)
    throw new Error('release network or writesOpen mismatch')

  const protectedResource = await get('/.well-known/oauth-protected-resource')
  const protectedBody = await body(protectedResource)
  if (
    protectedResource.status !== 200 ||
    !Array.isArray(protectedBody.authorization_servers) ||
    !protectedBody.authorization_servers.includes(infra.origin) ||
    (protectedBody.issuer !== undefined && protectedBody.issuer !== infra.origin) ||
    protectedBody.resource !== `${infra.origin}/mcp`
  )
    throw new Error('protected resource discovery mismatch')
  const authorization = await get('/.well-known/oauth-authorization-server')
  const authorizationBody = await body(authorization)
  if (authorization.status !== 200 || authorizationBody.issuer !== infra.origin)
    throw new Error('authorization discovery mismatch')

  for (const method of ['initialize', 'tools/list']) {
    const response = await fetcher(new URL('/mcp', infra.origin), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: method,
        method,
        params: method === 'initialize' ? { protocolVersion: '2025-06-18' } : {},
      }),
    })
    const challenge = response.headers.get('www-authenticate')
    if (response.status !== 401 || challenge === null || !challenge.startsWith('Bearer '))
      throw new Error(`anonymous ${method} challenge mismatch`)
    await response.body?.cancel()
  }
  console.log(`note ${stage}: indexer checkpoint is not exposed by a public origin endpoint; skipped`)
  console.log(`ok ${stage} ${infra.origin}`)
}

if (
  process.env.NODE_ENV !== 'test' &&
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const stage = process.argv[2]
  if (stage !== 'dev' && stage !== 'prod') {
    console.error('usage: bun scripts/ci/smoke.ts dev|prod')
    process.exitCode = 2
  } else
    smoke(stage).catch((error: unknown) => {
      console.error(`smoke failed: ${error instanceof Error ? error.message : 'unknown error'}`)
      process.exitCode = 1
    })
}
