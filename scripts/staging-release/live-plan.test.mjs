import assert from 'node:assert/strict'
import test from 'node:test'
import { describePlan } from 'alchemy/Plan'
import { readApprovedChanges } from './approved-changes.mjs'
import { nativeResource, reviewLivePlan } from './live-plan.mjs'

const reference = readApprovedChanges().reference
const providerNames = ['ALCHEMY_PHASE', 'ALCHEMY_WORKER_NAME', 'ALCHEMY_STACK_NAME', 'ALCHEMY_STAGE', 'ALCHEMY_CLOUDFLARE_ACCOUNT_ID']
const binding = (sid, data, action = 'noop') => ({ sid, action, data })

function fixture() {
  const workers = {
    Api: { name: 'api', bindings: [{ name: 'RELAY_PRIVATE_KEY', type: 'secret_text' }, { name: 'Legacy', type: 'secret_text' }], crons: [] },
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
    ] : id === 'Indexer' ? [binding('Cron(* * * * *)', { crons: ['* * * * *'] })] : []
    native.resources[`AgentJobs/${id}`] = { resource: { LogicalId: id, FQN: `AgentJobs/${id}`, Type: 'test' }, action: id === 'Database' || id === 'Manifests' ? 'noop' : 'update', props, state: { props }, bindings }
  }
  const live = { workers, domains: ['hireling.xyz', 'testnet.hireling.xyz'].map(hostname => ({ hostname, service: 'explore' })) }
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
