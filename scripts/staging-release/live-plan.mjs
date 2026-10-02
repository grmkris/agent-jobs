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
// Diagnostics contain identifiers only: never dump a binding, property, wire identity or provider error.
const labelName = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(value) ? value : 'unknown'
const labelAction = value => ['noop', 'update', 'create', 'delete', 'replace', 'orphaned', 'adopted'].includes(value) ? value : 'unknown'
const identityField = value => ['databaseId', 'bucketName', 'jurisdiction', 'service', 'environment', 'entrypoint', 'namespaceId', 'className', 'scriptName', 'namespaceList'].includes(value) ? value : 'unknown'

/**
 * Review B12-002: a planned wire binding against the live one of the same name (census, snake_case fields). Resource
 * identities must match exactly, for noop bindings too; a local Durable Object binding must point at the live namespace
 * this script hosts for that class. Text/JSON values are pinned by the payload digest instead (B12-001).
 * Returns mismatched field names only; an empty list means the identities match.
 */
export function sameIdentity(wire, old, workerName, namespaces) {
  const differences = []
  switch (wire.type) {
    case 'd1': if (!sameValue(wire.databaseId ?? wire.id, old.id ?? old.database_id)) differences.push('databaseId'); break
    case 'r2_bucket':
      if (!sameValue(wire.bucketName, old.bucket_name)) differences.push('bucketName')
      if (!sameValue(jurisdiction(wire.jurisdiction), jurisdiction(old.jurisdiction))) differences.push('jurisdiction')
      break
    case 'service':
      if (!sameValue(wire.service, old.service)) differences.push('service')
      if (!sameValue(blank(wire.environment) ? 'production' : wire.environment, blank(old.environment) ? 'production' : old.environment)) differences.push('environment')
      if (!sameValue(wire.entrypoint, old.entrypoint)) differences.push('entrypoint')
      break
    case 'kv_namespace': if (!sameValue(wire.namespaceId ?? wire.namespace_id, old.namespace_id)) differences.push('namespaceId'); break
    case 'durable_object_namespace': {
      const host = script => (blank(script) ? workerName : script)
      if (!sameValue(wire.className, old.class_name)) differences.push('className')
      if (host(wire.scriptName) !== host(old.script_name)) differences.push('scriptName')
      if (!sameValue(wire.environment, old.environment)) differences.push('environment')
      if (!blank(wire.namespaceId) && wire.namespaceId !== old.namespace_id) differences.push('namespaceId')
      if (host(wire.scriptName) === workerName && !namespaces.some(ns => ns.id === old.namespace_id && ns.script === workerName && ns.className === wire.className)) differences.push('namespaceList')
      return differences
    }
    default: return differences
  }
  return differences
}

// Alchemy keys native plan resources by FQN. The serializable plan exposes
// logical IDs, so always resolve by the resource's declared LogicalId and
// retain the direct lookup as a fast path for the existing stack's short FQNs.
export const nativeResource = (snapshot, logicalId) => snapshot?.native?.resources?.[logicalId] ??
  Object.values(snapshot?.native?.resources ?? {}).find(node => node?.resource?.LogicalId === logicalId)

/** Review the native provider plan without returning credential-bearing data. Every exception is a name only. */
export function reviewLivePlan(snapshot, live, reference, sameSecret) {
  const blockers = new Set()
  const refuse = (code, logicalId, name, action, field) => blockers.add(`${code}(${labelName(logicalId)}${name === undefined ? '' : `.${labelName(name)}`}${field === undefined ? '' : `: ${identityField(field)}`}${action === undefined ? '' : `: ${labelAction(action)}`})`)
  const changes = { migrations: [], secretChanges: [], resourceCreates: [], domainChanges: [], scheduleChanges: [] }
  const transitions = {}
  const operations = snapshot.resources.map(resource => ({
    fqn: resource.fqn, logicalId: resource.logicalId, type: resource.resourceType, action: resource.action,
    bindings: resource.bindings.map(binding => ({ sid: binding.sid, action: binding.action })),
  }))
  if (['create', 'delete', 'replace', 'orphaned', 'adopted'].some(action => snapshot.summary[action] !== 0)) refuse('resource-action-refused', 'Plan')
  if (snapshot.actions.length > 0) changes.migrations.push('provider-action')
  for (const row of operations) {
    if (!['noop', 'update'].includes(row.action)) refuse('resource-action-refused', row.logicalId, undefined, row.action)
    if (['Database', 'Manifests'].includes(row.logicalId) && row.action !== 'noop') refuse('storage-write-refused', row.logicalId, undefined, row.action)
    const node = nativeResource(snapshot, row.logicalId)
    if (node === undefined) { refuse('native-plan-missing', row.logicalId); continue }
    const props = node.props ?? node.state?.props ?? {}
    const observed = live.workers[row.logicalId]
    const wires = wireBindings(node, { workerName: observed?.name ?? row.logicalId, stack, accountId })
    for (const binding of row.bindings) {
      if (binding.action === 'delete') refuse('binding-deletion-refused', row.logicalId, binding.sid)
      if (binding.action === 'noop') continue
      if (binding.sid.startsWith('Cron(')) {
        changes.scheduleChanges.push({ logicalId: row.logicalId, sid: binding.sid })
        continue
      }
      const native = node.bindings.find(entry => entry.sid === binding.sid)
      const bound = native?.data?.bindings ?? []
      for (const entry of bound) {
        const old = observed?.bindings.find(item => item.name === entry.name)
        if (old && entry.type !== 'inherit' && entry.type !== old.type) refuse('binding-type-change-refused', row.logicalId, entry.name)
      }
      const secrets = bound.filter(entry => entry.type === 'secret_text')
      // Secret creation and rotation can only be individual bindings. Grouped/inherited secrets stay unchanged.
      if (secrets.length !== 1 || bound.length !== 1 || secrets[0].name !== binding.sid) {
        if (binding.action === 'create') refuse('binding-creation-refused', row.logicalId, binding.sid)
        for (const entry of bound) if (['secret_text', 'inherit', 'durable_object_namespace', 'd1', 'r2_bucket', 'service'].includes(entry.type)) refuse('resource-binding-change-refused', row.logicalId, entry.name)
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
        if (wire.type !== old.type) refuse('binding-type-change-refused', row.logicalId, wire.name)
        else for (const field of sameIdentity(wire, old, observed.name, live.namespaces ?? [])) refuse('binding-identity-drift', row.logicalId, wire.name, undefined, field)
      }
      // The class migration the provider derives during upload from the live tags; engine actions never show it.
      const transition = durableObjectTransition(node, observed, live.namespaces ?? [])
      transitions[row.logicalId] = transition
      if (migratesClasses(transition)) {
        refuse('durable-object-migration-refused', row.logicalId)
        changes.migrations.push(`durable-object:${row.logicalId}`)
      }
      const oldNames = observed.bindings.map(binding => binding.name)
      const newNames = wires.map(binding => binding.name)
      for (const name of newNames) if (newNames.filter(candidate => candidate === name).length > 1) refuse('binding-deletion-refused', row.logicalId, name)
      for (const name of oldNames) if (!newNames.includes(name)) refuse('binding-deletion-refused', row.logicalId, name)
      const allowedNewNames = changes.secretChanges.filter(change => change.logicalId === row.logicalId && change.action === 'add').map(change => change.name)
      for (const name of newNames) if (!oldNames.includes(name) && !allowedNewNames.includes(name)) refuse('binding-creation-refused', row.logicalId, name)
      const crons = [...new Set([...(props.crons ?? []), ...node.bindings.flatMap(binding => binding.data?.crons ?? [])])].toSorted()
      if (!same(crons, observed.crons)) changes.scheduleChanges.push({ logicalId: row.logicalId })
      const intended = domainNames(props.domain).toSorted()
      const current = live.domains.filter(domain => domain.service === observed.name).map(domain => domain.hostname).toSorted()
      if (!same(intended, current)) {
        if (row.logicalId === 'Explore' && same(intended, current.filter(hostname => hostname !== 'hireling.xyz')) && process.env.HIRELING_APEX_REDIRECT === '0') {
          changes.domainChanges.push({ logicalId: 'Explore', hostname: 'hireling.xyz', action: 'release-alias', setting: 'HIRELING_APEX_REDIRECT', value: '0' })
        } else refuse('domain-change-refused', row.logicalId, 'domain')
      }
    }
  }
  const validation = validatePlanChanges(changes, reference)
  // Locate each rejected change without repeating its values. Keep manifest-wide failures separate.
  const empty = { migrations: [], secretChanges: [], resourceCreates: [], domainChanges: [], scheduleChanges: [] }
  for (const blocker of validation.blockers) {
    if (blocker === 'approved-change-manifest-mismatch') { refuse(blocker, 'ApprovedChanges'); continue }
    const before = blockers.size
    for (const [field, entries] of Object.entries(changes)) for (const entry of entries) {
      if (!validatePlanChanges({ ...empty, [field]: [entry] }, reference).blockers.includes(blocker)) continue
      refuse(blocker, entry.logicalId ?? 'Plan', entry.name ?? (field === 'domainChanges' ? 'domain' : field))
    }
    // Aggregate failures, such as duplicate individually-approved changes, still refuse.
    if (blockers.size === before) refuse(blocker, 'Plan')
  }
  return { ok: blockers.size === 0, blockers: [...blockers], operations, changes, transitions, approvedChanges: reference,
    expectedDomains: plannedDomains(changes, reference, live.domains.map(domain => domain.hostname)).toSorted() }
}
