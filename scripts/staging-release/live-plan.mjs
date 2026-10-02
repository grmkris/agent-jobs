import { canonicalChange, plannedDomains, validatePlanChanges } from './approved-changes.mjs'

const wireBindings = node => (node?.bindings ?? []).flatMap(binding => binding.data?.bindings ?? [])
const domainNames = value => value === undefined || value === null ? [] : typeof value === 'string'
  ? [value] : [value.name, ...(value.aliases ?? []), ...(value.redirects ?? [])]
const same = (left, right) => canonicalChange(left) === canonicalChange(right)
const providerBindingNames = ['ALCHEMY_PHASE', 'ALCHEMY_WORKER_NAME', 'ALCHEMY_STACK_NAME', 'ALCHEMY_STAGE', 'ALCHEMY_CLOUDFLARE_ACCOUNT_ID']

// These bindings are appended during upload by the pinned Worker provider,
// rather than appearing as BindingNodes in the engine plan.
const uploadBindings = (node, props) => {
  const wires = wireBindings(node)
  for (const name of providerBindingNames) wires.push({ type: 'plain_text', name })
  if (props.assets) wires.push({ type: 'assets', name: 'ASSETS' })
  return wires
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
    const wires = uploadBindings(node, props)
    const observed = live.workers[row.logicalId]
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
  return { ok: blockers.size === 0, blockers: [...blockers], operations, changes, approvedChanges: reference,
    expectedDomains: plannedDomains(changes, reference, live.domains.map(domain => domain.hostname)).toSorted() }
}
