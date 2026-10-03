import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { context, wallet } from '../../packages/sdk/src/client.ts'
import { FlowJournal, parseFlowJson, type FlowState } from '../../packages/sdk/src/flow-journal.ts'
import { ensureFlowDirectory, saveFlowState } from '../../packages/sdk/scripts/flow-persistence.ts'
import { reserveAbi } from '../../scripts/mining/chain.ts'
import { parseEpoch } from '../../scripts/mining/publish-lib.ts'
import { privateKeyToAccount, type Hex } from '../../scripts/mining/viem.ts'
import { epochCalls, runEpoch0, type Epoch0File } from './epoch0-transactions.ts'

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
  const [inputArg, outArg, flag, claimKeyEnv] = process.argv.slice(2)
  if (!inputArg || !outArg || flag !== '--claim-key-env' || !claimKeyEnv || process.argv.length !== 6) {
    throw new Error('usage: bash contracts/script/mine-epoch0-testnet.sh <unsigned-prices.json> <output-dir> --claim-key-env <ENV_NAME>')
  }
  if (!existsSync('/proc/self/fd/9')) throw new Error('use the launch-lock shell wrapper')
  const rpc = env('MONAD_TESTNET_RPC_URL'), ctx = context('monad-testnet', 'main', rpc), h = ctx.deployment.hireling
  if (ctx.deployment.chainId !== 10143 || await ctx.publicClient.getChainId() !== 10143 || !h || ctx.stack.kind !== 'hireling-v1') {
    throw new Error('testnet only: refuses chain 143 regardless of MAINNET_GO')
  }
  const end = await ctx.publicClient.readContract({ address: h.miningReserve, abi: reserveAbi, functionName: 'epochEnd', args: [0n] })
  const latest = await ctx.publicClient.getBlock(), finalized = await ctx.publicClient.getBlock({ blockTag: 'finalized' })
  if (latest.timestamp < end || finalized.timestamp < end) {
    console.error(`REFUSE epoch 0 ends at ${end} (${new Date(Number(end) * 1000).toISOString()}); latest=${latest.timestamp} finalized=${finalized.timestamp}`)
    process.exitCode = 4
    return // Before reading a key, signing, creating a journal, or broadcasting.
  }
  run('bun', ['--no-env-file', 'contracts/script/check-launch-testnet.ts'])
  const owner = wallet('monad-testnet', privateKeyToAccount(env('SAFE_BACKUP_TESTNET_PRIVATE_KEY') as Hex), rpc)
  const claimant = wallet('monad-testnet', privateKeyToAccount(env(claimKeyEnv) as Hex), rpc)
  const policy = JSON.parse(readFileSync(new URL('./testnet-safe-policy.json', import.meta.url), 'utf8')) as { owners: string[] }
  if (!policy.owners.some(a => a.toLowerCase() === owner.account.address.toLowerCase())) throw new Error('key is not a reviewed Safe owner')
  const input = resolve(inputArg), out = resolve(outArg), directory = pathToFileURL(`${out}/`)
  if (existsSync(out)) {
    const info = lstatSync(out)
    if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
      throw new Error('output directory must be yours with mode 700 and no symlink')
    }
  }
  ensureFlowDirectory(directory)
  const journalPath = new URL('journal.json', directory)
  const state: FlowState = existsSync(journalPath) ? parseFlowJson(readFileSync(journalPath, 'utf8')) : { binding: '', values: {}, sends: {} }
  const binding = sha(JSON.stringify({ deployment: ctx.deployment, priceInput: sha(readFileSync(input)), owner: owner.account.address }))
  if (state.binding !== '' && state.binding !== binding) throw new Error('journal deployment, prices or Safe owner differ; reconcile the original operation')
  state.binding = binding
  const j = new FlowJournal(ctx, state, next => saveFlowState(directory, next), (label, hash) => console.log(`TX ${label} ${hash}`))
  const signedPath = resolve(out, 'prices-epoch-0.json'), epochPath = resolve(out, 'epoch-0.json')
  const signed = await j.once('signed-prices', async () => {
    run('bun', ['--no-env-file', 'scripts/mining/sign-prices.ts', input, '--network', 'monad-testnet', '--out', signedPath,
      '--private-key-env', 'SAFE_BACKUP_TESTNET_PRIVATE_KEY'])
    return readFileSync(signedPath, 'utf8')
  })
  writeFileSync(signedPath, signed, { mode: 0o600 })
  const epochBytes = await j.once('epoch-artifact', async () => {
    // RPC comes from its named exported variable, never the command line.
    console.log(run('pnpm', ['mining:epoch', '0', '--network', 'monad-testnet', '--prices', signedPath, '--out', out]))
    return readFileSync(epochPath, 'utf8')
  })
  const validated = parseEpoch(Buffer.from(epochBytes), 'staging'), file = JSON.parse(epochBytes) as Epoch0File
  if (validated.epoch !== '0') throw new Error('wrong epoch')
  epochCalls(ctx, file)
  if (!file.claims[claimant.account.address.toLowerCase()]) throw new Error('claimant has no leaf: select a creator/worker key listed by mining:epoch')
  writeFileSync(epochPath, epochBytes, { mode: 0o600 })
  await runEpoch0(ctx, j, owner, hash => owner.account.sign!({ hash }), file, async () => {
    // Explicit staging route; successful command includes same-byte R2 readback.
    console.log(run('pnpm', ['mining:publish', epochPath, '--stage', 'staging']))
    console.log(`PUBLISHED mining/epoch-0.json sha256 ${sha(epochBytes)}`)
  }, claimant)
}

await main().catch(error => {
  // Never expose an RPC exception/URL, request body, signed bytes or key.
  const message = error instanceof Error ? error.message : ''
  console.error(`epoch0 testnet refused: ${/^(usage:|set |journal |output |key |claimant |wrong epoch|testnet only|use the launch)/.test(message) ? message : 'operation unavailable; inspect the private journal and reconcile before retrying'}`)
  process.exitCode = 1
})
