import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'

export const accountId = 'bceaeae4788dce3493514fde194b4a7e'
export const targets = {
  Api: 'agentjobs-api-staging-ba2zqmaom6el4lws',
  Indexer: 'agentjobs-indexer-staging-2unhvhpefxd7n2wb',
  Explore: 'agentjobs-explore-staging-67xgxuclftbgtgxn',
  Database: '1b2ddfdd-650e-4846-8b55-fca07872efec',
  Manifests: 'agentjobs-manifests-staging-4yyroq65le7dnxbm',
} as const
export const boardNamespace = 'eab5801c233a4d1f952a457050958175'
export const stateRoot = '/home/kristjan/code/agent-jobs/.alchemy/state/AgentJobs/staging'

export function stateMode(env: NodeJS.ProcessEnv): 'local' | 'remote' {
  const remote = env.ALCHEMY_REMOTE_STATE === '1' || env.ALCHEMY_STATE_MODE === 'remote'
  if (remote && (env.AGENT_JOBS_STAGE !== 'prod' || env.AGENT_JOBS_NETWORK !== 'monad-mainnet')) throw new Error('Remote state is reserved for the explicit production release')
  if (env.ALCHEMY_STATE_MODE && !['local', 'remote'].includes(env.ALCHEMY_STATE_MODE)) throw new Error('Unknown state mode')
  if (env.ALCHEMY_STATE_MODE === 'local' && remote) throw new Error('Conflicting state configuration')
  return remote ? 'remote' : 'local'
}

export function validateStateRecord(id: keyof typeof targets, record: Record<string, any>): void {
  const attr = record.attr
  const resourceId = id === 'Database' ? attr?.databaseId : id === 'Manifests' ? attr?.bucketName : attr?.workerName
  if (record.logicalId !== id || record.fqn !== id || resourceId !== targets[id] || attr?.accountId !== accountId) throw new Error(`State identity mismatch: ${id}`)
  if (!['created', 'updated'].includes(record.status) || record.providerMode !== 'live') throw new Error(`State is not ready: ${id}`)
  if (!/^[a-f0-9]{32}$/.test(record.instanceId)) throw new Error(`State instance missing: ${id}`)
}

/** Return digests only. Local Alchemy records include plaintext credentials. */
export function inspectStagingState(root = stateRoot): Record<string, string> {
  if (resolve(root) !== stateRoot || realpathSync(root) !== stateRoot) throw new Error('Staging state must remain in the authoritative checkout')
  const expectedFiles = [...Object.keys(targets).map((id) => `${id}.json`), '__stack_output__.json'].toSorted()
  if (JSON.stringify(readdirSync(root).toSorted()) !== JSON.stringify(expectedFiles)) throw new Error('Unexpected staging state resources')
  const digests: Record<string, string> = {}
  for (const id of Object.keys(targets) as (keyof typeof targets)[]) {
    const file = resolve(root, `${id}.json`)
    if (lstatSync(file).isSymbolicLink()) throw new Error(`Symlink state refused: ${id}`)
    const bytes = readFileSync(file)
    validateStateRecord(id, JSON.parse(bytes.toString()))
    digests[id] = createHash('sha256').update(bytes).digest('hex')
  }
  return digests
}
