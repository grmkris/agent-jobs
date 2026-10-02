import assert from 'node:assert/strict'
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import * as Effect from 'effect/Effect'
import * as Redacted from 'effect/Redacted'
import { canonicalChange } from './approved-changes.mjs'
import { nativeResource } from './live-plan.mjs'
import { artifactOf, commit, commitmentKey, digestOf, keyId, readViteEnvFiles, viteArtifact, viteArtifactNow, viteBuildEnv, wireBindings, workerPayload } from './payload.mjs'
import { sequenceWorkers } from './sequence.mjs'

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

// ---- review B12-003: Explore's Vite build environment ----

const exploreEnv = { AGENT_JOBS_NETWORK: 'monad-testnet', NODE_ENV: 'production', PRIVY_APP_ID: 'privy-test-marker', VITE_FLAG: 'on' }
const pin = (env, files = {}) => canonicalChange(viteArtifact(key, 'Explore', env, files))

test('B12-003: every build-time env input of Explore and its Vite env files are pinned, keyed, never printed', () => {
  const base = pin(exploreEnv)
  for (const [name, value] of [['AGENT_JOBS_NETWORK', 'monad-mainnet'], ['PRIVY_APP_ID', 'other'], ['HIRELING_PROD_PRIVY_APP_ID', 'prod-app'], ['NODE_ENV', 'development'], ['VITE_FLAG', 'off'], ['VITE_NEW', 'x']]) {
    assert.notEqual(pin({ ...exploreEnv, [name]: value }), base, name)
  }
  assert.notEqual(pin({ ...exploreEnv, PRIVY_APP_ID: '' }), pin({ ...exploreEnv, PRIVY_APP_ID: undefined }), 'unset and empty differ')
  assert.notEqual(pin(exploreEnv, { '.env.production': 'VITE_X=1' }), base, 'a Vite env file')
  assert.notEqual(pin(exploreEnv, { '.env.production': 'VITE_X=1' }), pin(exploreEnv, { '.env.production': 'VITE_X=2' }))
  assert.equal(pin({ ...exploreEnv, UNRELATED: 'x' }), base, 'variables the build does not read do not matter')
  assert.ok(!base.includes('privy-test-marker'))
})

const explore = new URL('../../apps/explore/', import.meta.url)
function buildSources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'e2e' || name === 'test' || name.startsWith('.')) continue
    const path = new URL(name, dir)
    if (statSync(path).isDirectory()) buildSources(new URL(`${name}/`, dir), out)
    else if (/\.(m?[jt]sx?)$/.test(name) && !/\.test\./.test(name)) out.push(path)
  }
  return out
}

test('B12-003: no Explore build source reads an environment variable that the Vite pin leaves out', () => {
  const reads = new Set()
  for (const path of buildSources(explore)) {
    const text = readFileSync(path, 'utf8')
    for (const match of text.matchAll(/process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])/g)) reads.add(match[1] ?? match[2])
    assert.ok(!/process\.env\s*\[\s*[^'"\s]/.test(text), `dynamic process.env access in ${path.pathname}`)
    assert.ok(!/import\.meta\.env\.(?!VITE_|MODE\b|DEV\b|PROD\b|SSR\b|BASE_URL\b)/.test(text), `non-VITE import.meta.env read in ${path.pathname}`)
  }
  assert.ok(reads.has('PRIVY_APP_ID') && reads.has('HIRELING_PROD_PRIVY_APP_ID') && reads.has('AGENT_JOBS_NETWORK'), 'the scan sees the known reads')
  for (const name of reads) assert.ok(viteBuildEnv.includes(name) || name.startsWith('VITE_'), `${name} is read by the Explore build but not pinned`)
})

// ---- review B12-SEC-004: Explore's build inputs are read again immediately before its upload ----

const exploreNode = { resource: { LogicalId: 'Explore', FQN: 'Explore', Type: 'Cloudflare.Worker' }, action: 'update', props: { vite: {}, compatibility: { date: '2026-09-01', flags: [] } }, bindings: [] }
const explorePayload = (artifact) => workerPayload({ key, logicalId: 'Explore', workerName: 'agentjobs-explore', stack, accountId, node: exploreNode, artifact })

/** The three Worker reconciles with release.mjs's Explore pre-upload check: the payload rebuilt from the env files and
 *  build environment as they are at upload time must still be the planned one. */
async function applyExplore(dir, envAtUpload, planned) {
  const events = []
  const snapshot = { native: { resources: Object.fromEntries(['Api', 'Indexer', 'Explore'].map((id) => [`AgentJobs/${id}`, {
    resource: { LogicalId: id }, action: 'update',
    provider: { reconcile: () => Effect.sync(() => { events.push(`upload:${id}`); return { hash: { bundle: id } } }) },
  }])) } }
  const checks = {
    before: (id) => Effect.gen(function* () {
      if (id !== 'Explore') return
      const again = explorePayload(viteArtifactNow(key, id, envAtUpload, dir))
      if (canonicalChange(again) !== canonicalChange(planned)) return yield* Effect.fail(new Error(`upload payload changed before upload: ${id}`))
    }),
  }
  const run = Effect.gen(function* () {
    yield* sequenceWorkers(snapshot, async () => {}, () => {}, checks)
    yield* Effect.all(['Api', 'Indexer', 'Explore'].map((id) => nativeResource(snapshot, id).provider.reconcile({})), { concurrency: 'unbounded' })
  })
  try {
    await Effect.runPromise(run)
    return { events, error: undefined }
  } catch (error) {
    return { events, error }
  }
}

test('B12-SEC-004: an Explore env file or build variable changed after the plan refuses before the Explore upload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'explore-'))
  try {
    writeFileSync(join(dir, '.env.production'), 'VITE_X=1\n')
    const planned = explorePayload(viteArtifact(key, 'Explore', exploreEnv, readViteEnvFiles(dir)))

    const unchanged = await applyExplore(dir, exploreEnv, planned)
    assert.equal(unchanged.error, undefined)
    assert.deepEqual(unchanged.events, ['upload:Api', 'upload:Indexer', 'upload:Explore'])

    const refused = async (label, env = exploreEnv) => {
      const { events, error } = await applyExplore(dir, env, planned)
      assert.match(String(error?.message ?? error), /upload payload changed before upload: Explore/, label)
      assert.deepEqual(events, ['upload:Api', 'upload:Indexer'], `${label}: Explore was not uploaded`)
    }
    writeFileSync(join(dir, '.env.production'), 'VITE_X=2\n')
    await refused('.env.production changed after the plan')
    writeFileSync(join(dir, '.env.production'), 'VITE_X=1\n')
    writeFileSync(join(dir, '.env.local'), 'VITE_Y=1\n')
    await refused('a new .env.local')
    rmSync(join(dir, '.env.local'))
    await refused('a new VITE_* variable', { ...exploreEnv, VITE_NEW: 'x' })
    await refused('PRIVY_APP_ID unset at plan, empty at upload', { ...exploreEnv, HIRELING_PROD_PRIVY_APP_ID: '' })
    assert.equal((await applyExplore(dir, exploreEnv, planned)).error, undefined, 'back to the planned inputs')

    rmSync(join(dir, '.env.production'))
    writeFileSync(join(dir, 'elsewhere'), 'VITE_X=1\n')
    symlinkSync(join(dir, 'elsewhere'), join(dir, '.env.production'))
    assert.throws(() => readViteEnvFiles(dir), /must not be a symlink/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
