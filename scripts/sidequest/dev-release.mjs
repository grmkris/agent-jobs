import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { parseEnv } from 'node:util'
import { createPublicClient, http, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { loadDevAuthority } from './dev-authority.mjs'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
const sharedPaths = new Set(['apps/indexer/src/run-record.test.ts', 'apps/indexer/src/worker.ts', 'packages/indexer/src/indexer.test.ts', 'packages/indexer/src/indexer.ts'])
const artifacts = path => path.startsWith('.artifact-video/') || path.startsWith('packages/sdk/scripts/.local/')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

export function assertCheckout({ branch, staged, dirty, unknown }) {
  if (branch !== 'main') throw new Error('checkout-not-main')
  if (staged.length || dirty.some(path => !sharedPaths.has(path)) || unknown.some(path => !artifacts(path))) throw new Error('uncommitted-release-source')
}

export function validateCensus(infra, census, state) {
  if (census.zone.id !== infra.cloudflare.zoneId || census.zone.account.id !== infra.cloudflare.accountId || census.zone.name !== infra.cloudflare.zoneName || census.zone.status !== 'active') throw new Error('zone-ownership-mismatch')
  const workers = Object.fromEntries(['Api', 'Indexer', 'Explore'].map(id => [id, census.workers.find(worker => worker.id === infra.resources[id])]))
  const database = census.databases.find(candidate => candidate.name === infra.resources.Database)
  const bucket = census.buckets.find(candidate => candidate.name === infra.resources.Manifests)
  const domains = census.domains.filter(domain => domain.hostname === new URL(infra.origin).hostname)
  if (!state) {
    if (Object.values(workers).some(Boolean) || database || bucket || domains.length) throw new Error('fresh-resource-already-exists')
    return 'create'
  }
  for (const id of ['Api', 'Indexer', 'Explore', 'Database', 'Manifests']) {
    const record = state[id]
    const attr = record?.attr
    const name = id === 'Database' ? attr?.databaseName : id === 'Manifests' ? attr?.bucketName : attr?.workerName
    if (record?.logicalId !== id || record.providerMode !== 'live' || !['created', 'updated'].includes(record.status) || attr?.accountId !== infra.cloudflare.accountId || name !== infra.resources[id]) throw new Error('dev-state-ownership-mismatch')
  }
  for (const worker of Object.values(workers)) {
    if (!worker || !worker.tags?.includes('alchemy:stack:Sidequest') || !worker.tags?.includes('alchemy:stage:dev')) throw new Error('dev-worker-ownership-mismatch')
  }
  if (!database || database.uuid !== state.Database.attr.databaseId || !bucket || domains.length !== 1 || domains[0].service !== infra.resources.Explore || domains[0].zone_id !== infra.cloudflare.zoneId) throw new Error('dev-storage-or-domain-mismatch')
  return 'update'
}

export async function censusOf(infra, token, fetcher = fetch) {
  const account = infra.cloudflare.accountId
  const get = async path => {
    const response = await fetcher(`https://api.cloudflare.com/client/v4${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) })
    const body = await response.json()
    if (!response.ok || body.success !== true) throw new Error('cloudflare-census-unavailable')
    return body
  }
  const paged = async path => {
    const rows = []
    for (let page = 1; page <= 100; page++) {
      const body = await get(`${path}?page=${page}&per_page=100`)
      const info = body.result_info
      const totalPages = info?.total_pages ?? (Number.isInteger(info?.total_count) && info.total_count >= 0 && Number.isInteger(info?.per_page) && info.per_page > 0 ? Math.max(1, Math.ceil(info.total_count / info.per_page)) : NaN)
      if (!Array.isArray(body.result) || !Number.isInteger(totalPages) || totalPages < 1 || info?.page !== page || info.count !== undefined && info.count !== body.result.length) throw new Error('cloudflare-pagination-incomplete')
      rows.push(...body.result)
      if (page >= totalPages) {
        if (info.total_count !== undefined && rows.length !== info.total_count) throw new Error('cloudflare-pagination-incomplete')
        return rows
      }
    }
    throw new Error('cloudflare-pagination-limit')
  }
  const r2Buckets = async () => {
    const rows = [], seen = new Set()
    let cursor
    for (let page = 0; page < 100; page++) {
      const body = await get(`/accounts/${account}/r2/buckets?per_page=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      if (!Array.isArray(body.result?.buckets)) throw new Error('cloudflare-census-incomplete')
      rows.push(...body.result.buckets)
      cursor = body.result_info?.cursor
      if (!cursor) return rows
      if (typeof cursor !== 'string' || seen.has(cursor)) throw new Error('cloudflare-pagination-incomplete')
      seen.add(cursor)
    }
    throw new Error('cloudflare-pagination-limit')
  }
  const [zone, workers, databases, buckets, domains] = await Promise.all([
    get(`/zones/${infra.cloudflare.zoneId}`), get(`/accounts/${account}/workers/scripts`),
    paged(`/accounts/${account}/d1/database`), r2Buckets(), paged(`/accounts/${account}/workers/domains`),
  ])
  if (!Array.isArray(workers.result)) throw new Error('cloudflare-census-incomplete')
  return { zone: zone.result, workers: workers.result, databases, buckets, domains }
}

function readState() {
  const root = resolve(repo, '.alchemy/state/Sidequest/dev')
  if (!existsSync(root)) return null
  const present = ['Api', 'Indexer', 'Explore', 'Database', 'Manifests'].map(id => existsSync(resolve(root, id + '.json')))
  if (!present.some(Boolean)) return null
  if (!present.every(Boolean)) throw new Error('partial-dev-state-reconcile-before-retry')
  return Object.fromEntries(['Api', 'Indexer', 'Explore', 'Database', 'Manifests'].map(id => [id, JSON.parse(readFileSync(resolve(root, id + '.json'), 'utf8'))]))
}

async function main() {
  const action = process.argv[2] ?? 'deploy'
  if (!['plan', 'deploy'].includes(action)) throw new Error('use-plan-or-deploy')
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('node-24-required')
  if (action === 'deploy' && process.env.SIDEQUEST_DEV_RELEASE !== '1') throw new Error('explicit-dev-release-required')
  const lines = args => git(...args).split('\n').filter(Boolean)
  assertCheckout({ branch: git('branch', '--show-current'), staged: lines(['diff', '--cached', '--name-only']), dirty: lines(['diff', '--name-only']), unknown: lines(['ls-files', '--others', '--exclude-standard']) })
  const localEnv = parseEnv(readFileSync(resolve(repo, '.env.local'), 'utf8'))
  const devAuthority = loadDevAuthority(repo, localEnv)
  // Separate provider GET verification from cached build tasks and keep all output private.
  const verify = spawnSync('pnpm', ['exec', 'bun', 'packages/sdk/scripts/privy/sidequest-cutover.ts', 'verify'], { cwd: repo, env: { ...process.env, ...localEnv }, stdio: 'pipe' })
  if (verify.status !== 0) throw new Error('sidequest-dev-authority-provider-readback-failed')
  const verifiedLocalEnv = parseEnv(readFileSync(resolve(repo, '.env.local'), 'utf8'))
  const verifiedAuthority = loadDevAuthority(repo, verifiedLocalEnv)
  if (hash(localEnv.PRIVY_APP_SECRET ?? '') !== hash(verifiedLocalEnv.PRIVY_APP_SECRET ?? '') || JSON.stringify(devAuthority) !== JSON.stringify(verifiedAuthority)) throw new Error('sidequest-dev-authority-changed-during-readback')
  for (const source of [process.env, localEnv]) {
    if (Object.keys(source).some(name => name.startsWith('DISTILLED_DEBUG'))) throw new Error('provider-debug-env-refused')
    if (source.ALCHEMY_REMOTE_STATE === '1' || source.ALCHEMY_STATE_MODE === 'remote') throw new Error('remote-state-refused')
  }
  const infra = JSON.parse(readFileSync(resolve(repo, 'infra/dev.json'), 'utf8'))
  const config = JSON.parse(readFileSync(resolve(repo, 'contracts/config/monad-testnet.json'), 'utf8'))
  const env = { ...process.env, ...verifiedLocalEnv, ...verifiedAuthority, SIDEQUEST_STAGE: 'dev', SIDEQUEST_NETWORK: 'monad-testnet', SIDEQUEST_DEV_RELEASE: '1', SIDEQUEST_APPLY_MIGRATIONS: '1', ALCHEMY_REMOTE_STATE: '0', ALCHEMY_STATE_MODE: 'local', CLOUDFLARE_ACCOUNT_ID: infra.cloudflare.accountId }
  if (env.SIDEQUEST_WITHOUT_EXPLORE === '1') throw new Error('complete-stack-required')
  for (const key of ['CLOUDFLARE_API_TOKEN', 'MONAD_TESTNET_RPC_URL', 'SIDEQUEST_DEV_RELAY_PRIVATE_KEY', 'SIDEQUEST_DEV_ATTESTER_PRIVATE_KEY', 'HYPERSYNC_API_TOKEN']) if (!env[key]) throw new Error('required-dev-credential-missing')
  if (config.chainId !== 10143 || config.sidequest.reuseCore !== false || !config.deployment.sidequest || config.deployment.legacy && Object.keys(config.deployment.legacy).length) throw new Error('fresh-sidequest-deployment-required')
  for (const role of ['relay', 'attester']) if (privateKeyToAccount(env[`SIDEQUEST_DEV_${role.toUpperCase()}_PRIVATE_KEY`]).address.toLowerCase() !== config.roles[role].toLowerCase()) throw new Error('dev-signing-address-mismatch')
  const client = createPublicClient({ transport: http(env.MONAD_TESTNET_RPC_URL) })
  if (await client.getChainId() !== 10143) throw new Error('rpc-chain-mismatch')
  const h = config.deployment.sidequest
  for (const target of [h.vault, h.feeSchedule, config.deployment.main.holding, config.deployment.main.evaluator, h.distributor, h.miningReserve]) {
    if (await client.readContract({ address: target, abi: parseAbi(['function owner() view returns (address)']), functionName: 'owner' }).then(owner => owner.toLowerCase()) !== h.safe.toLowerCase()) throw new Error('sidequest-ownership-incomplete')
  }
  const census = await censusOf(infra, env.CLOUDFLARE_API_TOKEN)
  const operation = validateCensus(infra, census, readState())
  const packet = { commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'), operation, infra, migrationSha256: hash(readFileSync(resolve(repo, 'apps/api/migrations/0001_directory_agents.sql'))), observedAt: new Date().toISOString() }
  console.log(JSON.stringify(packet, null, 2))
  if (action === 'plan') return
  const privateRoot = resolve(repo, '.sidequest')
  mkdirSync(privateRoot, { recursive: true, mode: 0o700 })
  const lock = resolve(privateRoot, 'dev-release.lock')
  writeFileSync(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 })
  try {
    // Build a committed export so neighbours' edits never enter a deployment or need to be moved.
    const source = resolve(privateRoot, 'release-source', packet.commit)
    mkdirSync(source, { recursive: true, mode: 0o700 })
    const archive = resolve(privateRoot, 'release-source.tar')
    execFileSync('git', ['archive', '--format=tar', '--output', archive, packet.commit], { cwd: repo })
    execFileSync('tar', ['-xf', archive, '-C', source])
    if (!existsSync(resolve(source, '.alchemy'))) symlinkSync(resolve(repo, '.alchemy'), resolve(source, '.alchemy'))
    const log = openSync(resolve(privateRoot, 'dev-release.log'), 'a', 0o600)
    const run = (command, args) => {
      const result = spawnSync(command, args, { cwd: source, env, stdio: ['ignore', log, log] })
      if (result.status !== 0) throw new Error('dev-release-command-failed-inspect-private-log')
    }
    try {
      run('pnpm', ['install', '--offline', '--frozen-lockfile'])
      if (git('rev-parse', 'HEAD') !== packet.commit) throw new Error('release-source-changed')
      writeFileSync(resolve(privateRoot, 'dev-release.json'), JSON.stringify({ ...packet, status: 'applying' }, null, 2) + '\n', { mode: 0o600 })
      run('pnpm', ['exec', 'alchemy', 'deploy', '--stage', 'dev', '--yes'])
      writeFileSync(resolve(privateRoot, 'dev-release.json'), JSON.stringify({ ...packet, status: 'deployed', finishedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 })
    } finally { closeSync(log) }
    console.log(`Sidequest dev deployed: ${infra.origin}`)
  } finally { unlinkSync(lock) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof Error && /^[a-z0-9-]+$/.test(error.message) ? error.message : 'dev-release-refused-inspect-private-journal')
    process.exitCode = 1
  })
}
