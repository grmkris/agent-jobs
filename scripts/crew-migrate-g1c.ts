/** Explicit read-only reconciliation and local journal migration; never signs or broadcasts. */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { keccak256, parseTransaction } from 'viem'
import current from '../contracts/config/monad-testnet.json' with { type: 'json' }
import previous from '../contracts/config/archive/monad-testnet-g1b.json' with { type: 'json' }
import * as sdk from '../packages/sdk/src/index.ts'
import { crewPolicyBinding, reviewedCrewPolicy } from '../packages/sdk/scripts/demo-worker-policy.ts'
import policy from '../packages/sdk/scripts/demo-worker-policy.json' with { type: 'json' }
import { saveFlowState } from '../packages/sdk/scripts/flow-persistence.ts'
import { demandCanonicalJson } from '../packages/sdk/src/demand-bot-validation.ts'
import { DEMAND_DAILY_CAP, DEMAND_INTERVAL_SECONDS, templateForSequence } from '../packages/sdk/src/demand-bot.ts'
import { migrateCrewJournal } from './crew-migration.mjs'
import { reportCliFailure } from './cli-errors.mjs'

const [commandKind, stateDirectory, approval] = process.argv.slice(2)
if (!['workers', 'demand'].includes(commandKind!) || !stateDirectory || (approval !== undefined && approval !== '--yes')) {
  console.error('Usage: crew-migrate-g1c.ts workers|demand <state-directory> [--yes]')
  process.exit(2)
}

function workerBinding(config: typeof current) {
  return crewPolicyBinding({ chainId: 10143, factory: config.deployment.sidequest.factory as `0x${string}`, vault: config.deployment.sidequest.vault as `0x${string}`,
    core: config.deployment.core as `0x${string}`, identity: config.erc8004.identity as `0x${string}`, boardUrl: 'https://dev.sidequest.exchange',
    token: config.deployment.rewardTokens[0] as `0x${string}`, repository: 'grmkris/sidequest-demo-deliveries' }, reviewedCrewPolicy(policy))
}

async function main(kind: string, directory: string, apply: string | undefined) {
  if (process.env.CREW_MIGRATION_LOCKED !== '1') {
    execFileSync('flock', ['--nonblock', '--no-fork', resolve(directory, 'journal.lock'), 'bun', import.meta.filename, kind, directory, ...(apply ? [apply] : [])], {
      env: { ...process.env, CREW_MIGRATION_LOCKED: '1' }, stdio: 'inherit',
    })
    return
  }
  if (previous.chainId !== 10143 || current.chainId !== 10143 || current.deployment.sidequest.block <= previous.deployment.hireling.block) {
    throw new Error('Require the promoted G1c testnet deployment')
  }
  const ctx = sdk.context('monad-testnet', 'main', process.env.MONAD_TESTNET_RPC_URL ?? 'https://testnet-rpc.monad.xyz')
  if (await ctx.publicClient.getChainId() !== 10143) throw new Error('Wrong chain')
  const state = sdk.parseFlowJson(readFileSync(resolve(directory, 'journal.json'), 'utf8'))
  for (const name of kind === 'workers' ? ['sidequest-crew-grok', 'sidequest-crew-grok-studio'] : ['sidequest-crew-demand']) {
    let running = false
    try { running = execFileSync('docker', ['inspect', '--format', '{{.State.Running}}', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'true' } catch { /* Not created yet. */ }
    if (running) throw new Error('Stop the crew container before migrating its journal')
  }

  const demandBinding = kind === 'demand' ? JSON.parse(state.binding) : undefined
  function expectedDemandBinding(config: typeof current) {
    return demandCanonicalJson({ version: 1, chainId: 10143, creator: demandBinding.creator,
      token: config.deployment.rewardTokens[0], core: config.deployment.core, holding: config.deployment.main.holding,
      evaluator: config.deployment.main.evaluator, board: 'https://dev.sidequest.exchange',
      cap: DEMAND_DAILY_CAP, cadence: DEMAND_INTERVAL_SECONDS, templates: [templateForSequence(0), templateForSequence(1)] })
  }
  const previousBinding = kind === 'workers' ? workerBinding(previous) : expectedDemandBinding(previous)
  const nextBinding = kind === 'workers' ? workerBinding(current) : expectedDemandBinding(current)
  const next = migrateCrewJournal(state, { kind, previousBinding, nextBinding,
    oldHolding: previous.deployment.main.holding, newHolding: current.deployment.main.holding, at: new Date().toISOString() })
  for (const saved of Object.values(state.sends)) {
    const tx = parseTransaction(saved.raw)
    if (keccak256(saved.raw) !== saved.hash || tx.chainId !== 10143) throw new Error('Saved send integrity failed')
    const receipt = await ctx.publicClient.getTransactionReceipt({ hash: saved.hash })
    if (receipt.status !== 'success' || receipt.from.toLowerCase() !== saved.wallet.toLowerCase()) throw new Error('Unreconciled historical send')
  }
  if (apply === '--yes' && next !== state) saveFlowState(pathToFileURL(`${resolve(directory)}/`), next)

  console.log(JSON.stringify({ kind, mode: apply === '--yes' ? 'applied' : 'dry-run', oldHolding: previous.deployment.main.holding,
    newHolding: current.deployment.main.holding, preservedSends: Object.keys(state.sends).length, changed: next !== state }))
}

main(commandKind, stateDirectory, approval).catch(error => {
  reportCliFailure('Crew migration failed', error)
  process.exitCode = 1
})
