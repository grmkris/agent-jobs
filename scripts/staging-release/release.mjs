import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'

const repo = resolve(new URL('../..', import.meta.url).pathname)
const state = await import('./state.ts')
const { census, verifyWorker } = await import('./cloudflare.mjs')
const args = process.argv.slice(2)
if (!((args[0] === 'plan' && args.length === 1) || (args[0] === 'apply' && args.length === 2 && /^[a-f0-9]{64}$/.test(args[1])))) {
  const { evaluateStagingCommand } = await import('./entrypoint.mjs')
  console.log(JSON.stringify(evaluateStagingCommand(args)))
  process.exit(1)
}

function fail(message) {
  console.error(`staging release refused: ${message}`)
  process.exitCode = 1
  throw new Error(message)
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).toSorted().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function git(...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
}

function preflight() {
  if (git('branch', '--show-current') !== 'main') fail('checkout must be main')
  if (git('diff', '--name-only').length > 0 || git('diff', '--cached', '--name-only').length > 0) fail('tracked checkout changes must be committed')
  state.inspectStagingState()
  const unknown = git('ls-files', '--others', '--exclude-standard').split('\n').filter((name) => name && !name.startsWith('.artifact-video/') && !name.startsWith('packages/sdk/scripts/.local/'))
  if (unknown.length) fail('untracked source files must be reviewed and committed')
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
  for (const name of ['CLOUDFLARE_API_TOKEN', 'MONAD_RPC_URL', 'AI_GATEWAY_API_KEY', 'ATTESTER_PRIVATE_KEY', 'RELAY_PRIVATE_KEY', 'GITHUB_APP_PRIVATE_KEY', 'HYPERSYNC_API_TOKEN']) {
    if (!process.env[name] || process.env[name] === 'unset') fail(`missing credential: ${name}`)
  }
  execFileSync(process.execPath, ['scripts/db-generate.mjs', '--check'], { cwd: repo, stdio: 'pipe' })
}

function sameSecretAfterNewlineNormalization(name) {
  const current = process.env[name]
  if (typeof current !== 'string') return false
  const record = JSON.parse(readFileSync(resolve(repo, '.alchemy/state/AgentJobs/staging/Api.json'), 'utf8'))
  const binding = record.bindings?.find((item) => item.sid === name)?.data?.bindings?.find((item) => item.name === name)
  return typeof binding?.text === 'string' && binding.text.replaceAll('\\n', '\n') === current.replaceAll('\\n', '\n')
}

function safePlan(snapshot) {
  const operations = snapshot.resources.map((resource) => ({
    fqn: resource.fqn,
    logicalId: resource.logicalId,
    type: resource.resourceType,
    action: resource.action,
    bindings: resource.bindings.map((binding) => ({ sid: binding.sid, action: binding.action })),
  }))
  const api = operations.find((row) => row.logicalId === 'Api')
  const directory = api?.bindings.find((binding) => binding.sid === 'DirectoryObject')
  const directoryDb = api?.bindings.find((binding) => binding.sid === 'DIRECTORY_DATABASE')
  if (snapshot.summary.create !== 0 || snapshot.summary.delete !== 0 || snapshot.summary.replace !== 0 || snapshot.summary.orphaned !== 0 || snapshot.summary.adopted !== 0) fail('plan contains resource creation, deletion, replacement, orphaning, or adoption')
  if (snapshot.resources.some((resource) => !['noop', 'update'].includes(resource.action))) fail('plan contains an unapproved resource action')
  if (operations.some((row) => row.bindings.some((binding) => ['delete', 'update'].includes(binding.action) && /PRIVATE_KEY|API_KEY|TOKEN/.test(binding.sid) && !sameSecretAfterNewlineNormalization(binding.sid)))) fail('plan changes an existing secret binding; rotate and review credentials first')
  if (!['create', 'noop'].includes(directory?.action) || !['create', 'noop'].includes(directoryDb?.action)) fail('directory Durable Object and existing-D1 alias are not being added')
  if (operations.length !== 5 || Object.keys(state.targets).some((id) => operations.filter((row) => row.logicalId === id && row.fqn === id).length !== 1) || snapshot.actions.length) fail('unexpected resource or action census')
  for (const node of Object.values(snapshot.native.resources)) {
    state.validateStateRecord(node.resource.LogicalId, node.state)
    if (node.mode !== 'live' || node.renamedFrom?.length) fail('state mode or resource rename drift')
  }
  if (operations.find((row) => row.logicalId === 'Manifests').action !== 'noop') fail('unexpected manifests bucket update')
  if (operations.some((row) => row.bindings.some((binding) => binding.action === 'delete'))) fail('binding deletion refused')
  return { summary: snapshot.summary, operations }
}

async function run() {
  preflight()
  const before = await census()
  const source = { commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') }
  const stateDigests = state.inspectStagingState()
  const migrationSha256 = createHash('sha256').update(readFileSync(resolve(repo, 'apps/api/migrations/0001_directory_agents.sql'))).digest('hex')
  await import(resolve(repo, 'node_modules/alchemy/bin/register-oxc.js'))
  const Alchemist = await import('alchemy/Alchemist')
  const Effect = await import('effect/Effect')
  const { sequenceWorkers } = await import('./sequence.mjs')
  const root = resolve(repo, '.alchemy/recovery')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const lock = resolve(root, 'release.lock')
  writeFileSync(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 })
  try {
    // Plan and apply share a single Effect scope: the provider session must stay alive.
    await Effect.runPromise(Effect.gen(function* () {
      const snapshot = yield* Alchemist.Stack.plan({
        target: { entrypoint: resolve(repo, 'alchemy.run.ts'), stage: 'staging', envFile: resolve(repo, '.env.local') },
        operation: 'deploy', adopt: false, updateStateStore: false,
      })
      const safe = safePlan(snapshot)
      const reviewed = { source, stateDigests, migrationSha256, live: before, ...safe }
      const digest = createHash('sha256').update(canonical(reviewed)).digest('hex')
      const packet = { schemaVersion: 1, stage: 'staging', network: 'monad-testnet', digest, ...reviewed }
      if (args[0] === 'plan') {
        writeFileSync(resolve(root, 'plan.json'), JSON.stringify(packet, null, 2), { mode: 0o600 })
        console.log(JSON.stringify(packet))
        return
      }
      if (args[1] !== digest) fail('apply requires the digest from the current source, state, and live plan')
      if (git('rev-parse', 'HEAD') !== source.commit || git('diff', '--name-only')) fail('checkout changed during planning')
      if (canonical(state.inspectStagingState()) !== canonical(stateDigests) || canonical(yield* Effect.promise(census)) !== canonical(before)) fail('state or live resources changed during planning')
      const runRoot = resolve(root, `release-${Date.now()}`)
      mkdirSync(runRoot, { mode: 0o700 })
      cpSync(state.stateRoot, resolve(runRoot, 'state'), { recursive: true })
      const journal = { ...packet, startedAt: new Date().toISOString(), status: 'applying', workers: [] }
      writeFileSync(resolve(runRoot, 'journal.json'), JSON.stringify(journal, null, 2), { mode: 0o600 })
      yield* sequenceWorkers(snapshot, verifyWorker, (event) => {
        journal.workers.push(event)
        writeFileSync(resolve(runRoot, 'journal.json'), JSON.stringify(journal, null, 2), { mode: 0o600 })
      })
      yield* Alchemist.Stack.apply(snapshot)
      for (const id of ['Api', 'Indexer', 'Explore']) {
        let verified = false
        for (let attempt = 0; attempt < 12; attempt++) {
          const check = yield* Effect.promise(() => verifyWorker(id).then(() => true, () => false))
          if (check) { verified = true; break }
          yield* Effect.sleep('5 seconds')
        }
        if (!verified) fail(`Post-upload verification failed: ${id}`)
      }
      const after = yield* Effect.promise(census)
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
  console.error('Staging release stopped. Read back Cloudflare versions and the private release journal before retrying.')
  process.exitCode = 1
}
