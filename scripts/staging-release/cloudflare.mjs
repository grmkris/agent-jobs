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
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new Error('Cloudflare pagination page size invalid')
  const all = []
  let page = 1
  let total
  let perPage
  for (;;) {
    const separator = path.includes('?') ? '&' : '?'
    const body = await cloudflareEnvelope(`${path}${separator}page=${page}&per_page=${pageSize}`)
    const info = body.result_info
    if (!Number.isSafeInteger(info?.total_count) || info.total_count < 0 || !Number.isSafeInteger(info?.per_page) || info.per_page < 1)
      throw new Error('Cloudflare list pagination metadata missing')
    if (info.page !== page) throw new Error('Cloudflare list page did not advance')
    if (total === undefined) total = info.total_count
    if (info.total_count !== total) throw new Error('Cloudflare list total changed during census')
    if (perPage === undefined) perPage = info.per_page
    if (info.per_page !== perPage) throw new Error('Cloudflare list page size changed during census')
    const pageItems = items(body.result)
    if (!Array.isArray(pageItems) || pageItems.length > info.per_page || (Number.isSafeInteger(info.count) && info.count !== pageItems.length))
      throw new Error('Cloudflare list page shape invalid')
    all.push(...pageItems)
    if (all.length > total) throw new Error('Cloudflare list exceeds total_count')
    if (all.length === total) return all
    if (pageItems.length !== info.per_page) throw new Error('Cloudflare list page ended before total_count')
    page++
    if (page > 10_000) throw new Error('Cloudflare list pagination limit exceeded')
  }
}

/** These endpoints return a complete collection and have no page/cursor request in the pinned API contract. */
async function cloudflareComplete(path, items = result => result) {
  const body = await cloudflareEnvelope(path)
  const rows = items(body.result)
  if (!Array.isArray(rows)) throw new Error('Cloudflare collection shape invalid')
  const total = body.result_info?.total_count
  if (total !== undefined && (!Number.isSafeInteger(total) || total !== rows.length)) throw new Error('Cloudflare complete collection count mismatch')
  return rows
}

/** R2 omits a continuation token/count: follow lexicographic start_after until a short page, as its provider does. */
export async function liveBuckets(pageSize = 1000) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw new Error('Cloudflare bucket page size invalid')
  const buckets = []
  let after = ''
  for (let page = 0; page < 10_000; page++) {
    const body = await cloudflareEnvelope(`/r2/buckets?order=name&direction=asc&per_page=${pageSize}${after === '' ? '' : `&start_after=${encodeURIComponent(after)}`}`)
    const rows = body.result?.buckets
    if (!Array.isArray(rows) || rows.length > pageSize) throw new Error('Cloudflare bucket page shape invalid')
    for (const row of rows) {
      if (typeof row.name !== 'string' || row.name === '' || row.name <= after) throw new Error('Cloudflare bucket page did not advance')
      after = row.name
      buckets.push(row)
    }
    if (rows.length < pageSize) return buckets
  }
  throw new Error('Cloudflare bucket pagination limit exceeded')
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
    throw new Error('Cloudflare namespace census has missing or duplicate identities')
  return namespaces.filter((namespace) => scripts().includes(namespace.script))
    .map(({ id, class: className, script }) => ({ id, className, script }))
}

export async function census(options = {}) {
  const workers = {}
  for (const id of ['Api', 'Indexer', 'Explore']) {
    const { name, tags, bindings } = await liveWorker(id)
    const deployments = await cloudflareComplete(`/workers/scripts/${name}/deployments`, result => result?.deployments)
    const schedules = await cloudflareComplete(`/workers/scripts/${name}/schedules`, result => result?.schedules)
    const active = deployments[0]?.versions
    if (active?.length !== 1 || active[0].percentage !== 100) throw new Error(`Expected one fully deployed version: ${id}`)
    workers[id] = {
      name, version: active[0].version_id, tags, bindings,
      crons: schedules.map((schedule) => schedule.cron).toSorted(),
    }
  }
  const domains = (await cloudflareComplete('/workers/domains')).filter((domain) => ['hireling.xyz', 'testnet.hireling.xyz'].includes(domain.hostname))
    .map(({ hostname, service, zone_id }) => ({ hostname, service, zone_id })).toSorted((a, b) => a.hostname.localeCompare(b.hostname))
  const database = await cloudflare(`/d1/database/${targets.Database}`)
  const bucket = (await liveBuckets()).find((item) => item.name === targets.Manifests)
  if (bucket === undefined) throw new Error('Live manifests bucket missing')
  const namespaces = await liveNamespaces()
  const result = { workers, domains, databaseId: database.uuid, bucketName: bucket.name, namespaces }
  validateCensus(result, options)
  return result
}

export function validateCensus(live, options = {}) {
  if (live.databaseId !== targets.Database || live.bucketName !== targets.Manifests) throw new Error('Live storage identity drift')
  const domains = options.domains ?? ['hireling.xyz', 'testnet.hireling.xyz']
  if (live.domains.length !== domains.length || domains.some(hostname => live.domains.filter(domain => domain.hostname === hostname).length !== 1) || live.domains.some((domain) => domain.service !== targets.Explore || domain.zone_id !== 'd4ad1574270cad47f2e33381dba31f84')) throw new Error('Live domain ownership drift')
  const get = (worker, name) => live.workers[worker].bindings.find((binding) => binding.name === name)
  for (const id of ['Api', 'Indexer', 'Explore']) {
    if (live.workers[id].name !== targets[id]) throw new Error(`Live Worker identity drift: ${id}`)
    if (!live.workers[id].tags.includes('alchemy:stack:AgentJobs') || !live.workers[id].tags.includes('alchemy:stage:staging')) throw new Error(`Live Worker ownership drift: ${id}`)
    if (JSON.stringify(live.workers[id].crons) !== JSON.stringify(id === 'Indexer' ? ['* * * * *'] : [])) throw new Error(`Live cron drift: ${id}`)
  }
  if (get('Api', 'Database')?.id !== targets.Database || get('Indexer', 'Database')?.id !== targets.Database || get('Api', 'Manifests')?.bucket_name !== targets.Manifests || get('Api', 'Board')?.namespace_id !== boardNamespace || get('Explore', 'API')?.service !== targets.Api) throw new Error('Live resource binding drift')
  if (!live.namespaces.some((namespace) => namespace.id === boardNamespace && namespace.className === 'Board')) throw new Error('Live Board namespace drift')
  for (const name of ['AI_GATEWAY_API_KEY', 'ATTESTER_PRIVATE_KEY', 'RELAY_PRIVATE_KEY', 'GITHUB_APP_PRIVATE_KEY', 'BUDGET_SIGNER_PRIVATE_KEY', 'PRIVY_APP_SECRET']) {
    if (get('Api', name)?.type !== 'secret_text') throw new Error(`Missing live secret binding: ${name}`)
  }
}

export async function verifyWorker(id) {
  const subdomain = await cloudflare('/workers/subdomain')
  const origin = `https://${targets[id]}.${subdomain.subdomain}.workers.dev`
  const response = await fetch(`${origin}${id === 'Api' ? '/health' : '/'}`, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`Worker readback failed: ${id}`)
  const body = id === 'Explore' ? undefined : await response.json()
  if (id !== 'Explore' && body?.ok !== true) throw new Error(`Health readback failed: ${id}`)
  if (id === 'Api' && (body.network !== 'monad-testnet' || body.runtime !== 'Cloudflare-Workers')) throw new Error(`Wrong deployed network/runtime: ${id}`)
  if (id === 'Api') {
    const directory = await fetch(`${origin}/data/directory`, { signal: AbortSignal.timeout(30_000) })
    const data = await directory.json()
    if (!directory.ok || data.ok !== true || !Array.isArray(data.agents)) throw new Error(`Directory readback failed: ${id}`)
  }
  return { id, verifiedAt: new Date().toISOString() }
}
