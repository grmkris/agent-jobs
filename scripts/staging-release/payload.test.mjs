import assert from 'node:assert/strict'
import { lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import * as Effect from 'effect/Effect'
import * as Redacted from 'effect/Redacted'
import { canonicalChange } from './approved-changes.mjs'
import { artifactOf, commit, commitmentKey, digestOf, keyId, wireBindings, workerPayload } from './payload.mjs'

const key = Buffer.alloc(32, 7)
const stack = { name: 'AgentJobs', stage: 'staging' }
const accountId = 'bceaeae4788dce3493514fde194b4a7e'
const binding = (sid, data, action = 'noop') => ({ sid, action, data })
/** Stands in for a resource reference in `env` (e.g. `DIRECTORY_DATABASE: Database`). */
function DatabaseResource() {}

function apiNode({ secret = 'secret-A-marker', plain = 'plain-A-marker', flags = ['nodejs_compat'] } = {}) {
  const props = { main: '/repo/apps/api/src/worker.ts', compatibility: { date: '2026-09-01', flags }, env: { NETWORK: 'monad-testnet' } }
  return {
    resource: { LogicalId: 'Api', FQN: 'Api', Type: 'Cloudflare.Worker' }, action: 'update', props, state: { props },
    bindings: [
      binding('RELAY_PRIVATE_KEY', { bindings: [{ type: 'secret_text', name: 'RELAY_PRIVATE_KEY', text: secret }] }, 'update'),
      binding('PUBLIC_ORIGIN', { bindings: [{ type: 'plain_text', name: 'PUBLIC_ORIGIN', text: plain }] }),
      binding('Database', { bindings: [{ type: 'd1', name: 'Database', databaseId: '1b2ddfdd-650e-4846-8b55-fca07872efec' }] }),
      binding('DirectoryObject', { bindings: [{ type: 'durable_object_namespace', name: 'DirectoryObject', className: 'DirectoryObject' }] }),
    ],
  }
}

const bundle = (text = 'export default {}') => ({ main: 'worker.js', hash: 'provider-hash', files: [{ path: 'worker.js', content: text, hash: 'x' }] })

async function digest(node, artifactBundle = bundle()) {
  const artifact = await artifactOf(artifactBundle)
  const payload = { keyId: keyId(key), workers: { Api: workerPayload({ key, logicalId: 'Api', workerName: 'agentjobs-api', stack, accountId, node, artifact }) } }
  return { payload, digest: digestOf(canonicalChange, { payload }) }
}

test('B12-001: a new value for a listed secret, same SID and action, changes the digest; no value is printed', async () => {
  const a = await digest(apiNode())
  const b = await digest(apiNode({ secret: 'secret-B-marker' }))
  assert.notEqual(b.digest, a.digest, 'the earlier digest must not apply to the rotated value')
  for (const run of [a, b]) {
    const printed = JSON.stringify(run.payload)
    assert.ok(!printed.includes('secret-A-marker') && !printed.includes('secret-B-marker'))
  }
  const relay = a.payload.workers.Api.bindings.find(item => item.name === 'RELAY_PRIVATE_KEY')
  assert.deepEqual(Object.keys(relay).toSorted(), ['name', 'text', 'type'])
  assert.match(relay.text.commitment, /^[a-f0-9]{64}$/)
})

test('B12-001: a new value for an existing plain-text binding changes the digest, without printing it', async () => {
  const a = await digest(apiNode())
  const b = await digest(apiNode({ plain: 'plain-B-marker' }))
  assert.notEqual(b.digest, a.digest)
  assert.ok(!JSON.stringify(b.payload).includes('plain-B-marker'))
})

test('B12-001: a Worker setting and the artifact bytes are pinned without any operation name changing', async () => {
  const a = await digest(apiNode())
  assert.notEqual((await digest(apiNode({ flags: ['nodejs_compat', 'nodejs_als'] }))).digest, a.digest, 'compatibility flags')
  assert.notEqual((await digest(apiNode(), bundle('export default { fetch() {} }'))).digest, a.digest, 'artifact bytes')
  assert.equal((await digest(apiNode())).digest, a.digest, 'deterministic for the same inputs')
})

test('B12-001: commitments are keyed: a guessable value cannot be checked against the packet without the key', () => {
  const scope = ['Api', 'binding', 'PIN']
  assert.notEqual(commit(key, scope, '1234'), commit(Buffer.alloc(32, 8), scope, '1234'))
  assert.notEqual(commit(key, scope, '1234'), commit(key, ['Indexer', 'binding', 'PIN'], '1234'), 'scoped per Worker and binding')
  assert.notEqual(keyId(key), keyId(Buffer.alloc(32, 8)))
})

test('B12-001: wire bindings follow the provider: ALCHEMY_* settings, then env (Redacted → secret, string → plain, else json)', () => {
  const node = apiNode()
  node.props.env = { RELAY_PRIVATE_KEY: 'shadowed-by-the-binding', TOKEN: Redacted.make('t-marker'), MODE: 'live', LIMITS: { max: 3 }, GONE: undefined, RESOURCE: DatabaseResource, LAZY: Effect.succeed('x') }
  node.bindings.push(binding('Bound', { env: { EXTRA: 'from-binding-data' } }))
  const wires = wireBindings(node, { workerName: 'agentjobs-api', stack, accountId })
  const byName = Object.fromEntries(wires.map(wire => [wire.name, wire]))
  assert.equal(byName.RELAY_PRIVATE_KEY.text, 'secret-A-marker', 'a bound name is not overridden by env')
  assert.deepEqual(byName.TOKEN, { type: 'secret_text', name: 'TOKEN', text: 't-marker' })
  assert.deepEqual(byName.MODE, { type: 'plain_text', name: 'MODE', text: 'live' })
  assert.deepEqual(byName.LIMITS, { type: 'json', name: 'LIMITS', json: { max: 3 } })
  assert.deepEqual(byName.EXTRA, { type: 'plain_text', name: 'EXTRA', text: 'from-binding-data' })
  assert.equal(byName.GONE, undefined)
  assert.equal(byName.RESOURCE, undefined, 'resource references bind through their own binding')
  assert.equal(byName.LAZY, undefined)
  assert.deepEqual(['ALCHEMY_PHASE', 'ALCHEMY_WORKER_NAME', 'ALCHEMY_STACK_NAME', 'ALCHEMY_STAGE', 'ALCHEMY_CLOUDFLARE_ACCOUNT_ID'].map(name => byName[name].text),
    ['runtime', 'agentjobs-api', 'AgentJobs', 'staging', accountId])
  const payload = workerPayload({ key, logicalId: 'Api', workerName: 'agentjobs-api', stack, accountId, node, artifact: { kind: 'unchanged' } })
  assert.ok(!JSON.stringify(payload).includes('t-marker'))
  const database = payload.bindings.find(item => item.name === 'Database')
  assert.equal(database.databaseId, '1b2ddfdd-650e-4846-8b55-fca07872efec', 'resource identities stay readable')
})

test('artifactOf hashes provider bundle files and File-like uploads alike', async () => {
  const fromBundle = await artifactOf(bundle('abc'))
  const fromFiles = await artifactOf({ main: 'worker.js', files: [new File(['abc'], 'worker.js')] })
  assert.deepEqual(fromBundle.files, fromFiles.files)
  await assert.rejects(() => artifactOf({ files: [] }))
})

test('the commitment key is created once, private, and a symlink or readable key is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'commitment-key-'))
  try {
    const path = join(dir, 'commitment.key')
    const first = commitmentKey(path)
    assert.equal(first.length, 32)
    assert.equal(lstatSync(path).mode & 0o777, 0o600)
    assert.deepEqual(commitmentKey(path), first)
    const link = join(dir, 'link.key')
    symlinkSync(path, link)
    assert.throws(() => commitmentKey(link))
    const loose = join(dir, 'loose.key')
    writeFileSync(loose, 'a'.repeat(64), { mode: 0o644 })
    assert.throws(() => commitmentKey(loose))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
