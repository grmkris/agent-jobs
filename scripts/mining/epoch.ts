import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { deploymentFromConfig, type DeploymentConfig, type Network } from '../../packages/sdk/src/deployment.ts'
import { budgetOf, client, decimalsOf, distributorAbi, firstBlockAtOrAfter, holdingLogs, reserveAbi, safeOwners } from './chain.ts'
import { computeEpoch, dataHashOf, leafValues } from './compute.ts'
import { parsePriceList, recoverPriceListSigner, type PriceListFile } from './prices.ts'
import { buildTree, proofOf } from './tree.ts'
import { encodeFunctionData, getAddress, type Address, type Hex } from './viem.ts'

// pnpm mining:epoch <n> [--network monad-testnet|monad-mainnet] --prices <signed JSON> --out <dir>
//                       [--rpc <url>] [--config <config JSON>] [--page <blocks>]          (README.md)

const argv = process.argv.slice(2)
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? undefined : argv[i + 1]
}
const usage = 'usage: pnpm mining:epoch <n> [--network monad-testnet|monad-mainnet] --prices <signed price list JSON> --out <dir> [--rpc <url>] [--config <path>] [--page <blocks>]'
const epochArg = argv[0]
const network = (flag('network') ?? 'monad-testnet') as Network
const pricesPath = flag('prices')
const outDir = flag('out')
if (epochArg === undefined || !/^[0-9]+$/.test(epochArg) || pricesPath === undefined || outDir === undefined) throw new Error(usage)
if (network !== 'monad-testnet' && network !== 'monad-mainnet') throw new Error(usage)
const epoch = BigInt(epochArg)
const rpc = flag('rpc') ?? process.env[network === 'monad-mainnet' ? 'MONAD_MAINNET_RPC_URL' : 'MONAD_TESTNET_RPC_URL']
if (rpc === undefined || rpc === '') throw new Error(`set --rpc or ${network === 'monad-mainnet' ? 'MONAD_MAINNET_RPC_URL' : 'MONAD_TESTNET_RPC_URL'}`)
const page = BigInt(flag('page') ?? '1000')
const configPath = resolve(flag('config') ?? join(import.meta.dirname, '../../contracts/config', `${network}.json`))

// Errors from the RPC client can quote the URL; it may carry a key.
const redact = (text: string) => text.split(rpc).join('<rpc>')
const s = (v: bigint | number) => v.toString()
const lower = (a: string) => a.toLowerCase() as Address

async function main() {
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as DeploymentConfig
  const d = deploymentFromConfig(network, config)
  if (d.hireling === null) throw new Error(`${configPath} records no v1 deployment`)
  const h = d.hireling
  const holdings = [...Object.values(d.stacks), ...Object.values(d.legacyStacks)]
    .filter(st => st?.kind === 'hireling-v1').map(st => lower(st!.holding))
  const uniqueHoldings = [...new Set(holdings)].sort()
  const c = client(rpc!)

  const chainId = await c.getChainId()
  if (chainId !== d.chainId) throw new Error(`the RPC is chain ${chainId}, the config is chain ${d.chainId}`)

  // The signed price list: this chain, this distributor, this epoch, a current Safe owner, decimals as on chain.
  const file = JSON.parse(readFileSync(pricesPath!, 'utf8')) as PriceListFile
  const prices = parsePriceList(file)
  if (prices.epoch !== epoch) throw new Error(`the price list is for epoch ${prices.epoch}, not ${epoch}`)
  if (typeof file.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(file.signature)) throw new Error('the price list is not signed')
  const signer = await recoverPriceListSigner(prices, file.signature as Hex, chainId, h.distributor)
  if (file.signer !== undefined && lower(file.signer) !== signer) throw new Error(`the price list names signer ${file.signer} but ${signer} signed it`)
  const owners = await safeOwners(c, h.safe)
  if (!owners.includes(signer)) throw new Error(`price list signer ${signer} is not an owner of the Safe ${h.safe}`)
  for (const t of prices.tokens) {
    const onChain = await decimalsOf(c, t.token)
    if (onChain !== t.decimals) throw new Error(`price list: ${t.token} has ${onChain} decimals on chain, the list says ${t.decimals}`)
  }

  // The window, by block timestamp: [epochStart, epochEnd).
  const start = await c.readContract({ address: h.miningReserve, abi: reserveAbi, functionName: 'epochStart', args: [epoch] })
  const end = await c.readContract({ address: h.miningReserve, abi: reserveAbi, functionName: 'epochEnd', args: [epoch] })
  const latest = await c.getBlock({ blockTag: 'latest' })
  if (latest.timestamp < end) throw new Error(`epoch ${epoch} ends at ${end}; the chain is at ${latest.timestamp}`)
  const fromBlock = await firstBlockAtOrAfter(c, start, h.block, latest.number)
  const toBlock = (await firstBlockAtOrAfter(c, end, h.block, latest.number)) - 1n
  const logs = fromBlock <= toBlock ? await holdingLogs(c, uniqueHoldings, fromBlock, toBlock, page) : { fees: [], owed: [], withdrawals: [] }
  const budget = await budgetOf(c, h.miningReserve, epoch, h.block, latest.number, page)

  const r = computeEpoch({ ...logs, prices, budget: budget.available })
  const window = { start: s(start), end: s(end), fromBlock: s(fromBlock), toBlock: s(toBlock) }
  const priceList = {
    message: { epoch: s(prices.epoch), tokens: prices.tokens.map(t => ({ token: t.token, decimals: t.decimals, usdPrice: s(t.usdPrice) })), factoryUsdPrice: s(prices.factoryUsdPrice) },
    signer,
    signature: (file.signature as string).toLowerCase(),
  }
  const inputs = {
    chainId,
    epoch: s(epoch),
    window,
    holdings: uniqueHoldings,
    priceList,
    budget: { cumulativeBudget: s(budget.cumulativeBudget), fundedBefore: s(budget.fundedBefore), available: s(budget.available) },
    fees: r.fees.map(({ fee: f, status, usd }) => ({
      block: s(f.block), logIndex: f.logIndex, tx: f.tx.toLowerCase(), holding: f.holding,
      jobId: s(f.jobId), token: f.token, worker: f.worker, creator: f.creator, amount: s(f.amount), status, usd: s(usd),
    })),
  }
  const dataHash = dataHashOf(inputs)

  let root: Hex | null = null
  let tree = null
  const claims: Record<string, { amount: string; proof: Hex[] }> = {}
  const calls: Record<string, { to: Address; data: Hex }> = {}
  if (r.leaves.length > 0) {
    tree = buildTree(leafValues(epoch, r.leaves))
    root = tree.tree[0]!
    tree.values.forEach((v, i) => { claims[v.value[1]] = { amount: v.value[2], proof: proofOf(tree!, i) } })
    const toFund = r.total > budget.fundedThis ? r.total - budget.fundedThis : 0n
    if (toFund > 0n) calls.fund = { to: lower(h.miningReserve), data: encodeFunctionData({ abi: reserveAbi, functionName: 'fund', args: [epoch, toFund] }) }
    calls.setRoot = { to: lower(h.distributor), data: encodeFunctionData({ abi: distributorAbi, functionName: 'setRoot', args: [epoch, root, r.total, dataHash] }) }
  }

  const out = {
    chainId, epoch: s(epoch), window, priceList, budget: s(budget.available),
    feeUsd: s(r.feeUsd), factoryUsdPrice: s(r.factoryUsdPrice), demand: s(r.demand), emission: s(r.emission), total: s(r.total),
    root, dataHash, inputs, tree, claims, calls,
  }
  mkdirSync(outDir!, { recursive: true })
  const path = join(outDir!, `epoch-${epoch}.json`)
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`)

  const counted = r.fees.filter(f => f.status === 'counted').length
  console.log(`epoch ${epoch} on chain ${chainId}: blocks ${fromBlock}–${toBlock} (${start}–${end}), ${r.fees.length} fees, ${counted} counted`)
  console.log(`  price list signed by Safe owner ${getAddress(signer)}`)
  console.log(`  fee USD ${r.feeUsd} (18 dec), FACTORY price ${r.factoryUsdPrice}, demand ${r.demand}, budget ${budget.available}`)
  console.log(`  emission ${r.emission}, total ${r.total} over ${r.leaves.length} leaves`)
  console.log(`  root ${root ?? '(none: nothing to distribute)'}`)
  console.log(`  dataHash ${dataHash}`)
  if (budget.fundedThis > 0n) console.log(`  epoch ${epoch} already has ${budget.fundedThis} funded; fund adds only the rest`)
  for (const [name, call] of Object.entries(calls)) console.log(`  Safe call ${name}: to ${getAddress(call.to)} data ${call.data}`)
  console.log(`wrote ${path}`)
}

await main().catch((error: unknown) => {
  console.error(`mining:epoch failed: ${redact(error instanceof Error ? error.message : String(error))}`)
  process.exitCode = 1
})
