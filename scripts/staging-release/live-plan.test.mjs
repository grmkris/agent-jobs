import assert from 'node:assert/strict'
import test from 'node:test'
import { describePlan } from 'alchemy/Plan'
import { havePropsChanged } from 'alchemy/Diff'
import { readApprovedChanges } from './approved-changes.mjs'
import { nativeResource, reviewLivePlan } from './live-plan.mjs'

const reference = readApprovedChanges().reference
const providerNames = ['ALCHEMY_PHASE', 'ALCHEMY_WORKER_NAME', 'ALCHEMY_STACK_NAME', 'ALCHEMY_STAGE', 'ALCHEMY_CLOUDFLARE_ACCOUNT_ID']
const binding = (sid, data, action = 'noop') => ({ sid, action, data })

function fixture() {
  const workers = {
    Api: {
      name: 'api', crons: [],
      tags: ['alchemy:stack:AgentJobs', 'alchemy:stage:staging', 'alchemy:dos:DirectoryObject', 'alchemy:migration-tag:alchemy:v2'],
      bindings: [
        { name: 'RELAY_PRIVATE_KEY', type: 'secret_text' }, { name: 'Legacy', type: 'secret_text' },
        { name: 'DirectoryObject', type: 'durable_object_namespace', class_name: 'DirectoryObject', namespace_id: 'ns-directory' },
        { name: 'DIRECTORY_DATABASE', type: 'd1', id: 'directory-db' },
      ],
    },
    Indexer: { name: 'indexer', bindings: [], crons: ['* * * * *'] },
    Explore: { name: 'explore', bindings: [{ name: 'ASSETS', type: 'assets' }], crons: [] },
  }
  for (const worker of Object.values(workers)) worker.bindings.push(...providerNames.map(name => ({ name, type: 'plain_text' })))
  const native = { resources: {}, deletions: {}, actions: {}, actionDeletions: {} }
  for (const id of ['Api', 'Indexer', 'Explore', 'Database', 'Manifests']) {
    const props = id === 'Explore' ? { assets: {}, domain: { name: 'testnet.hireling.xyz', aliases: ['hireling.xyz'] } } : {}
    const bindings = id === 'Api' ? [
      binding('RELAY_PRIVATE_KEY', { bindings: [{ name: 'RELAY_PRIVATE_KEY', type: 'secret_text', text: 'test-only-marker' }] }),
      binding('LegacySecrets', { bindings: [{ name: 'Legacy', type: 'inherit' }] }),
      binding('DirectoryObject', { bindings: [{ name: 'DirectoryObject', type: 'durable_object_namespace', className: 'DirectoryObject' }] }),
      binding('DIRECTORY_DATABASE', { bindings: [{ name: 'DIRECTORY_DATABASE', type: 'd1', databaseId: 'directory-db' }] }),
    ] : id === 'Indexer' ? [binding('Cron(* * * * *)', { crons: ['* * * * *'] })] : []
    native.resources[`AgentJobs/${id}`] = { resource: { LogicalId: id, FQN: `AgentJobs/${id}`, Type: 'test' }, action: id === 'Database' || id === 'Manifests' ? 'noop' : 'update', props, state: { props }, bindings }
  }
  const live = {
    workers, domains: ['hireling.xyz', 'testnet.hireling.xyz'].map(hostname => ({ hostname, service: 'explore' })),
    namespaces: [{ id: 'ns-directory', className: 'DirectoryObject', script: 'api' }],
  }
  const snapshot = { native, ...describePlan(native), summary: { create: 0, delete: 0, replace: 0, orphaned: 0, adopted: 0 } }
  return { snapshot, live }
}

const review = ({ snapshot, live }, sameSecret = () => false) => reviewLivePlan({ ...snapshot, ...describePlan(snapshot.native) }, live, reference, sameSecret)

test('native Alchemy describePlan format preserves inherited and provider-generated binding keys', () => {
  const input = fixture()
  assert.equal(nativeResource(input.snapshot, 'Api').resource.FQN, 'AgentJobs/Api')
  assert.equal(review(input).ok, true)
  assert.ok(!JSON.stringify(review(input)).includes('test-only-marker'))
})

test('live runner admits a listed rotation and individual Telegram addition with names only', () => {
  const input = fixture()
  nativeResource(input.snapshot, 'Api').bindings[0].action = 'update'
  nativeResource(input.snapshot, 'Api').bindings.push(binding('TELEGRAM_BOT_TOKEN', { bindings: [{ type: 'secret_text', name: 'TELEGRAM_BOT_TOKEN', text: 'test-only-marker' }] }, 'create'))
  const result = review(input)
  assert.equal(result.ok, true)
  assert.deepEqual(result.changes.secretChanges, [
    { logicalId: 'Api', name: 'RELAY_PRIVATE_KEY', action: 'rotate' },
    { logicalId: 'Api', name: 'TELEGRAM_BOT_TOKEN', action: 'add' },
  ])
  assert.ok(!JSON.stringify(result).includes('test-only-marker'))
})

test('an unchanged secret after newline normalization does not require rotation approval', () => {
  const input = fixture()
  nativeResource(input.snapshot, 'Api').bindings[0].action = 'update'
  assert.deepEqual(review(input, () => true).changes.secretChanges, [])
})

test('live runner refuses unlisted, grouped, converted, deleted and non-secret new bindings', () => {
  for (const candidate of [
    binding('UNLISTED_TOKEN', { bindings: [{ type: 'secret_text', name: 'UNLISTED_TOKEN', text: 'test-only-marker' }] }, 'create'),
    binding('Group', { bindings: [{ type: 'secret_text', name: 'TELEGRAM_BOT_TOKEN' }, { type: 'secret_text', name: 'TELEGRAM_WEBHOOK_SECRET' }] }, 'create'),
    binding('RELAY_PRIVATE_KEY', { bindings: [{ type: 'plain_text', name: 'RELAY_PRIVATE_KEY', text: 'test-only-marker' }] }, 'update'),
    binding('RELAY_PRIVATE_KEY', { bindings: [] }, 'delete'),
    binding('NewSetting', { bindings: [{ type: 'plain_text', name: 'NewSetting' }] }, 'create'),
  ]) {
    const input = fixture()
    const node = nativeResource(input.snapshot, 'Api')
    node.bindings = node.bindings.filter(entry => entry.sid !== candidate.sid)
    node.bindings.push(candidate)
    const result = review(input)
    assert.equal(result.ok, false)
    assert.ok(!JSON.stringify(result).includes('test-only-marker'))
  }
})

test('migrations, resource creates, storage updates, schedules and directory changes remain refused', () => {
  for (const mutate of [
    input => { input.snapshot.native.actions.sql = { def: { FQN: 'sql', LogicalId: 'sql', Type: 'migration' }, action: 'run' } },
    input => { input.snapshot.summary.create = 1 },
    input => { nativeResource(input.snapshot, 'Database').action = 'update' },
    input => { nativeResource(input.snapshot, 'Indexer').bindings[0].data.crons = ['*/2 * * * *'] },
    input => { nativeResource(input.snapshot, 'Api').bindings.push(binding('DirectoryObject', { bindings: [{ type: 'durable_object_namespace', name: 'DirectoryObject', className: 'DirectoryObject' }] }, 'create')) },
  ]) {
    const input = fixture()
    mutate(input)
    assert.equal(review(input).ok, false)
  }
})

test('protection blockers identify the logical resource and binding without exposing values', () => {
  const storage = fixture()
  nativeResource(storage.snapshot, 'Manifests').action = 'update'
  const storageResult = review(storage)
  assert.ok(storageResult.blockers.includes('storage-write-refused(Manifests: update)'), storageResult.blockers.join(','))

  const bindingDrift = fixture()
  liveBinding(bindingDrift, 'DirectoryObject').namespace_id = 'secret-namespace-value'
  const bindingResult = review(bindingDrift)
  assert.ok(bindingResult.blockers.includes('binding-identity-drift(Api.DirectoryObject)'), bindingResult.blockers.join(','))
  assert.ok(!bindingResult.blockers.some(blocker => blocker.includes('secret-namespace-value')))
})

test('omitting the deployed migration input requests a Database update under the pinned engine fallback', () => {
  const deployed = { migrations: '/test-only/migrations' }
  // Database.diff returns undefined when migrations are omitted; Plan then falls back to havePropsChanged.
  assert.equal(havePropsChanged(deployed, {}), true)
  assert.equal(havePropsChanged(deployed, { ...deployed }), false)
  const input = fixture()
  nativeResource(input.snapshot, 'Database').action = 'update'
  assert.ok(review(input).blockers.includes('storage-write-refused(Database: update)'))
})

test('aggregate duplicate approval failures remain refused after adding contextual labels', () => {
  const input = fixture()
  const node = nativeResource(input.snapshot, 'Api')
  node.bindings[0].action = 'update'
  input.snapshot.native.resources['DuplicateApi'] = { ...node, resource: { ...node.resource, FQN: 'DuplicateApi' } }
  const result = review(input)
  assert.equal(result.ok, false)
  assert.ok(result.blockers.includes('unapproved-additive-or-config-change(Plan)'))
})

test('the exact apex release requires its setting and preserves the testnet domain', () => {
  const prior = process.env.HIRELING_APEX_REDIRECT
  try {
    const input = fixture()
    nativeResource(input.snapshot, 'Explore').props.domain.aliases = []
    process.env.HIRELING_APEX_REDIRECT = '1'
    assert.equal(review(input).ok, false)
    process.env.HIRELING_APEX_REDIRECT = '0'
    const result = review(input)
    assert.equal(result.ok, true)
    assert.deepEqual(result.expectedDomains, ['testnet.hireling.xyz'])
    nativeResource(input.snapshot, 'Explore').props.domain.name = 'other.hireling.xyz'
    assert.equal(review(input).ok, false)
  } finally {
    if (prior === undefined) delete process.env.HIRELING_APEX_REDIRECT
    else process.env.HIRELING_APEX_REDIRECT = prior
  }
})

// ---- review B12-002 ----

const liveBinding = (input, name) => input.live.workers.Api.bindings.find(item => item.name === name)

test('B12-002: the reviewed transition is pinned: a tag bump with no class migration passes', () => {
  const result = review(fixture())
  assert.equal(result.ok, true, result.blockers.join(','))
  assert.deepEqual(result.transitions.Api, {
    oldTag: 'alchemy:v2', newTag: 'alchemy:v3', durableObjectTags: ['alchemy:dos:DirectoryObject'],
    newSqliteClasses: [], renamedClasses: [], deletedClasses: [], transferredClasses: [],
  })
  assert.deepEqual(result.changes.migrations, [])
})

test('B12-002: a noop directory binding whose live class, namespace or database drifted is refused', () => {
  for (const drift of [
    input => { liveBinding(input, 'DirectoryObject').class_name = 'OldDirectory' },
    input => { liveBinding(input, 'DirectoryObject').namespace_id = 'ns-elsewhere' },
    input => { input.live.namespaces = [{ id: 'ns-directory', className: 'DirectoryObject', script: 'other-script' }] },
    input => { liveBinding(input, 'DirectoryObject').script_name = 'other-script' },
    input => { liveBinding(input, 'DIRECTORY_DATABASE').id = 'another-db' },
    input => { liveBinding(input, 'DIRECTORY_DATABASE').type = 'plain_text' },
  ]) {
    const input = fixture()
    assert.equal(nativeResource(input.snapshot, 'Api').bindings.find(entry => entry.sid === 'DirectoryObject').action, 'noop')
    drift(input)
    const result = review(input)
    assert.equal(result.ok, false)
    assert.ok(result.blockers.some(blocker => blocker.startsWith('binding-identity-drift(') || blocker.startsWith('binding-type-change-refused(')), result.blockers.join(','))
  }
})

test('B12-002: a class migration the provider would derive from live tags is refused with empty engine actions', () => {
  const cases = [
    // live tags map the logical id to another class: the upload would rename OldDirectory → DirectoryObject
    [input => { input.live.workers.Api.tags[2] = 'alchemy:dos:DirectoryObject=OldDirectory' }, 'renamedClasses'],
    // live tags list a hosted class the plan no longer binds: the upload would delete it
    [input => {
      input.live.workers.Api.tags[2] = 'alchemy:dos:DirectoryObject;Retired'
      input.live.namespaces.push({ id: 'ns-retired', className: 'Retired', script: 'api' })
    }, 'deletedClasses'],
    // a planned class the live script has never hosted: the upload would create it
    [input => {
      nativeResource(input.snapshot, 'Api').bindings.find(entry => entry.sid === 'DirectoryObject').data.bindings[0].className = 'DirectoryObjectV2'
      liveBinding(input, 'DirectoryObject').class_name = 'DirectoryObjectV2'
      input.live.workers.Api.tags[2] = 'alchemy:dos:Unrelated=Other'
      liveBinding(input, 'DirectoryObject').name = 'DirectoryObjectLegacyName'
    }, 'newSqliteClasses'],
  ]
  for (const [mutate, field] of cases) {
    const input = fixture()
    mutate(input)
    assert.equal(input.snapshot.actions?.length ?? 0, 0)
    const result = review(input)
    assert.equal(result.ok, false)
    assert.ok(result.blockers.some(blocker => blocker.startsWith('durable-object-migration-refused(')), result.blockers.join(','))
    assert.ok(result.transitions.Api[field].length > 0, field)
    assert.deepEqual(result.changes.migrations, ['durable-object:Api'])
  }
})
