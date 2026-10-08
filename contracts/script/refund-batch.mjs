import { existsSync, readFileSync, lstatSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPublicClient, decodeEventLog, http, erc20Abi, TransactionReceiptNotFoundError } from 'viem'
import { KRIS, address, canonical, makeManifest, checksum } from './refund-model.mjs'
import { refundIdentity, refundPaths } from './refund-generation.mjs'
import { PUBLIC_RPC, paced, readLogs } from './refund-manifest.mjs'
import { refundPlan, bindRefundJournal, validateSavedRefunds, resumeDecision, refundVaultAbi, refundSendMode } from './refund-batch-model.mjs'

async function main() {
  const options = parseBatchArgs(process.argv.slice(2))
  const send = refundSendMode(options.yes, process.env)
  if (!existsSync('/proc/self/fd/9') || process.env.SIDEQUEST_REFUND_LOCKED !== options.generation) throw new Error('refund: use refund-batch.sh to hold the kernel journal lock')
  const configPath = 'contracts/config/monad-testnet.json'
  const configBytes = readFileSync(configPath, 'utf8')
  const manifestBytes = readFileSync(options.manifest, 'utf8')
  const config = JSON.parse(configBytes)
  const manifest = JSON.parse(manifestBytes)
  const snapshot = JSON.parse(readFileSync(options.manifest.replace(/\.json$/, '.snapshot.json'), 'utf8'))
  if (checksum(snapshot) !== manifest.snapshot.checksum || canonical(makeManifest(snapshot, options)) !== canonical(manifest)) throw new Error('refund: manifest does not match the replayed snapshot')
  const plan = refundPlan(manifest, config, options)
  const rpc = process.env.MONAD_RPC_URL || process.env.MONAD_TESTNET_RPC_URL || PUBLIC_RPC
  const client = paced(createPublicClient({ transport: http(rpc, { timeout: 20_000, retryCount: 2 }) }))
  if (await client.getChainId() !== 10143) throw new Error('refund: RPC must be Monad testnet (10143)')
  const directory = pathToFileURL(resolve(refundPaths(options.generation).directory) + '/')
  const journalPath = new URL('journal.json', directory)
  // Bun is used by the wrapper; reuse the SDK's durable-before-send journal and filesystem barrier.
  const { FlowJournal, parseFlowJson } = await import('../../packages/sdk/src/flow-journal.ts')
  const { ensureFlowDirectory, saveFlowState } = await import('../../packages/sdk/scripts/flow-persistence.ts')
  const state = loadJournal(journalPath, parseFlowJson)
  bindRefundJournal(state, plan)
  await validateSavedRefunds(state, plan)
  const { decisions, remaining, remainingPositions } = await reconcileBatch(client, state, plan)
  await verifyNewVault(client, plan, remaining)
  const postCutoff = await verifySnapshotFresh(client, snapshot, manifest)
  console.log(JSON.stringify({ mode: send ? 'send' : 'dry-run', manifest: manifest.checksum, funding: plan.funding,
    factory: plan.factory, vault: plan.vault, remaining: remaining.toString(), decisions, postCutoff }))
  if (!send) return
  const { privateKeyToAccount } = await import('viem/accounts')
  const { context, wallet } = await import('../../packages/sdk/src/client.ts')
  // `.env.local` locally, or `SIDEQUEST_STAGE=dev|prod`'s stage env file; the value is never printed.
  const { loadEnv } = await import('../../scripts/sidequest/transaction.mjs')
  const key = loadEnv()[options.keyEnv]
  if (!key) throw new Error(`refund: set ${options.keyEnv}`)
  const account = privateKeyToAccount(key)
  if (address(account.address) !== plan.funding) throw new Error('refund: key does not own the reviewed funding wallet')
  const ctx = context('monad-testnet', 'main', rpc)
  if (address(ctx.deployment.factory) !== plan.factory || address(ctx.deployment.sidequest.vault) !== plan.vault) throw new Error('refund: bundled deployment differs from promoted config')
  const signer = wallet('monad-testnet', account, rpc)
  ensureFlowDirectory(directory)
  saveFlowState(directory, state)
  const journal = new FlowJournal(ctx, state, next => saveFlowState(directory, next), (label, hash) => console.log(`TX ${label} ${hash}`))
  await sendBatch({ plan, journal, signer, ctx, configPath, configBytes, options, manifestBytes })
  console.log(JSON.stringify({ done: true, manifest: manifest.checksum, operations: plan.operations.length, remainingPositions: remainingPositions.toString() }))
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) await main().catch(error => {
  console.error(error.message?.startsWith('refund:') ? error.message : 'refund: unavailable; inspect the private journal and reconcile before retrying')
  process.exitCode = 1
})

export function parseBatchArgs(args) {
  const options = { yes: false, keyEnv: 'CREATOR_PRIVATE_KEY' }
  const seen = new Set()
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (seen.has(key)) throw new Error('refund: duplicate option')
    seen.add(key)
    if (key === '--yes') options.yes = true
    else if (['--manifest', '--key-env', '--generation', '--source'].includes(key) && args[i + 1]) {
      const value = args[++i]
      if (key === '--key-env') options.keyEnv = value
      else options[key.slice(2)] = value
    } else throw new Error('refund: usage refund-batch.sh [--generation LABEL --source LABEL --manifest FILE --yes --key-env NAME]')
  }
  const identity = refundIdentity(options.generation, options.source)
  if (!/^[A-Z][A-Z0-9_]*$/.test(options.keyEnv)) throw new Error('refund: invalid key environment name')
  return { ...options, ...identity, manifest: options.manifest ?? refundPaths(identity.generation).manifest }
}

function loadJournal(journalPath, parseFlowJson) {
  const state = existsSync(journalPath) ? parseFlowJson(readFileSync(journalPath, 'utf8')) : { binding: '', values: {}, sends: {} }
  if (existsSync(journalPath)) {
    const info = lstatSync(journalPath)
    if (info.isSymbolicLink() || info.uid !== process.getuid() || !info.isFile() || (info.mode & 0o077)) throw new Error('refund: journal must be an owned private regular file')
  }
  return state
}

async function reconcileBatch(client, state, plan) {
  const decisions = []
  let remaining = 0n
  let remainingPositions = 0n
  for (const operation of plan.operations) {
    const saved = state.sends[operation.key]
    const { receipt, nonce } = await savedReceipt(client, saved, plan.funding)
    const decision = resumeDecision(saved, receipt, nonce)
    decisions.push({ key: operation.key, decision, ...(saved ? { hash: saved.hash } : {}) })
    if (decision !== 'confirmed' && operation.key !== 'approval') {
      remaining += BigInt(operation.amount)
      if (operation.key.startsWith('position/')) remainingPositions += BigInt(operation.amount)
    }
  }
  return { decisions, remaining, remainingPositions }
}

export async function verifySnapshotFresh(client, snapshot, manifest) {
  const cutoff = await client.getBlock({ blockTag: 'finalized' })
  if ((await client.getBlock({ blockNumber: BigInt(snapshot.block) })).hash !== snapshot.blockHash) throw new Error('refund: old snapshot block hash changed')
  // Refunds are owed at the fixed cutover, so later old-generation activity is reported without changing entitlement.
  const later = await readLogs(snapshot.block + 1, Number(cutoff.number), [manifest.old.vault, manifest.old.factory], client)
  const accounts = new Set([KRIS, ...manifest.positions.flatMap(row => [address(row.account), address(row.delegator)])])
  let oldSideTransfers = 0
  for (const log of later.filter(row => address(row.address) === address(manifest.old.factory))) {
    try {
      const event = decodeEventLog({ abi: erc20Abi, data: log.data,
        topics: [log.topic0, log.topic1, log.topic2, log.topic3].filter(Boolean) })
      if (event.eventName === 'Transfer' && (accounts.has(address(event.args.from)) || accounts.has(address(event.args.to)))) oldSideTransfers++
    } catch {
      // A non-transfer token event cannot change a manifest balance.
    }
  }
  return { throughBlock: Number(cutoff.number), oldVaultEvents: later.filter(log => address(log.address) === address(manifest.old.vault)).length, oldSideTransfers }
}

async function sendBatch({ plan, journal, signer, ctx, configPath, configBytes, options, manifestBytes }) {
  for (const operation of plan.operations) {
    if (readFileSync(configPath, 'utf8') !== configBytes || readFileSync(options.manifest, 'utf8') !== manifestBytes) throw new Error('refund: config/manifest changed during batch')
    if (operation.key.startsWith('position/')) {
      const allowance = await ctx.publicClient.readContract({ address: plan.factory, abi: erc20Abi, functionName: 'allowance', args: [plan.funding, plan.vault] })
      if (!(await journal.mined(operation.key)) && allowance < BigInt(operation.amount)) throw new Error('refund: saved approval does not cover remaining position; reconcile manually')
    }
    await journal.send(operation.key, signer, { to: operation.to, data: operation.data, value: '0' })
  }
}

async function verifyNewVault(client, plan, remaining) {
  const balance = await client.readContract({ address: plan.factory, abi: erc20Abi, functionName: 'balanceOf', args: [plan.funding] })
  if (balance < remaining) throw new Error('refund: funding wallet lacks remaining new SIDE')
  const vaultFactory = await client.readContract({ address: plan.vault, abi: refundVaultAbi, functionName: 'factory' })
  const holdingAuthorized = await client.readContract({ address: plan.vault, abi: refundVaultAbi, functionName: 'isHolding', args: [plan.holding] })
  if (address(vaultFactory) !== plan.factory || !holdingAuthorized) throw new Error('refund: new vault factory/bootstrap mismatch')
}

async function savedReceipt(client, saved, funding) {
    let receipt
    let nonce = 0
    if (saved) {
      try { receipt = await client.getTransactionReceipt({ hash: saved.hash }) }
      catch (error) { if (!(error instanceof TransactionReceiptNotFoundError)) throw error }
      if (!receipt) nonce = await client.getTransactionCount({ address: funding, blockTag: 'latest' })
    }
  return { receipt, nonce }
}
