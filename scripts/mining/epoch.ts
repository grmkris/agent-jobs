import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { deploymentFromConfig, type DeploymentConfig, type Network } from '../../packages/sdk/src/deployment.ts'
import {
  budgetOf,
  client,
  decimalsOf,
  distributorAbi,
  epochWindowOf,
  firstBlockAtOrAfter,
  holdingLogs,
  reserveAbi,
  safeOwners,
  topUpLogs,
} from './chain.ts'
import { computeEpoch, dataHashOf, leafValues } from './compute.ts'
import { fundingRemainder } from './lots.ts'
import { verifiedPriceList, type PriceListFile } from './prices.ts'
import { officialPoolOf, sampleOfficialPool } from './pool-chain.ts'
import { selectFactoryPrice } from './pool.ts'
import { buildTree, proofOf } from './tree.ts'
import { encodeFunctionData, getAddress, type Address, type Hex } from './viem.ts'

// bun run mining:epoch <n> [--network monad-testnet|monad-mainnet] --prices <signed JSON> --out <dir>
//                       [--rpc <url>] [--config <config JSON>] [--page <blocks>] [--previous-prices <signed JSON>] (README.md)

const argv = process.argv.slice(2)
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? undefined : argv[i + 1]
}
const usage =
  'usage: bun run mining:epoch <n> [--network monad-testnet|monad-mainnet] --prices <signed price list JSON> --out <dir> [--rpc <url>] [--config <path>] [--page <blocks>] [--previous-prices <signed JSON>]'
const epochArg = argv[0]
const network = (flag('network') ?? 'monad-testnet') as Network
const pricesPath = flag('prices')
const outDir = flag('out')
if (epochArg === undefined || !/^[0-9]+$/.test(epochArg) || pricesPath === undefined || outDir === undefined)
  throw new Error(usage)
if (network !== 'monad-testnet' && network !== 'monad-mainnet') throw new Error(usage)
const epoch = BigInt(epochArg)
const rpc = flag('rpc') ?? process.env[network === 'monad-mainnet' ? 'MONAD_MAINNET_RPC_URL' : 'MONAD_TESTNET_RPC_URL']
if (rpc === undefined || rpc === '')
  throw new Error(`set --rpc or ${network === 'monad-mainnet' ? 'MONAD_MAINNET_RPC_URL' : 'MONAD_TESTNET_RPC_URL'}`)
const pageArg = flag('page') ?? '1000'
if (!/^[1-9][0-9]*$/.test(pageArg)) throw new Error(`--page takes a positive number of blocks. ${usage}`)
const page = BigInt(pageArg)
const configPath = resolve(flag('config') ?? join(import.meta.dirname, '../../contracts/config', `${network}.json`))
const previousPricesPath = flag('previous-prices') ?? join(outDir!, `epoch-${epoch - 1n}.json`)

// Errors from the RPC client can quote the URL; it may carry a key.
const redact = (text: string) => text.split(rpc).join('<rpc>')
const s = (v: bigint | number) => v.toString()
const lower = (a: string) => a.toLowerCase() as Address

async function main() {
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as DeploymentConfig & {
    mining?: { officialPool?: unknown }
  }
  const d = deploymentFromConfig(network, config)
  if (d.sidequest === null) throw new Error(`${configPath} records no v1 deployment`)
  const h = d.sidequest
  const holdings = Object.values(d.stacks)
    .filter((st) => st?.kind === 'sidequest-v1')
    .map((st) => lower(st!.holding))
  const uniqueHoldings = [...new Set(holdings)].toSorted()
  const c = client(rpc!)

  const chainId = await c.getChainId()
  if (chainId !== d.chainId) throw new Error(`the RPC is chain ${chainId}, the config is chain ${d.chainId}`)

  // The signed price list: this chain, this distributor, this epoch, a current Safe owner, decimals as on chain.
  const file = JSON.parse(readFileSync(pricesPath!, 'utf8')) as PriceListFile
  const owners = await safeOwners(c, h.safe)
  const { prices, signer, signature } = await verifiedPriceList(file, {
    epoch,
    chainId,
    distributor: h.distributor,
    owners,
  })
  for (const t of prices.tokens) {
    const onChain = await decimalsOf(c, t.token)
    if (onChain !== t.decimals)
      throw new Error(`price list: ${t.token} has ${onChain} decimals on chain, the list says ${t.decimals}`)
  }

  // The window, by block timestamp: [epochStart, epochEnd), read only up to the finalized head (B8-SEC-002), so no
  // reorg can change what it counts; the last window block's hash is committed in the inputs.
  const { start, end } = await epochWindowOf(c, h.miningReserve, epoch)
  const head = await c.getBlock({ blockTag: 'finalized' })
  if (head.timestamp < end)
    throw new Error(
      `epoch ${epoch} ends at ${end}; the finalized head is block ${head.number} at ${head.timestamp}: wait for it`,
    )
  const fromBlock = await firstBlockAtOrAfter(c, start, h.block, head.number)
  const toBlock = (await firstBlockAtOrAfter(c, end, h.block, head.number)) - 1n
  const toBlockHash = (await c.getBlock({ blockNumber: toBlock })).hash
  const factoryPriceEvidence = await sampleOfficialPool({
    c,
    pool: officialPoolOf(config),
    factory: h.factory,
    prices,
    start,
    end,
    fromBlock,
    toBlock,
  })
  const sampledPrices = factoryPriceEvidence.samples.flatMap((sample) =>
    sample.status === 'sampled' ? [BigInt(sample.factoryUsdPrice)] : [],
  )
  let previousPrice: Awaited<ReturnType<typeof verifiedPriceList>> | undefined
  if (sampledPrices.length === 0 && epoch > 0n) {
    let previousFile: PriceListFile
    try {
      const previous = JSON.parse(readFileSync(previousPricesPath, 'utf8')) as PriceListFile & {
        priceList?: PriceListFile
      }
      previousFile = previous.priceList ?? previous
    } catch (cause) {
      throw new Error('no pool samples: provide the previous epoch signed prices with --previous-prices', { cause })
    }
    previousPrice = await verifiedPriceList(previousFile, {
      epoch: epoch - 1n,
      chainId,
      distributor: h.distributor,
      owners,
    })
  }
  const selectedPrice = selectFactoryPrice(epoch, sampledPrices, previousPrice?.prices.factoryUsdPrice)
  if (prices.factoryUsdPrice !== selectedPrice.factoryUsdPrice)
    throw new Error('signed SIDE price differs from the conservative-high hourly rule')
  const logs =
    fromBlock <= toBlock
      ? await holdingLogs(c, uniqueHoldings, fromBlock, toBlock, page)
      : { fees: [], owed: [], withdrawals: [] }
  const topUps = await topUpLogs(c, logs.fees, d.deployBlock < h.block ? d.deployBlock : h.block, toBlock, page)
  const budget = await budgetOf(c, h.miningReserve, epoch, h.block, head.number, page)

  const r = computeEpoch({ ...logs, topUps, prices, budget: budget.available })
  const toFund = fundingRemainder(r.emission, budget.fundedThis)
  const window = { start: s(start), end: s(end), fromBlock: s(fromBlock), toBlock: s(toBlock), toBlockHash }
  const priceList = {
    message: {
      epoch: s(prices.epoch),
      tokens: prices.tokens.map((t) => ({ token: t.token, decimals: t.decimals, usdPrice: s(t.usdPrice) })),
      factoryUsdPrice: s(prices.factoryUsdPrice),
    },
    signer,
    signature,
  }
  const inputs = {
    chainId,
    epoch: s(epoch),
    window,
    holdings: uniqueHoldings,
    priceList,
    factoryPriceEvidence: {
      ...factoryPriceEvidence,
      source: selectedPrice.source,
      previousSignedPrice:
        previousPrice === undefined
          ? null
          : {
              epoch: s(previousPrice.prices.epoch),
              factoryUsdPrice: s(previousPrice.prices.factoryUsdPrice),
              signer: previousPrice.signer,
              signature: previousPrice.signature,
              tokens: previousPrice.prices.tokens.map((token) => ({ ...token, usdPrice: s(token.usdPrice) })),
            },
    },
    budget: {
      cumulativeBudget: s(budget.cumulativeBudget),
      fundedBefore: s(budget.fundedBefore),
      available: s(budget.available),
      usable: budget.usable.map((lot) => ({
        epoch: s(lot.epoch),
        scheduled: s(lot.scheduled),
        remaining: s(lot.remaining),
      })),
      expired: budget.expired.map((lot) => ({
        epoch: s(lot.epoch),
        scheduled: s(lot.scheduled),
        remaining: s(lot.remaining),
      })),
    },
    fees: r.fees.map(({ fee: f, status, usd }) => ({
      block: s(f.block),
      logIndex: f.logIndex,
      tx: f.tx.toLowerCase(),
      holding: f.holding,
      jobId: s(f.jobId),
      token: f.token,
      worker: f.worker,
      creator: f.creator,
      amount: s(f.amount),
      bonusPart: s(f.bonusPart),
      status,
      usd: s(usd),
    })),
    topUps: topUps.map((topUp) => ({
      ...topUp,
      block: s(topUp.block),
      jobId: s(topUp.jobId),
      amount: s(topUp.amount),
      bonus: s(topUp.bonus),
      tx: topUp.tx.toLowerCase(),
    })),
  }
  const dataHash = dataHashOf(inputs)

  let root: Hex | null = null
  let tree = null
  const claims: Record<string, { amount: string; proof: Hex[] }> = {}
  const calls: Record<string, { to: Address; data: Hex; expect?: { totalFunded: string; fundedForEpoch: string } }> = {}
  if (r.leaves.length > 0) {
    tree = buildTree(leafValues(epoch, r.leaves))
    root = tree.tree[0]!
    tree.values.forEach((v, i) => {
      claims[v.value[1]] = { amount: v.value[2], proof: proofOf(tree!, i) }
    })
    // fund adds to what is there: it is right only while totalFunded() is still what this run read (B8-SEC-004).
    if (toFund > 0n) {
      calls.fund = {
        to: lower(h.miningReserve),
        data: encodeFunctionData({ abi: reserveAbi, functionName: 'fund', args: [epoch, toFund] }),
        expect: { totalFunded: s(budget.totalFunded), fundedForEpoch: s(budget.fundedThis) },
      }
    }
    calls.setRoot = {
      to: lower(h.distributor),
      data: encodeFunctionData({
        abi: distributorAbi,
        functionName: 'setRoot',
        args: [epoch, root, r.total, dataHash],
      }),
    }
  }

  const out = {
    chainId,
    epoch: s(epoch),
    window,
    priceList,
    budget: s(budget.available),
    feeUsd: s(r.feeUsd),
    factoryUsdPrice: s(r.factoryUsdPrice),
    demand: s(r.demand),
    emission: s(r.emission),
    total: s(r.total),
    root,
    dataHash,
    inputs,
    tree,
    claims,
    calls,
  }
  mkdirSync(outDir!, { recursive: true })
  const path = join(outDir!, `epoch-${epoch}.json`)
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`)

  const counted = r.fees.filter((f) => f.status === 'counted').length
  console.log(
    `epoch ${epoch} on chain ${chainId}: blocks ${fromBlock}–${toBlock} (${start}–${end}), ${r.fees.length} fees, ${counted} counted`,
  )
  console.log(`  price list signed by Safe owner ${getAddress(signer)}`)
  console.log(
    `  fee USD ${r.feeUsd} (18 dec), SIDE price ${r.factoryUsdPrice}, demand ${r.demand}, budget ${budget.available}`,
  )
  console.log(`  emission ${r.emission}, total ${r.total} over ${r.leaves.length} leaves`)
  console.log(`  root ${root ?? '(none: nothing to distribute)'}`)
  console.log(`  dataHash ${dataHash}`)
  if (budget.fundedThis > 0n)
    console.log(`  epoch ${epoch} already has ${budget.fundedThis} funded; fund adds only the rest`)
  for (const [name, call] of Object.entries(calls))
    console.log(`  Safe call ${name}: to ${getAddress(call.to)} data ${call.data}`)
  if (calls.fund !== undefined) {
    console.log(
      `  fund adds ${r.emission - budget.fundedThis}: send it only while MiningReserve.totalFunded() is ${budget.totalFunded} (epoch ${epoch} has ${budget.fundedThis}); if it moved, run this again`,
    )
  }
  console.log(`wrote ${path}`)
}

await main().catch((error: unknown) => {
  console.error(`mining:epoch failed: ${redact(error instanceof Error ? error.message : String(error))}`)
  process.exitCode = 1
})
