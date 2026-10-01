import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'

const repo = resolve(new URL('../..', import.meta.url).pathname)
const state = await import('./state.ts')

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
  process.env.ALCHEMY_STATE_MODE = 'local'
  process.env.ALCHEMY_REMOTE_STATE = '0'
  process.env.AGENT_JOBS_STAGE = 'staging'
  process.env.AGENT_JOBS_NETWORK = 'monad-testnet'
  process.env.AGENT_JOBS_APPLY_MIGRATIONS = '1'
  process.env.AGENT_JOBS_WITHOUT_EXPLORE = '0'
  const localEnv = parseEnv(readFileSync(resolve(repo, '.env.local'), 'utf8'))
  for (const [key, value] of Object.entries(localEnv)) if (process.env[key] === undefined) process.env[key] = value
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
  if (directory?.action !== 'create' || directoryDb?.action !== 'create') fail('directory Durable Object and existing-D1 alias are not being added')
  return { summary: snapshot.summary, operations }
}

async function makePlan() {
  await import(resolve(repo, 'node_modules/alchemy/bin/register-oxc.js'))
  const Alchemist = await import('alchemy/Alchemist')
  const Effect = await import('effect/Effect')
  return Effect.runPromise(Effect.gen(function* () {
    const snapshot = yield* Alchemist.Stack.plan({
      target: { entrypoint: resolve(repo, 'alchemy.run.ts'), stage: 'staging', envFile: resolve(repo, '.env.local') },
      operation: 'deploy',
      adopt: false,
      updateStateStore: false,
    })
    return { snapshot, safe: safePlan(snapshot), Alchemist, Effect }
  }).pipe(Effect.provide(Alchemist.layer()), Effect.scoped))
}

preflight()
const { snapshot, safe, Alchemist, Effect } = await makePlan()
const digest = createHash('sha256').update(canonical(safe)).digest('hex')
const packet = { schemaVersion: 1, stage: 'staging', network: 'monad-testnet', commit: git('rev-parse', 'HEAD'), digest, ...safe }
const mode = process.argv[2] ?? 'plan'
if (mode === 'plan') {
  console.log(JSON.stringify(packet))
} else if (mode === 'apply') {
  if (process.argv.length !== 4 || process.argv[3] !== digest) fail('apply requires the digest from a fresh plan')
  const result = await Effect.runPromise(Alchemist.Stack.apply(snapshot).pipe(Effect.provide(Alchemist.layer()), Effect.scoped))
  writeFileSync(resolve(repo, '.alchemy/recovery/last-apply.json'), JSON.stringify({ ...packet, appliedAt: new Date().toISOString(), result: { keys: Object.keys(result ?? {}) } }, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ ok: true, digest, applied: true }))
} else fail('use plan or apply <digest>')
