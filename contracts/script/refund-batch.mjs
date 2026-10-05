import { existsSync, readFileSync, lstatSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPublicClient, http, erc20Abi, TransactionReceiptNotFoundError } from 'viem'
import { address, canonical, makeManifest, checksum } from './refund-model.mjs'
import { readLogs } from './refund-manifest.mjs'
import { refundPlan, bindRefundJournal, validateSavedRefunds, resumeDecision, refundVaultAbi } from './refund-batch-model.mjs'

async function main() {
  const args = process.argv.slice(2)
  const options = { yes: false, manifest: 'docs/evidence/testnet-g1c/refund-manifest.json', keyEnv: 'DEPLOYER_PRIVATE_KEY' }
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (key === '--yes') options.yes = true
    else if (['--manifest', '--key-env'].includes(key) && args[i + 1]) {
      const value = args[++i]
      if (key === '--manifest') options.manifest = value
      else options.keyEnv = value
    } else throw new Error('refund: usage refund-batch.sh [--manifest FILE] [--yes] [--key-env NAME]')
  }
  if (!/^[A-Z][A-Z0-9_]*$/.test(options.keyEnv)) throw new Error('refund: invalid key environment name')
  if (!existsSync('/proc/self/fd/9') || process.env.G1C_REFUND_LOCKED !== '1') throw new Error('refund: use refund-batch.sh to hold the kernel journal lock')
  const configPath = 'contracts/config/monad-testnet.json'
  const configBytes = readFileSync(configPath, 'utf8')
  const manifestBytes = readFileSync(options.manifest, 'utf8')
  const config = JSON.parse(configBytes)
  const manifest = JSON.parse(manifestBytes)
  const snapshot = JSON.parse(readFileSync(options.manifest.replace(/\.json$/, '.snapshot.json'), 'utf8'))
  if (checksum(snapshot) !== manifest.snapshot.checksum || canonical(makeManifest(snapshot)) !== canonical(manifest)) throw new Error('refund: manifest does not match the replayed snapshot')
  const plan = refundPlan(manifest, config)
  const rpc = process.env.MONAD_TESTNET_RPC_URL
  if (!rpc) throw new Error('refund: set MONAD_TESTNET_RPC_URL')
  const client = createPublicClient({ transport: http(rpc, { timeout: 20_000, retryCount: 2 }) })
  if (await client.getChainId() !== 10143) throw new Error('refund: RPC must be Monad testnet (10143)')
  const directory = pathToFileURL(resolve('.g1c-refunds') + '/')
  const journalPath = new URL('journal.json', directory)
  // Bun is used by the wrapper; reuse the SDK's durable-before-send journal and filesystem barrier.
  const { FlowJournal, parseFlowJson } = await import('../../packages/sdk/src/flow-journal.ts')
  const { ensureFlowDirectory, saveFlowState } = await import('../../packages/sdk/scripts/flow-persistence.ts')
  const state = existsSync(journalPath) ? parseFlowJson(readFileSync(journalPath, 'utf8')) : { binding: '', values: {}, sends: {} }
  if (existsSync(journalPath)) {
    const info = lstatSync(journalPath)
    if (info.isSymbolicLink() || info.uid !== process.getuid() || !info.isFile() || (info.mode & 0o077)) throw new Error('refund: journal must be an owned private regular file')
  }
  bindRefundJournal(state, plan)
  await validateSavedRefunds(state, plan)
  const decisions = []
  let remaining = 0n
  let remainingPositions = 0n
  for (const operation of plan.operations) {
    const saved = state.sends[operation.key]
    let receipt
    let nonce = 0
    if (saved) {
      try { receipt = await client.getTransactionReceipt({ hash: saved.hash }) }
      catch (error) { if (!(error instanceof TransactionReceiptNotFoundError)) throw error }
      if (!receipt) nonce = await client.getTransactionCount({ address: plan.funding, blockTag: 'latest' })
    }
    const decision = resumeDecision(saved, receipt, nonce)
    decisions.push({ key: operation.key, decision, ...(saved ? { hash: saved.hash } : {}) })
    if (decision !== 'confirmed' && operation.key !== 'approval') {
      remaining += BigInt(operation.amount)
      if (operation.key.startsWith('position/')) remainingPositions += BigInt(operation.amount)
    }
  }
  const balance = await client.readContract({ address: plan.factory, abi: erc20Abi, functionName: 'balanceOf', args: [plan.funding] })
  if (balance < remaining) throw new Error('refund: funding wallet lacks remaining FACTORY v3')
  const vaultFactory = await client.readContract({ address: plan.vault, abi: refundVaultAbi, functionName: 'factory' })
  const holdingAuthorized = await client.readContract({ address: plan.vault, abi: refundVaultAbi, functionName: 'isHolding', args: [plan.holding] })
  if (address(vaultFactory) !== plan.factory || !holdingAuthorized) throw new Error('refund: G1c vault factory/bootstrap mismatch')
  console.log(JSON.stringify({ mode: options.yes ? 'send' : 'dry-run', manifest: manifest.checksum, funding: plan.funding,
    factory: plan.factory, vault: plan.vault, remaining: remaining.toString(), decisions }))
  if (!options.yes) return
  if (!process.env.HYPERSYNC_API_TOKEN) throw new Error('refund: set HYPERSYNC_API_TOKEN for old-stack freshness check')
  const cutoff = await client.getBlock({ blockTag: 'finalized' })
  if ((await client.getBlock({ blockNumber: BigInt(snapshot.block) })).hash !== snapshot.blockHash) throw new Error('refund: old snapshot block hash changed')
  // Wind-down may change G1b balances. Never pay a stale manifest after a deposit, burn, withdrawal or transfer.
  const later = await readLogs(snapshot.block + 1, Number(cutoff.number), [manifest.old.vault, manifest.old.factory], process.env.HYPERSYNC_API_TOKEN)
  if (later.some(log => address(log.address) === address(manifest.old.factory))) throw new Error('refund: G1b token activity after snapshot; create and review a fresh manifest')
  const { decodeVaultLogs } = await import('./refund-model.mjs')
  if (decodeVaultLogs(later.filter(log => address(log.address) === address(manifest.old.vault))).length) throw new Error('refund: G1b stake activity after snapshot; create and review a fresh manifest')
  const { privateKeyToAccount } = await import('viem/accounts')
  const { context, wallet } = await import('../../packages/sdk/src/client.ts')
  const key = process.env[options.keyEnv]
  if (!key) throw new Error(`refund: set ${options.keyEnv}`)
  const account = privateKeyToAccount(key)
  if (address(account.address) !== plan.funding) throw new Error('refund: key does not own the reviewed funding wallet')
  const ctx = context('monad-testnet', 'main', rpc)
  const signer = wallet('monad-testnet', account, rpc)
  ensureFlowDirectory(directory)
  saveFlowState(directory, state)
  const journal = new FlowJournal(ctx, state, next => saveFlowState(directory, next), (label, hash) => console.log(`TX ${label} ${hash}`))
  for (const operation of plan.operations) {
    if (readFileSync(configPath, 'utf8') !== configBytes || readFileSync(options.manifest, 'utf8') !== manifestBytes) throw new Error('refund: config/manifest changed during batch')
    if (operation.key.startsWith('position/')) {
      const allowance = await ctx.publicClient.readContract({ address: plan.factory, abi: erc20Abi, functionName: 'allowance', args: [plan.funding, plan.vault] })
      if (!(await journal.mined(operation.key)) && allowance < BigInt(operation.amount)) throw new Error('refund: saved approval does not cover remaining position; reconcile manually')
    }
    await journal.send(operation.key, signer, { to: operation.to, data: operation.data, value: '0' })
  }
  console.log(JSON.stringify({ done: true, manifest: manifest.checksum, operations: plan.operations.length, remainingPositions: remainingPositions.toString() }))
}

await main().catch(error => {
  console.error(error.message?.startsWith('refund:') ? error.message : 'refund: unavailable; inspect the private journal and reconcile before retrying')
  process.exitCode = 1
})
