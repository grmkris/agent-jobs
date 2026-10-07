import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { context, wallet } from '../../packages/sdk/src/client.ts'
import { FlowJournal, parseFlowJson, type FlowState } from '../../packages/sdk/src/flow-journal.ts'
import { ensureFlowDirectory, saveFlowState } from '../../packages/sdk/scripts/flow-persistence.ts'
import { parseEpoch } from '../../scripts/mining/publish-lib.ts'
import { privateKeyToAccount, type Hex } from '../../scripts/mining/viem.ts'
import { epochCalls, runEpoch, type EpochFile } from './epoch0-transactions.ts'
import { bindMiningState, miningBinding } from './testnet-mining-binding.ts'
import { EpochNotEnded, miningOptions, requireEndedEpoch, requirePriceEpoch } from './testnet-mining-options.ts'

// Call only through the shell wrapper, which holds the shared launch lock.
// Raw keys are permitted only here on testnet; none goes into a command log.
const repo = resolve(import.meta.dirname, '../..')
function run(command: string, args: string[]) {
  const child = spawnSync(command, args, { cwd: repo, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (child.status !== 0) throw new Error(`${command} command refused (provider details suppressed)`)
  return child.stdout.trim()
}
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const env = (name: string) => {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name) || !process.env[name]) throw new Error(`set ${name} by environment name`)
  return process.env[name]!
}

async function main() {
  const { inputArg, outArg, claimKeyEnv, epoch } = miningOptions(process.argv.slice(2))
  if (!existsSync('/proc/self/fd/9')) throw new Error('use the launch-lock shell wrapper')
  const rpc = env('MONAD_TESTNET_RPC_URL'), ctx = context('monad-testnet', 'main', rpc), h = ctx.deployment.sidequest
  if (ctx.deployment.chainId !== 10143 || await ctx.publicClient.getChainId() !== 10143 || !h || ctx.stack.kind !== 'sidequest-v1') {
    throw new Error('testnet only: refuses chain 143 regardless of MAINNET_GO')
  }
  await requireEndedEpoch(ctx.publicClient, h.miningReserve, epoch)
  const input = resolve(inputArg)
  requirePriceEpoch(JSON.parse(readFileSync(input, 'utf8')), epoch)
  run('bun', ['--no-env-file', 'contracts/script/check-launch-testnet.ts'])
  const owner = wallet('monad-testnet', privateKeyToAccount(env('SAFE_BACKUP_TESTNET_PRIVATE_KEY') as Hex), rpc)
  const claimant = wallet('monad-testnet', privateKeyToAccount(env(claimKeyEnv) as Hex), rpc)
  const policy = JSON.parse(readFileSync(new URL('./testnet-safe-policy.json', import.meta.url), 'utf8')) as { owners: string[] }
  if (!policy.owners.some(a => a.toLowerCase() === owner.account.address.toLowerCase())) throw new Error('key is not a reviewed Safe owner')
  const out = resolve(outArg), directory = pathToFileURL(`${out}/`)
  if (existsSync(out)) {
    const info = lstatSync(out)
    if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
      throw new Error('output directory must be yours with mode 700 and no symlink')
    }
  }
  ensureFlowDirectory(directory)
  const journalPath = new URL('journal.json', directory)
  const state: FlowState = existsSync(journalPath) ? parseFlowJson(readFileSync(journalPath, 'utf8')) : { binding: '', values: {}, sends: {} }
  const binding = miningBinding(ctx.deployment, sha(readFileSync(input)), owner.account.address, epoch)
  bindMiningState(state, binding)
  const j = new FlowJournal(ctx, state, next => saveFlowState(directory, next), (label, hash) => console.log(`TX ${label} ${hash}`))
  const signedPath = resolve(out, `prices-epoch-${epoch}.json`), epochPath = resolve(out, `epoch-${epoch}.json`)
  const signedKey = epoch === 0n ? 'signed-prices' : `signed-prices/${epoch}`
  const artifactKey = epoch === 0n ? 'epoch-artifact' : `epoch-artifact/${epoch}`
  const signed = await j.once(signedKey, async () => {
    run('bun', ['--no-env-file', 'scripts/mining/sign-prices.ts', input, '--network', 'monad-testnet', '--out', signedPath,
      '--private-key-env', 'SAFE_BACKUP_TESTNET_PRIVATE_KEY'])
    return readFileSync(signedPath, 'utf8')
  })
  writeFileSync(signedPath, signed, { mode: 0o600 })
  const epochBytes = await j.once(artifactKey, async () => {
    // RPC comes from its named exported variable, never the command line.
    console.log(run('bun', ['run', 'mining:epoch', epoch.toString(), '--network', 'monad-testnet', '--prices', signedPath, '--out', out]))
    return readFileSync(epochPath, 'utf8')
  })
  if (JSON.parse(epochBytes).root === null) throw new Error('epoch has no earned fees; select an ended epoch with counted paid fees and a new directory')
  const validated = parseEpoch(Buffer.from(epochBytes), 'staging'), file = JSON.parse(epochBytes) as EpochFile
  if (validated.epoch !== epoch.toString()) throw new Error('wrong epoch')
  epochCalls(ctx, file, epoch)
  if (!file.claims[claimant.account.address.toLowerCase()]) throw new Error('claimant has no leaf: select a creator/worker key listed by mining:epoch')
  writeFileSync(epochPath, epochBytes, { mode: 0o600 })
  await runEpoch(ctx, j, owner, hash => owner.account.sign!({ hash }), file, async () => {
    // Explicit staging route; successful command includes same-byte R2 readback.
    console.log(run('bun', ['run', 'mining:publish', epochPath, '--stage', 'staging']))
    console.log(`PUBLISHED mining/epoch-${epoch}.json sha256 ${sha(epochBytes)}`)
  }, claimant, epoch)
}

await main().catch(error => {
  // Never expose an RPC exception/URL, request body, signed bytes or key.
  const message = error instanceof Error ? error.message : ''
  console.error(`mining testnet refused: ${/^(usage:|epoch |prices |set |journal |output |key |claimant |wrong epoch|testnet only|use the launch)/.test(message) ? message : 'operation unavailable; inspect the private journal and reconcile before retrying'}`)
  process.exitCode = error instanceof EpochNotEnded ? 4 : 1
})
