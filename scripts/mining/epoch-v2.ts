import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  deploymentFromConfig,
  networkMetaFromConfig,
  type DeploymentConfig,
  type Network,
} from '../../packages/sdk/src/deployment.ts'
import { stakeVaultAbi } from '../../packages/sdk/src/abi/stakeVault.ts'
import { agentWindowShare, walletShare } from '../../packages/sdk/src/backer-share-rule.ts'
import { decodeBackerShareBps } from './backers.ts'
import {
  budgetOf,
  client,
  logClient,
  decimalsOf,
  distributorAbi,
  epochWindowOf,
  firstBlockAtOrAfter,
  reserveAbi,
  safeOwners,
} from './chain.ts'
import { computeEpoch, dataHashOf, leafValues, type BackerPositionInput, type EpochResult } from './compute.ts'
import { computeEpochV2 } from './compute-v2.ts'
import { chainOrder } from './credit.ts'
import { MiningLedger, type MetadataSetRecord } from './ledger.ts'
import { readLedgerChain, isLedgerRecord, lower, type EpochChainRecord } from './ledger-chain.ts'
import { canonicalRuleV2, inputsV2Of, checkCanonicalPriceTokens, type WalletBackerShare } from './inputs-v2.ts'
import { checkIntegrity } from './integrity.ts'
import { fundingRemainder } from './lots.ts'
import { checkPriceRule, verifiedPriceList, type PriceListFile } from './prices.ts'
import { officialPoolOf, sampleOfficialPool } from './pool-chain.ts'
import { selectFactoryPrice } from './pool.ts'
import { creditRuleOf } from './rule.ts'
import { buildTree, proofOf } from './tree.ts'
import { encodeFunctionData, type Address, type Hex } from './viem.ts'

export type MiningConfig = DeploymentConfig & { mining?: { officialPool?: unknown } }
export interface EpochOptions {
  epoch: bigint
  network: Network
  config: MiningConfig
  rpc: string
  page: bigint
  pricesFile: PriceListFile
  previousFile?: PriceListFile
  previousPath?: string
  recompute?: boolean
}
const s = (value: bigint | number) => value.toString()
export const priceListOf = ({ prices, signer, signature }: Awaited<ReturnType<typeof verifiedPriceList>>) => ({
  message: {
    epoch: s(prices.epoch),
    tokens: prices.tokens.map((t) => ({ token: t.token, decimals: t.decimals, usdPrice: s(t.usdPrice) })),
    factoryUsdPrice: s(prices.factoryUsdPrice),
  },
  signer,
  signature,
})
const previousSigned = (value: Awaited<ReturnType<typeof verifiedPriceList>> | undefined) =>
  value === undefined
    ? null
    : {
        epoch: s(value.prices.epoch),
        factoryUsdPrice: s(value.prices.factoryUsdPrice),
        signer: value.signer,
        signature: value.signature,
        tokens: value.prices.tokens.map((token) => ({ ...token, usdPrice: s(token.usdPrice) })),
      }

function previousFileOf(options: EpochOptions): PriceListFile {
  if (options.previousFile !== undefined) return options.previousFile
  if (options.previousPath === undefined)
    throw new Error('no pool samples: provide the previous epoch signed prices with --previous-prices')
  // SAFETY: verifiedPriceList validates the untrusted message and signature immediately after this read.
  const file = JSON.parse(readFileSync(options.previousPath, 'utf8')) as PriceListFile & { priceList?: PriceListFile }
  return file.priceList ?? file
}

/** Shared read-only window/price/budget work; v1 normal runs retain their verbatim implementation. */
export async function readEpochContext(options: EpochOptions) {
  const { epoch, network, config, rpc, page } = options
  const d = deploymentFromConfig(network, config)
  if (d.sidequest === null) throw new Error('config records no v1 deployment')
  const h = d.sidequest
  const holdings = [
    ...new Set(Object.values(d.stacks).flatMap((st) => (st?.kind === 'sidequest-v1' ? [lower(st.holding)] : []))),
  ].toSorted()
  const c = client(rpc),
    lc = logClient(rpc)
  const chainId = await c.getChainId()
  if (chainId !== d.chainId) throw new Error(`the RPC is chain ${chainId}, the config is chain ${d.chainId}`)
  const owners = await safeOwners(c, h.safe)
  const signed = await verifiedPriceList(options.pricesFile, { epoch, chainId, distributor: h.distributor, owners })
  for (const token of signed.prices.tokens) {
    if ((await decimalsOf(c, token.token)) !== token.decimals)
      throw new Error(`price list decimals differ from chain for ${token.token}`)
  }
  const { start, end } = await epochWindowOf(c, h.miningReserve, epoch)
  const head = await c.getBlock({ blockTag: 'finalized' })
  if (head.timestamp < end) throw new Error(`epoch ${epoch} has not ended at the finalized head; wait for finality`)
  const fromBlock = await firstBlockAtOrAfter(c, start, h.block, head.number)
  const toBlock = (await firstBlockAtOrAfter(c, end, h.block, head.number)) - 1n
  const toBlockHash = (await c.getBlock({ blockNumber: toBlock })).hash
  if (toBlockHash === null) throw new Error('epoch end block has no hash')
  const evidence = await sampleOfficialPool({
    c,
    pool: officialPoolOf(config),
    factory: h.factory,
    prices: signed.prices,
    start,
    end,
    fromBlock,
    toBlock,
  })
  const samples = evidence.samples.flatMap((sample) =>
    sample.status === 'sampled' ? [BigInt(sample.factoryUsdPrice)] : [],
  )
  const previous =
    samples.length === 0 && epoch > 0n
      ? await verifiedPriceList(previousFileOf(options), {
          epoch: epoch - 1n,
          chainId,
          distributor: h.distributor,
          owners,
        })
      : undefined
  const selected = selectFactoryPrice(epoch, samples, previous?.prices.factoryUsdPrice)
  if (signed.prices.factoryUsdPrice !== selected.factoryUsdPrice)
    throw new Error('signed SIDE price differs from the conservative-high hourly rule')
  const pager = { page }
  const budget = options.recompute
    ? await (
        await import('./recompute.ts')
      ).recomputeBudgetOf({ c, lc, reserve: h.miningReserve, epoch, deployBlock: h.block, head: head.number, pager })
    : await budgetOf(c, h.miningReserve, epoch, h.block, head.number, page)
  return {
    ...options,
    d,
    h,
    c,
    lc,
    chainId,
    holdings,
    start,
    end,
    fromBlock,
    toBlock,
    head,
    pager,
    signed,
    prices: signed.prices,
    window: { start: s(start), end: s(end), fromBlock: s(fromBlock), toBlock: s(toBlock), toBlockHash },
    priceList: priceListOf(signed),
    factoryPriceEvidence: { ...evidence, source: selected.source, previousSignedPrice: previousSigned(previous) },
    budget,
  }
}
export type EpochContext = Awaited<ReturnType<typeof readEpochContext>>
export const canonicalBudget = (budget: EpochContext['budget']) => ({
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
})

export function replayEpochLedger(records: readonly EpochChainRecord[], fromBlock: bigint, toBlock: bigint) {
  const ledger = new MiningLedger()
  const ordered = records.filter((record) => record.block <= toBlock).toSorted(chainOrder)
  for (const prior of ordered.filter((entry) => entry.block < fromBlock && isLedgerRecord(entry)))
    if (isLedgerRecord(prior)) ledger.apply(prior)
  const start = ledger.snapshot()
  for (const current of ordered.filter((entry) => entry.block >= fromBlock && isLedgerRecord(entry)))
    if (isLedgerRecord(current)) ledger.apply(current)
  const end = ledger.snapshot()
  const window = ordered.filter((record) => record.block >= fromBlock)
  const fees = window.filter((record) => record.eventName === 'FeeCharged')
  const owed = window.filter((record) => record.eventName === 'PayoutOwed')
  const withdrawals = window.filter((record) => record.eventName === 'OwedWithdrawn')
  return { ledger, start, end, fees, owed, withdrawals }
}
export type EpochReplay = ReturnType<typeof replayEpochLedger>

function windowShare(sets: readonly MetadataSetRecord[], windowStart: bigint, fromBlock: bigint) {
  const before = sets.filter((set) => set.block < fromBlock).toSorted(chainOrder)
  const bps = BigInt(
    agentWindowShare(
      before.map((set) => ({ position: set.block, value: set.value })),
      windowStart,
      fromBlock,
    ),
  )
  const eligible = [
    before.filter((set) => set.block < windowStart).at(-1),
    ...before.filter((set) => set.block >= windowStart),
  ].filter((set) => set !== undefined)
  const source = eligible.findLast((set) => decodeBackerShareBps(set.value) === bps) ?? null
  return { bps, source }
}

function weightedPositions(replay: EpochReplay, worker: Address): BackerPositionInput[] {
  return [...replay.end.positions]
    .filter(([, position]) => position.account === worker)
    .map(([key, position]) => {
      const previous = replay.start.positions.get(key)
      const start = previous?.generation === position.generation ? previous.active : 0n
      const end = position.active
      return { account: worker, delegator: position.delegator, start, end, weight: start < end ? start : end }
    })
}

/** IDs from earlier work plus counted activations in this epoch determine a wallet's maximum offered share. */
export function epochBackerWorkers(
  replay: EpochReplay,
  counted: readonly { worker: Address; holding: Address; jobId: bigint }[],
  shareBlock: bigint,
  fromBlock: bigint,
) {
  const shares: WalletBackerShare[] = []
  const workers = [...new Set(counted.map((fee) => fee.worker))].toSorted()
  for (const worker of workers) {
    const ids = new Set(replay.start.wallets.get(worker) ?? [])
    for (const countedFee of counted.filter((entry) => entry.worker === worker))
      ids.add(replay.ledger.activationOf(countedFee.holding, countedFee.jobId).agentId)
    const agentIds = [...ids].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    const values = new Map(
      agentIds.map((id) => [id, windowShare(replay.end.shareSets.get(id) ?? [], shareBlock, fromBlock)]),
    )
    const bps = BigInt(walletShare(agentIds, (id) => Number(values.get(id)?.bps ?? 0n)))
    const sources = [...values.values()]
      .filter((value) => value.bps === bps)
      .flatMap((value) => (value.source === null ? [] : [value.source]))
      .toSorted(chainOrder)
    const source = sources.at(-1) ?? null
    shares.push({ worker, bps, agentIds, source })
  }
  return {
    shares,
    backerWorkers: shares.map((share) => ({
      worker: share.worker,
      agentId: share.agentIds[0] ?? 0n,
      bps: share.bps,
      positions: weightedPositions(replay, share.worker),
    })),
  }
}

export function computeLedgerEpoch(
  replay: EpochReplay,
  prices: EpochContext['prices'],
  budget: bigint,
  shareBlock: bigint,
  fromBlock: bigint,
) {
  const stakes = [...new Set(replay.fees.map((fee) => fee.worker))].map((worker) => ({
    worker,
    start: replay.start.stakes.get(worker) ?? 0n,
    end: replay.end.stakes.get(worker) ?? 0n,
  }))
  const topUps = replay.end.topUps.filter((topUp) =>
    replay.fees.some((fee) => fee.bonusPart > 0n && fee.holding === topUp.holding && fee.jobId === topUp.jobId),
  )
  const completeTopUps = topUps.map((topUp) => {
    if (topUp.tx === undefined) throw new Error('missing top-up transaction')
    return { ...topUp, tx: topUp.tx }
  })
  const activations = [...replay.end.activations.values()]
  const base = {
    fees: replay.fees,
    owed: replay.owed,
    withdrawals: replay.withdrawals,
    topUps: completeTopUps,
    prices,
    budget,
    activations,
    schedules: replay.end.feeSchedules,
    stakes,
  }
  const counted = computeEpoch({ ...base })
    .fees.filter((fee) => fee.status === 'counted')
    .map((record) => record.fee)
  const backers = epochBackerWorkers(replay, counted, shareBlock, fromBlock)
  const result = computeEpochV2({ ...base, backerWorkers: backers.backerWorkers })
  return {
    result,
    counted,
    topUps,
    stakes: stakes.filter((stake) => counted.some((fee) => fee.worker === stake.worker)),
    ...backers,
  }
}

/** Same tree, claims and Safe calldata format as v1, including the additive funding precondition. */
export function epochArtifact(context: EpochContext, result: EpochResult, inputs: unknown) {
  const { epoch, chainId, window, priceList, budget, h } = context
  const dataHash = dataHashOf(inputs)
  const tree = result.leaves.length === 0 ? null : buildTree(leafValues(epoch, result.leaves))
  const root = tree?.tree[0] ?? null
  const claims: Record<string, { amount: string; proof: Hex[] }> = {}
  const calls: Record<string, { to: Address; data: Hex; expect?: { totalFunded: string; fundedForEpoch: string } }> = {}
  const toFund = fundingRemainder(result.total, budget.fundedThis)
  if (tree !== null && root !== null) {
    tree.values.forEach((value, i) => {
      claims[value.value[1]] = { amount: value.value[2], proof: proofOf(tree, i) }
    })
    if (toFund > 0n)
      calls.fund = {
        to: lower(h.miningReserve),
        data: encodeFunctionData({ abi: reserveAbi, functionName: 'fund', args: [epoch, toFund] }),
        expect: { totalFunded: s(budget.totalFunded), fundedForEpoch: s(budget.fundedThis) },
      }
    calls.setRoot = {
      to: lower(h.distributor),
      data: encodeFunctionData({
        abi: distributorAbi,
        functionName: 'setRoot',
        args: [epoch, root, result.total, dataHash],
      }),
    }
  }
  return {
    chainId,
    epoch: s(epoch),
    window,
    priceList,
    budget: s(budget.available),
    feeUsd: s(result.feeUsd),
    factoryUsdPrice: s(result.factoryUsdPrice),
    demand: s(result.demand),
    emission: s(result.emission),
    total: s(result.total),
    root,
    dataHash,
    inputs,
    tree,
    claims,
    calls,
  }
}

export async function buildEpochV2(context: EpochContext) {
  const { c, lc, h, d, config, head, start, fromBlock, toBlock, pager } = context
  checkCanonicalPriceTokens(context.prices.tokens)
  if (context.factoryPriceEvidence.previousSignedPrice !== null)
    checkCanonicalPriceTokens(context.factoryPriceEvidence.previousSignedPrice.tokens)
  const rule = creditRuleOf(config, context.epoch)
  if (rule.version !== 2) throw new Error('v2 epoch precedes configured cutover')
  const delay = BigInt(
    await c.readContract({
      address: h.vault,
      abi: stakeVaultAbi,
      functionName: 'UNSTAKE_DELAY',
      blockNumber: head.number,
    }),
  )
  if (
    config.deployment.sidequest?.clocks?.unstakeDelay === undefined ||
    delay !== BigInt(config.deployment.sidequest.clocks.unstakeDelay)
  )
    throw new Error('vault UNSTAKE_DELAY differs from configured clocks')
  const shareStart = start > delay ? start - delay : 0n
  const shareBlock = await firstBlockAtOrAfter(c, shareStart, h.block, fromBlock)
  const historyStart = d.deployBlock < h.block ? d.deployBlock : h.block
  const chainInput = {
    c: lc,
    holdings: context.holdings,
    vault: h.vault,
    feeSchedule: h.feeSchedule,
    reserve: h.miningReserve,
    identity: d.identity,
    pager,
  }
  const records = await readLedgerChain({ ...chainInput, fromBlock: historyStart, toBlock })
  const replay = replayEpochLedger(records, fromBlock, toBlock)
  const computed = computeLedgerEpoch(replay, context.prices, context.budget.available, shareBlock, fromBlock)
  const pegged = networkMetaFromConfig(config).usdPegged
  checkPriceRule(context.prices, {
    factory: h.factory,
    factoryUsdPrice: computed.result.factoryUsdPrice,
    network: context.network,
    usdPegged: pegged,
  })
  const inputs = inputsV2Of({
    chainId: context.chainId,
    epoch: context.epoch,
    rule: canonicalRuleV2(rule.fromEpoch, delay, context.network === 'monad-mainnet', pegged),
    window: context.window,
    shareWindow: { start: s(shareStart), block: s(shareBlock) },
    holdings: context.holdings,
    priceList: context.priceList,
    factoryPriceEvidence: context.factoryPriceEvidence,
    budget: canonicalBudget(context.budget),
    feeSchedules: replay.end.feeSchedules,
    fees: computed.result.fees,
    topUps: computed.topUps,
    backing: computed.stakes,
    backerShares: computed.shares,
    backerPositions: computed.result.backerPositions,
  })
  const continuation = await readLedgerChain({ ...chainInput, fromBlock: toBlock + 1n, toBlock: head.number })
  for (const record of continuation) if (isLedgerRecord(record)) replay.ledger.apply(record)
  await checkIntegrity({
    c,
    deployment: d,
    sidequest: h,
    holdings: context.holdings,
    head: head.number,
    ledger: replay.ledger,
    fees: computed.counted,
    workers: computed.shares.map((share) => share.worker),
    agentIds: [...new Set(computed.shares.flatMap((share) => share.agentIds))],
  })
  return { ...epochArtifact(context, computed.result, inputs), rule: 2, creditUsd: s(computed.result.creditUsd) }
}

export async function runEpochV2(options: EpochOptions, outDir: string) {
  const artifact = await buildEpochV2(await readEpochContext(options))
  mkdirSync(outDir, { recursive: true })
  const path = join(outDir, `epoch-${options.epoch}.json`)
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`)
  console.log(
    `epoch ${options.epoch} rule 2: fee USD ${artifact.feeUsd}, credit USD ${artifact.creditUsd}, emission ${artifact.emission}, total ${artifact.total}`,
  )
  console.log(`root ${artifact.root ?? '(none)'}, dataHash ${artifact.dataHash}`)
  for (const [name, call] of Object.entries(artifact.calls))
    console.log(`Safe call ${name}: to ${call.to} data ${call.data}`)
  console.log(`wrote ${path}`)
}
