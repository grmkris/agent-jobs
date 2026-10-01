import { accountId, boardNamespace, targets } from './state.ts'

export async function cloudflare(path, options = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
  })
  const body = await response.json()
  if (!response.ok || body.success !== true) throw new Error(`Cloudflare ${options.method ?? 'GET'} failed (${response.status}; codes ${(body.errors ?? []).map((error) => error.code).join(',')})`)
  return body.result
}

const bindingFields = ['type', 'name', 'namespace_id', 'class_name', 'id', 'bucket_name', 'service', 'environment']

export async function census() {
  const workers = {}
  for (const id of ['Api', 'Indexer', 'Explore']) {
    const name = targets[id]
    const settings = await cloudflare(`/workers/scripts/${name}/settings`)
    const deployments = await cloudflare(`/workers/scripts/${name}/deployments`)
    const schedules = await cloudflare(`/workers/scripts/${name}/schedules`)
    const active = deployments.deployments?.[0]?.versions
    if (active?.length !== 1 || active[0].percentage !== 100) throw new Error(`Expected one fully deployed version: ${id}`)
    workers[id] = {
      name, version: active[0].version_id,
      tags: settings.tags ?? [],
      bindings: (settings.bindings ?? []).map((binding) => Object.fromEntries(bindingFields.filter((key) => key in binding).map((key) => [key, binding[key]]))),
      crons: (schedules.schedules ?? []).map((schedule) => schedule.cron).toSorted(),
    }
  }
  const domains = (await cloudflare('/workers/domains')).filter((domain) => ['hireling.xyz', 'testnet.hireling.xyz'].includes(domain.hostname))
    .map(({ hostname, service, zone_id }) => ({ hostname, service, zone_id })).toSorted((a, b) => a.hostname.localeCompare(b.hostname))
  const database = await cloudflare(`/d1/database/${targets.Database}`)
  const bucket = (await cloudflare('/r2/buckets')).buckets?.find((item) => item.name === targets.Manifests)
  if (bucket === undefined) throw new Error('Live manifests bucket missing')
  const namespaces = (await cloudflare('/workers/durable_objects/namespaces')).filter((namespace) => namespace.script === targets.Api)
    .map(({ id, class: className, script }) => ({ id, className, script }))
  const result = { workers, domains, databaseId: database.uuid, bucketName: bucket.name, namespaces }
  validateCensus(result)
  return result
}

export function validateCensus(live) {
  if (live.databaseId !== targets.Database || live.bucketName !== targets.Manifests) throw new Error('Live storage identity drift')
  if (live.domains.length !== 2 || live.domains.some((domain) => domain.service !== targets.Explore || domain.zone_id !== 'd4ad1574270cad47f2e33381dba31f84')) throw new Error('Live domain ownership drift')
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
