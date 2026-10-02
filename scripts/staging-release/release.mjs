import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import * as Effect from 'effect/Effect'
import { StagingReleaseError, reportReleaseFailure, runStagingEffect } from './errors.mjs'
import { prepareArtifacts, storedBundle } from './artifacts.mjs'
import { readApprovedChanges } from './approved-changes.mjs'
import { nativeResource, reviewLivePlan } from './live-plan.mjs'
import { artifactOf, commitmentKey, durableObjectTransition, keyId, viteArtifactNow, workerPayload } from './payload.mjs'

const repo = resolve(new URL('../..', import.meta.url).pathname)
const state = await import('./state.ts')
const { census, liveNamespaces, liveWorker, verifyWorker } = await import('./cloudflare.mjs')
const stack = { name: 'AgentJobs', stage: 'staging' }
const workerIds = ['Api', 'Indexer', 'Explore']
const exploreDir = resolve(repo, 'apps/explore')
const args = process.argv.slice(2)
if (!((args[0] === 'plan' && args.length === 1) || (args[0] === 'apply' && args.length === 2 && /^[a-f0-9]{64}$/.test(args[1])))) {
  const { evaluateStagingCommand } = await import('./entrypoint.mjs')
  console.log(JSON.stringify(evaluateStagingCommand(args)))
  process.exit(1)
}

function fail(code) {
  throw new StagingReleaseError(code)
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).toSorted().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function git(...gitArgs) {
  return execFileSync('git', gitArgs, { cwd: repo, encoding: 'utf8' }).trim()
}

function preflight() {
  if (git('branch', '--show-current') !== 'main') fail('guard-checkout-not-main')
  if (git('diff', '--name-only').length > 0 || git('diff', '--cached', '--name-only').length > 0) fail('guard-tracked-changes')
  state.inspectStagingState()
  const unknown = git('ls-files', '--others', '--exclude-standard').split('\n').filter((name) => name && !name.startsWith('.artifact-video/') && !name.startsWith('packages/sdk/scripts/.local/'))
  if (unknown.length) fail('guard-untracked-source')
  const localEnv = parseEnv(readFileSync(resolve(repo, '.env.local'), 'utf8'))
  // This checkout's deployment credentials are authoritative; a login shell can
  // carry unrelated credentials for another product.
  Object.assign(process.env, localEnv)
  process.env.ALCHEMY_STATE_MODE = 'local'
  process.env.ALCHEMY_REMOTE_STATE = '0'
  process.env.AGENT_JOBS_STAGE = 'staging'
  process.env.AGENT_JOBS_NETWORK = 'monad-testnet'
  process.env.AGENT_JOBS_APPLY_MIGRATIONS = '1'
  process.env.AGENT_JOBS_WITHOUT_EXPLORE = '0'
  process.env.NODE_ENV = 'production'
  process.env.CLOUDFLARE_ACCOUNT_ID = state.accountId
  for (const name of ['CLOUDFLARE_API_TOKEN', 'MONAD_TESTNET_RPC_URL', 'AI_GATEWAY_API_KEY', 'ATTESTER_PRIVATE_KEY', 'RELAY_PRIVATE_KEY', 'GITHUB_APP_PRIVATE_KEY', 'HYPERSYNC_API_TOKEN']) {
    if (!process.env[name] || process.env[name] === 'unset') fail('guard-credential-missing')
  }
  execFileSync(process.execPath, ['scripts/db-generate.mjs', '--check'], { cwd: repo, stdio: 'pipe' })
}

function sameSecretAfterNewlineNormalization(logicalId, name) {
  const current = process.env[name]
  if (typeof current !== 'string') return false
  if (!['Api', 'Indexer'].includes(logicalId)) return false
  const record = JSON.parse(readFileSync(resolve(repo, `.alchemy/state/AgentJobs/staging/${logicalId}.json`), 'utf8'))
  const binding = record.bindings?.find((item) => item.sid === name)?.data?.bindings?.find((item) => item.name === name)
  return typeof binding?.text === 'string' && binding.text.replaceAll('\\n', '\n') === current.replaceAll('\\n', '\n')
}

function safePlan(snapshot, live, reference) {
  const reviewed = reviewLivePlan(snapshot, live, reference, sameSecretAfterNewlineNormalization)
  if (!reviewed.ok) {
    // The review builds these contextual labels through fixed field/action/name sanitizers.
    console.error(`staging release refused: plan protection failed: ${reviewed.blockers.join(', ')}`)
    fail('guard-plan-protection-failed')
  }
  const operations = reviewed.operations
  const api = operations.find((row) => row.logicalId === 'Api')
  const directory = api?.bindings.find((binding) => binding.sid === 'DirectoryObject')
  const directoryDb = api?.bindings.find((binding) => binding.sid === 'DIRECTORY_DATABASE')
  if (snapshot.summary.create !== 0 || snapshot.summary.delete !== 0 || snapshot.summary.replace !== 0 || snapshot.summary.orphaned !== 0 || snapshot.summary.adopted !== 0) fail('guard-resource-action-refused')
  if (snapshot.resources.some((resource) => !['noop', 'update'].includes(resource.action))) fail('guard-resource-action-refused')
  if (directory?.action !== 'noop' || directoryDb?.action !== 'noop') fail('guard-directory-binding-drift')
  if (operations.length !== 5 || Object.keys(state.targets).some((id) => operations.filter((row) => row.logicalId === id && row.fqn === id).length !== 1) || snapshot.actions.length) fail('guard-resource-census-invalid')
  for (const id of Object.keys(state.targets)) {
    const node = nativeResource(snapshot, id)
    if (node === undefined) fail('guard-native-resource-missing')
    state.validateStateRecord(node.resource.LogicalId, node.state)
    if (node.mode !== 'live' || node.renamedFrom?.length) fail('guard-state-mode-drift')
  }
  if (operations.find((row) => row.logicalId === 'Manifests').action !== 'noop') fail('guard-manifests-update-refused')
  if (operations.some((row) => row.bindings.some((binding) => binding.action === 'delete'))) fail('guard-binding-deletion-refused')
  return { summary: snapshot.summary, operations, approvedChanges: reviewed.approvedChanges, changes: reviewed.changes, transitions: reviewed.transitions, expectedDomains: reviewed.expectedDomains }
}

const payloadOf = (snapshot, key, artifacts) => ({
  keyId: keyId(key),
  workers: Object.fromEntries(workerIds.map((id) => [id, workerPayload({
    key, logicalId: id, workerName: state.targets[id], stack, accountId: state.accountId, node: nativeResource(snapshot, id), artifact: artifacts[id],
  })])),
})

async function run() {
  preflight()
  const before = await census()
  const source = { commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') }
  const stateDigests = state.inspectStagingState()
  const approvedChanges = readApprovedChanges().reference
  const migrationSha256 = createHash('sha256').update(readFileSync(resolve(repo, 'apps/api/migrations/0001_directory_agents.sql'))).digest('hex')
  await import(resolve(repo, 'node_modules/alchemy/bin/register-oxc.js'))
  const Alchemist = await import('alchemy/Alchemist')
  const { ArtifactStore } = await import('alchemy/Artifacts')
  const { sequenceWorkers } = await import('./sequence.mjs')
  const root = resolve(repo, '.alchemy/recovery')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const lock = resolve(root, 'release.lock')
  writeFileSync(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 })
  try {
    // Plan and apply share a single Effect scope: the provider session must stay alive.
    await runStagingEffect(Effect.gen(function* () {
      const snapshot = yield* Alchemist.Stack.plan({
        target: { entrypoint: resolve(repo, 'alchemy.run.ts'), stage: 'staging', envFile: resolve(repo, '.env.local') },
        operation: 'deploy', adopt: false, updateStateStore: false,
      })
      const safe = safePlan(snapshot, before, approvedChanges)
      const key = commitmentKey(resolve(root, 'commitment.key'))
      const artifacts = yield* prepareArtifacts(snapshot, key, { exploreDir })
      const payload = payloadOf(snapshot, key, artifacts)
      const reviewed = { source, stateDigests, migrationSha256, live: before, ...safe, payload }
      const digest = createHash('sha256').update(canonical(reviewed)).digest('hex')
      const packet = { schemaVersion: 1, stage: 'staging', network: 'monad-testnet', digest, ...reviewed }
      if (args[0] === 'plan') {
        writeFileSync(resolve(root, 'plan.json'), JSON.stringify(packet, null, 2), { mode: 0o600 })
        console.log(JSON.stringify(packet))
        return
      }
      if (args[1] !== digest) fail('guard-apply-digest-mismatch')
      if (git('rev-parse', 'HEAD') !== source.commit || git('diff', '--name-only')) fail('guard-checkout-changed')
      if (canonical(readApprovedChanges().reference) !== canonical(approvedChanges)) fail('guard-approved-changes-changed')
      if (canonical(state.inspectStagingState()) !== canonical(stateDigests) || canonical(yield* Effect.promise(census)) !== canonical(before)) fail('guard-live-state-changed')
      const runRoot = resolve(root, `release-${Date.now()}`)
      mkdirSync(runRoot, { mode: 0o700 })
      cpSync(state.stateRoot, resolve(runRoot, 'state'), { recursive: true })
      const journal = { ...packet, startedAt: new Date().toISOString(), status: 'applying', workers: [] }
      writeFileSync(resolve(runRoot, 'journal.json'), JSON.stringify(journal, null, 2), { mode: 0o600 })
      // Immediately before each upload: the payload the reconcile is about to send (its props, bindings and the
      // cached build it will upload) must still be the reviewed one, and the Durable Object transition derived from a
      // fresh read of the live script must still be the reviewed one (B12-001, B12-002).
      const checks = {
        before: (id, input) => Effect.gen(function* () {
          const node = { ...nativeResource(snapshot, id), props: input.news, bindings: input.bindings }
          let artifact = artifacts[id]
          // B12-SEC-004: Explore's build env and env files are read again here, not taken from the plan.
          if (artifact.kind === 'vite') artifact = viteArtifactNow(key, id, process.env, exploreDir)
          if (artifact.kind === 'bundle') {
            const store = yield* ArtifactStore
            const build = yield* storedBundle(store, node.resource.FQN, id)
            artifact = yield* Effect.promise(() => artifactOf(build))
          }
          const again = workerPayload({ key, logicalId: id, workerName: state.targets[id], stack, accountId: state.accountId, node, artifact })
          if (canonical(again) !== canonical(payload.workers[id])) fail('guard-upload-payload-changed')
          const fresh = yield* Effect.promise(() => liveWorker(id))
          const namespaces = yield* Effect.promise(liveNamespaces)
          if (canonical(durableObjectTransition(node, fresh, namespaces)) !== canonical(safe.transitions[id])) fail('guard-do-transition-changed')
        }),
        after: (id, output) => Effect.sync(() => {
          const planned = artifacts[id]
          if (planned.kind === 'bundle' && planned.providerHash !== null && output?.hash?.bundle !== planned.providerHash) fail('guard-uploaded-bundle-mismatch')
        }),
      }
      yield* sequenceWorkers(snapshot, verifyWorker, (event) => {
        journal.workers.push(event)
        writeFileSync(resolve(runRoot, 'journal.json'), JSON.stringify(journal, null, 2), { mode: 0o600 })
      }, checks)
      yield* Alchemist.Stack.apply(snapshot)
      for (const id of ['Api', 'Indexer', 'Explore']) {
        let verified = false
        for (let attempt = 0; attempt < 12; attempt++) {
          const check = yield* Effect.promise(() => verifyWorker(id).then(() => true, () => false))
          if (check) { verified = true; break }
          yield* Effect.sleep('5 seconds')
        }
        if (!verified) fail('guard-post-upload-verification-failed')
      }
      const after = yield* Effect.promise(() => census({ domains: safe.expectedDomains }))
      journal.status = 'verified'
      journal.versions = Object.fromEntries(Object.entries(after.workers).map(([id, worker]) => [id, worker.version]))
      writeFileSync(resolve(runRoot, 'journal.json'), JSON.stringify(journal, null, 2), { mode: 0o600 })
      writeFileSync(resolve(root, 'last-apply.json'), JSON.stringify(journal, null, 2), { mode: 0o600 })
      console.log(JSON.stringify({ ok: true, digest, applied: true, versions: journal.versions }))
    }).pipe(Effect.provide(Alchemist.layer()), Effect.scoped))
  } finally {
    unlinkSync(lock)
  }
}

try { await run() } catch (error) {
  // Provider failures may contain request bodies. Never print a raw Effect cause.
  reportReleaseFailure(error)
  process.exitCode = 1
}
