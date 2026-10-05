import { StagingReleaseError } from './errors.mjs'
import { accountId, boardNamespace, targets } from './state.ts'

async function cloudflareEnvelope(path, options = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
  })
  const body = await response.json()
  if (!response.ok || body.success !== true) throw new Error(`Cloudflare ${options.method ?? 'GET'} failed (${response.status}; codes ${(body.errors ?? []).map((error) => error.code).join(',')})`)
  return body
}

export async function cloudflare(path, options = {}) {
  const body = await cloudflareEnvelope(path, options)
  return body.result
}

/** Read a Cloudflare list completely. The API does not always return total_pages, so total_count and per_page are authoritative. */
export async function cloudflarePaged(path, { items = result => result, pageSize = 100 } = {}) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new StagingReleaseError('census-page-size-invalid')
  const all = []
  let page = 1
  let total
  let perPage
  for (;;) {
    const separator = path.includes('?') ? '&' : '?'
    const body = await cloudflareEnvelope(`${path}${separator}page=${page}&per_page=${pageSize}`)
    const info = body.result_info
    if (!Number.isSafeInteger(info?.total_count) || info.total_count < 0 || !Number.isSafeInteger(info?.per_page) || info.per_page < 1)
      throw new StagingReleaseError('census-pagination-metadata-missing')
    if (info.page !== page) throw new StagingReleaseError('census-page-not-advancing')
    if (total === undefined) total = info.total_count
    if (info.total_count !== total) throw new StagingReleaseError('census-total-changed')
    if (perPage === undefined) perPage = info.per_page
    if (info.per_page !== perPage) throw new StagingReleaseError('census-page-size-changed')
    const pageItems = items(body.result)
    if (!Array.isArray(pageItems) || pageItems.length > info.per_page || (Number.isSafeInteger(info.count) && info.count !== pageItems.length))
      throw new StagingReleaseError('census-page-shape-invalid')
    all.push(...pageItems)
    if (all.length > total) throw new StagingReleaseError('census-total-exceeded')
    if (all.length === total) return all
    if (pageItems.length !== info.per_page) throw new StagingReleaseError('census-page-short')
    page++
    if (page > 10_000) throw new StagingReleaseError('census-pagination-limit')
  }
}

/** Schedules return a complete collection; check returned counts if present. */
async function cloudflareComplete(path, items = result => result) {
  const body = await cloudflareEnvelope(path)
  const rows = items(body.result)
  if (!Array.isArray(rows)) throw new StagingReleaseError('census-collection-shape-invalid')
  const total = body.result_info?.total_count
  if (total !== undefined && (!Number.isSafeInteger(total) || total !== rows.length)) throw new StagingReleaseError('census-collection-count-mismatch')
  return rows
}

/** R2 omits a continuation token/count: follow lexicographic start_after until a short page, as its provider does. */
export async function liveBuckets(pageSize = 1000) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw new StagingReleaseError('census-bucket-page-size-invalid')
  const buckets = []
  let after = ''
  for (let page = 0; page < 10_000; page++) {
    const body = await cloudflareEnvelope(`/r2/buckets?order=name&direction=asc&per_page=${pageSize}${after === '' ? '' : `&start_after=${encodeURIComponent(after)}`}`)
    const rows = body.result?.buckets
    if (!Array.isArray(rows) || rows.length > pageSize) throw new StagingReleaseError('census-bucket-page-shape-invalid')
    for (const row of rows) {
      if (typeof row.name !== 'string' || row.name === '' || row.name <= after) throw new StagingReleaseError('census-bucket-page-not-advancing')
      after = row.name
      buckets.push(row)
    }
    if (rows.length < pageSize) return buckets
  }
  throw new StagingReleaseError('census-bucket-pagination-limit')
}

const bindingFields = ['type', 'name', 'namespace_id', 'class_name', 'script_name', 'id', 'database_id', 'bucket_name', 'jurisdiction', 'service', 'environment', 'entrypoint']
const scripts = () => [targets.Api, targets.Indexer, targets.Explore]

/** One Worker's live tags and binding identities (no values), as the census records them. */
export async function liveWorker(id) {
  const name = targets[id]
  const settings = await cloudflare(`/workers/scripts/${name}/settings`)
  return {
    name, tags: settings.tags ?? [],
    bindings: (settings.bindings ?? []).map((binding) => Object.fromEntries(bindingFields.filter((key) => key in binding).map((key) => [key, binding[key]]))),
  }
}

/** The account's Durable Object namespaces hosted by the three staging scripts. */
export async function liveNamespaces() {
  const namespaces = await cloudflarePaged('/workers/durable_objects/namespaces')
  const ids = namespaces.map(namespace => namespace?.id)
  if (ids.some(id => typeof id !== 'string' || id === '') || new Set(ids).size !== ids.length)
    throw new StagingReleaseError('census-namespace-identities-invalid')
  return namespaces.filter((namespace) => scripts().includes(namespace.script))
    .map(({ id, class: className, script }) => ({ id, className, script }))
}

/** Exhaust the paginated account domains before narrowing to Hireling's domains. */
export async function liveDomains() {
  return (await cloudflarePaged('/workers/domains')).filter(domain => ['hireling.xyz', 'testnet.hireling.xyz'].includes(domain.hostname))
    .map(({ hostname, service, zone_id }) => ({ hostname, service, zone_id })).toSorted((a, b) => a.hostname.localeCompare(b.hostname))
}

/** Exhaust the history, then prove the API's first row is the unique newest deployment. */
export async function liveDeployment(name) {
  const deployments = await cloudflarePaged(`/workers/scripts/${name}/deployments`, { items: result => result?.deployments })
  if (deployments.length === 0) throw new StagingReleaseError('census-deployments-empty')
  const ids = deployments.map(deployment => deployment?.id)
  if (ids.some(id => typeof id !== 'string' || id === '') || new Set(ids).size !== ids.length)
    throw new StagingReleaseError('census-deployment-identities-invalid')
  const dated = deployments.map(deployment => {
    const timestamp = typeof deployment?.created_on === 'string' && deployment.created_on !== '' ? Date.parse(deployment.created_on) : NaN
    if (!Number.isFinite(timestamp)) throw new StagingReleaseError('census-deployment-timestamp-invalid')
    return { deployment, timestamp }
  })
  const latest = Math.max(...dated.map(row => row.timestamp))
  const newest = dated.filter(row => row.timestamp === latest)
  if (newest.length !== 1) throw new StagingReleaseError('census-deployment-newest-ambiguous')
  if (newest[0].deployment !== deployments[0] || dated.some((row, i) => i > 0 && row.timestamp >= dated[i - 1].timestamp))
    throw new StagingReleaseError('census-deployment-order-invalid')
  const active = newest[0].deployment
  if (active.versions?.length !== 1 || active.versions[0].percentage !== 100 || typeof active.versions[0].version_id !== 'string' || active.versions[0].version_id === '')
    throw new StagingReleaseError('census-deployment-traffic-invalid')
  return active
}

export async function census(options = {}) {
  const workers = {}
  for (const id of ['Api', 'Indexer', 'Explore']) {
    const { name, tags, bindings } = await liveWorker(id)
    const deployment = await liveDeployment(name)
    const schedules = await cloudflareComplete(`/workers/scripts/${name}/schedules`, result => result?.schedules)
    const active = deployment.versions
    workers[id] = {
      name, version: active[0].version_id, tags, bindings,
      crons: schedules.map((schedule) => schedule.cron).toSorted(),
    }
  }
  const domains = await liveDomains()
  const database = await cloudflare(`/d1/database/${targets.Database}`)
  const bucket = (await liveBuckets()).find((item) => item.name === targets.Manifests)
  if (bucket === undefined) throw new StagingReleaseError('census-manifests-missing')
  const namespaces = await liveNamespaces()
  const result = { workers, domains, databaseId: database.uuid, bucketName: bucket.name, namespaces }
  validateCensus(result, options)
  return result
}

export function validateCensus(live, options = {}) {
  if (live.databaseId !== targets.Database || live.bucketName !== targets.Manifests) throw new StagingReleaseError('census-storage-identity-drift')
  const domains = options.domains ?? ['hireling.xyz', 'testnet.hireling.xyz']
  if (live.domains.length !== domains.length || domains.some(hostname => live.domains.filter(domain => domain.hostname === hostname).length !== 1) || live.domains.some((domain) => domain.service !== targets.Explore || domain.zone_id !== 'd4ad1574270cad47f2e33381dba31f84')) throw new StagingReleaseError('census-domain-ownership-drift')
  const get = (worker, name) => live.workers[worker].bindings.find((binding) => binding.name === name)
  for (const id of ['Api', 'Indexer', 'Explore']) {
    if (live.workers[id].name !== targets[id]) throw new StagingReleaseError('census-worker-identity-drift')
    if (!live.workers[id].tags.includes('alchemy:stack:AgentJobs') || !live.workers[id].tags.includes('alchemy:stage:staging')) throw new StagingReleaseError('census-worker-ownership-drift')
    if (JSON.stringify(live.workers[id].crons) !== JSON.stringify(id === 'Indexer' ? ['* * * * *'] : [])) throw new StagingReleaseError('census-cron-drift')
  }
  if (get('Api', 'Database')?.id !== targets.Database || get('Indexer', 'Database')?.id !== targets.Database || get('Api', 'Manifests')?.bucket_name !== targets.Manifests || get('Api', 'Board')?.namespace_id !== boardNamespace || get('Explore', 'API')?.service !== targets.Api) throw new StagingReleaseError('census-binding-drift')
  if (!live.namespaces.some((namespace) => namespace.id === boardNamespace && namespace.className === 'Board')) throw new StagingReleaseError('census-board-namespace-drift')
  for (const name of ['AI_GATEWAY_API_KEY', 'ATTESTER_PRIVATE_KEY', 'RELAY_PRIVATE_KEY', 'GITHUB_APP_PRIVATE_KEY', 'BUDGET_SIGNER_PRIVATE_KEY', 'PRIVY_APP_SECRET']) {
    if (get('Api', name)?.type !== 'secret_text') throw new StagingReleaseError('census-secret-binding-missing')
  }
  // Before P8 the current Worker has no routine signer. After apply all four bindings must be present.
  if (options.requireAgentSigning === true || get('Api', 'PRIVY_SIGNER_KEY') !== undefined) {
    if (get('Api', 'PRIVY_SIGNER_KEY')?.type !== 'secret_text') throw new StagingReleaseError('census-agent-signer-binding-missing')
    for (const name of ['PRIVY_APP_ID', 'PRIVY_SIGNER_ID', 'PRIVY_POLICY_ID']) {
      const binding = get('Api', name)
      if (binding?.type !== 'plain_text' || typeof binding.text !== 'string' || binding.text.length === 0) throw new StagingReleaseError('census-agent-authority-setting-missing')
    }
  }
}

export async function verifyWorker(id) {
  const subdomain = await cloudflare('/workers/subdomain')
  const origin = `https://${targets[id]}.${subdomain.subdomain}.workers.dev`
  const response = await fetch(`${origin}${id === 'Api' ? '/health' : '/'}`, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new StagingReleaseError('worker-readback-failed')
  const body = id === 'Explore' ? undefined : await response.json()
  if (id !== 'Explore' && body?.ok !== true) throw new StagingReleaseError('worker-health-invalid')
  if (id === 'Api' && (body.network !== 'monad-testnet' || body.runtime !== 'Cloudflare-Workers')) throw new StagingReleaseError('worker-runtime-invalid')
  if (id === 'Api') {
    const directory = await fetch(`${origin}/data/directory`, { signal: AbortSignal.timeout(30_000) })
    const data = await directory.json()
    if (!directory.ok || data.ok !== true || !Array.isArray(data.agents)) throw new StagingReleaseError('directory-readback-failed')
  }
  return { id, verifiedAt: new Date().toISOString() }
}
