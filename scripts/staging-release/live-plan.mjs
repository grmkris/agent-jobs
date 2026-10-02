import { canonicalChange, plannedDomains, validatePlanChanges } from './approved-changes.mjs'
import { durableObjectTransition, migratesClasses, wireBindings } from './payload.mjs'

const stack = { name: 'AgentJobs', stage: 'staging' }
const accountId = 'bceaeae4788dce3493514fde194b4a7e'
const domainNames = value => value === undefined || value === null ? [] : typeof value === 'string'
  ? [value] : [value.name, ...(value.aliases ?? []), ...(value.redirects ?? [])]
const same = (left, right) => canonicalChange(left) === canonicalChange(right)
const blank = value => value === undefined || value === null || value === ''
const sameValue = (a, b) => (blank(a) && blank(b)) || a === b
const jurisdiction = value => (value === 'default' ? undefined : value)

/**
 * Review B12-002: a planned wire binding against the live one of the same name (census, snake_case fields). Resource
 * identities must match exactly, for noop bindings too; a local Durable Object binding must point at the live namespace
 * this script hosts for that class. Text/JSON values are pinned by the payload digest instead (B12-001).
 */
export function sameIdentity(wire, old, workerName, namespaces) {
  switch (wire.type) {
    case 'd1': return sameValue(wire.databaseId ?? wire.id, old.id ?? old.database_id)
    case 'r2_bucket': return sameValue(wire.bucketName, old.bucket_name) && sameValue(jurisdiction(wire.jurisdiction), jurisdiction(old.jurisdiction))
    case 'service': return sameValue(wire.service, old.service) && sameValue(wire.environment, old.environment) && sameValue(wire.entrypoint, old.entrypoint)
    case 'kv_namespace': return sameValue(wire.namespaceId ?? wire.namespace_id, old.namespace_id)
    case 'durable_object_namespace': {
      const host = script => (blank(script) ? workerName : script)
      if (!sameValue(wire.className, old.class_name) || host(wire.scriptName) !== host(old.script_name) || !sameValue(wire.environment, old.environment)) return false
      if (!blank(wire.namespaceId) && wire.namespaceId !== old.namespace_id) return false
      if (host(wire.scriptName) !== workerName) return true
      return namespaces.some(ns => ns.id === old.namespace_id && ns.script === workerName && ns.className === wire.className)
    }
    default: return true
  }
}

// Alchemy keys native plan resources by FQN. The serializable plan exposes
// logical IDs, so always resolve by the resource's declared LogicalId and
// retain the direct lookup as a fast path for the existing stack's short FQNs.
export const nativeResource = (snapshot, logicalId) => snapshot?.native?.resources?.[logicalId] ??
  Object.values(snapshot?.native?.resources ?? {}).find(node => node?.resource?.LogicalId === logicalId)

/** Review the native provider plan without returning credential-bearing data. Every exception is a name only. */
export function reviewLivePlan(snapshot, live, reference, sameSecret) {
  const blockers = new Set()
  const changes = { migrations: [], secretChanges: [], resourceCreates: [], domainChanges: [], scheduleChanges: [] }
  const transitions = {}
  const operations = snapshot.resources.map(resource => ({
    fqn: resource.fqn, logicalId: resource.logicalId, type: resource.resourceType, action: resource.action,
    bindings: resource.bindings.map(binding => ({ sid: binding.sid, action: binding.action })),
  }))
  if (['create', 'delete', 'replace', 'orphaned', 'adopted'].some(action => snapshot.summary[action] !== 0)) blockers.add('resource-action-refused')
  if (snapshot.actions.length > 0) changes.migrations.push('provider-action')
  for (const row of operations) {
    if (!['noop', 'update'].includes(row.action)) blockers.add('resource-action-refused')
    if (['Database', 'Manifests'].includes(row.logicalId) && row.action !== 'noop') blockers.add('storage-write-refused')
    const node = nativeResource(snapshot, row.logicalId)
    if (node === undefined) { blockers.add('native-plan-missing'); continue }
    const props = node.props ?? node.state?.props ?? {}
    const observed = live.workers[row.logicalId]
    const wires = wireBindings(node, { workerName: observed?.name ?? row.logicalId, stack, accountId })
    for (const binding of row.bindings) {
      if (binding.action === 'delete') blockers.add('binding-deletion-refused')
      if (binding.action === 'noop') continue
      if (binding.sid.startsWith('Cron(')) {
        changes.scheduleChanges.push({ logicalId: row.logicalId, sid: binding.sid })
        continue
      }
      const native = node.bindings.find(entry => entry.sid === binding.sid)
      const bound = native?.data?.bindings ?? []
      for (const entry of bound) {
        const old = observed?.bindings.find(item => item.name === entry.name)
        if (old && entry.type !== 'inherit' && entry.type !== old.type) blockers.add('binding-type-change-refused')
      }
      const secrets = bound.filter(entry => entry.type === 'secret_text')
      // Secret creation and rotation can only be individual bindings. Grouped/inherited secrets stay unchanged.
      if (secrets.length !== 1 || bound.length !== 1 || secrets[0].name !== binding.sid) {
        if (binding.action === 'create') blockers.add('binding-creation-refused')
        if (bound.some(entry => ['secret_text', 'inherit', 'durable_object_namespace', 'd1', 'r2_bucket', 'service'].includes(entry.type))) blockers.add('resource-binding-change-refused')
        continue
      }
      const name = secrets[0].name
      const exists = observed?.bindings.some(entry => entry.name === name && entry.type === 'secret_text')
      if (binding.action === 'update' && exists && sameSecret(row.logicalId, name)) continue
      changes.secretChanges.push({ logicalId: row.logicalId, name, action: exists ? 'rotate' : 'add' })
    }
    if (observed !== undefined) {
      // Every planned binding, noop ones included, against the live wire identity.
      for (const wire of wires) {
        const old = observed.bindings.find(item => item.name === wire.name)
        if (old === undefined || wire.type === 'inherit') continue
        if (wire.type !== old.type) blockers.add('binding-type-change-refused')
        else if (!sameIdentity(wire, old, observed.name, live.namespaces ?? [])) blockers.add('binding-identity-drift')
      }
      // The class migration the provider derives during upload from the live tags; engine actions never show it.
      const transition = durableObjectTransition(node, observed, live.namespaces ?? [])
      transitions[row.logicalId] = transition
      if (migratesClasses(transition)) {
        blockers.add('durable-object-migration-refused')
        changes.migrations.push(`durable-object:${row.logicalId}`)
      }
      const oldNames = observed.bindings.map(binding => binding.name)
      const newNames = wires.map(binding => binding.name)
      if (new Set(newNames).size !== newNames.length || oldNames.some(name => !newNames.includes(name))) blockers.add('binding-deletion-refused')
      const allowedNewNames = changes.secretChanges.filter(change => change.logicalId === row.logicalId && change.action === 'add').map(change => change.name)
      if (newNames.some(name => !oldNames.includes(name) && !allowedNewNames.includes(name))) blockers.add('binding-creation-refused')
      const crons = [...new Set([...(props.crons ?? []), ...node.bindings.flatMap(binding => binding.data?.crons ?? [])])].toSorted()
      if (!same(crons, observed.crons)) changes.scheduleChanges.push({ logicalId: row.logicalId })
      const intended = domainNames(props.domain).toSorted()
      const current = live.domains.filter(domain => domain.service === observed.name).map(domain => domain.hostname).toSorted()
      if (!same(intended, current)) {
        if (row.logicalId === 'Explore' && same(intended, current.filter(hostname => hostname !== 'hireling.xyz')) && process.env.HIRELING_APEX_REDIRECT === '0') {
          changes.domainChanges.push({ logicalId: 'Explore', hostname: 'hireling.xyz', action: 'release-alias', setting: 'HIRELING_APEX_REDIRECT', value: '0' })
        } else blockers.add('domain-change-refused')
      }
    }
  }
  const validation = validatePlanChanges(changes, reference)
  for (const blocker of validation.blockers) blockers.add(blocker)
  return { ok: blockers.size === 0, blockers: [...blockers], operations, changes, transitions, approvedChanges: reference,
    expectedDomains: plannedDomains(changes, reference, live.domains.map(domain => domain.hostname)).toSorted() }
}
