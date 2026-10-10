import { expect, test } from 'bun:test'
import { forkEnabled, forkSetupTimeout, startSidequestFork } from '../../packages/sdk/test/sidequest-fixture.ts'
import {
  accept,
  activate,
  delegate,
  hashText,
  publish,
  registerAgent,
  requestUndelegate,
  settle,
  signSelection,
  submit,
  topUp,
  type Wallet,
} from '../../packages/sdk/src/actions.ts'
import { epochDistributorAbi } from '../../packages/sdk/src/abi/epochDistributor.ts'
import { stakeVaultAbi } from '../../packages/sdk/src/abi/stakeVault.ts'
import { identityAbi } from '../../packages/sdk/src/abi/identity.ts'
import { factoryV2Abi } from '../../packages/sdk/src/abi/factoryV2.ts'
import { BACKER_SHARE_KEY } from './backers.ts'
import { epochWindowOf, firstBlockAtOrAfter, logClient, pagedLogs } from './chain.ts'
import { computeLedgerEpoch, replayEpochLedger, priceListOf } from './epoch-v2.ts'
import { canonicalRuleV2, inputsV2Of } from './inputs-v2.ts'
import { checkIntegrity } from './integrity.ts'
import { checkPriceRule, priceListDomain, PRICE_LIST_TYPES, typedMessage, type PriceList } from './prices.ts'
import { readLedgerChain, scheduleExecutedEvent, lower, type EpochChainRecord } from './ledger-chain.ts'
import { dataHashOf, leafValues } from './compute.ts'
import { buildTree, proofOf } from './tree.ts'
import { parseEther } from './viem.ts'

type Fork = Awaited<ReturnType<typeof startSidequestFork>>
async function setShare(f: Fork, wallet: Wallet, agentId: bigint, bps: bigint) {
  const hash = await wallet.writeContract({
    address: f.ctx.deployment.identity,
    abi: identityAbi,
    functionName: 'setMetadata',
    args: [agentId, BACKER_SHARE_KEY, `0x${bps.toString(16).padStart(64, '0')}`],
  })
  expect((await f.ctx.publicClient.waitForTransactionReceipt({ hash })).status).toBe('success')
}

async function paidJob(f: Fork, wallet: Wallet, agentId: bigint, name: string, bonus = 0n) {
  const { ctx, creator, contributor, arbitrator } = f
  const now = Number((await ctx.publicClient.getBlock()).timestamp)
  const terms = {
    creator: creator.account.address,
    approver: creator.account.address,
    token: ctx.stack.factory,
    reward: parseEther('10000'),
    creatorBond: parseEther('10'),
    workerBond: 0n,
    arbitrator: arbitrator.account.address,
    reviewWindow: 120,
    disputeWindow: 120,
    arbitrationWindow: 300,
    deliveryDeadline: now + 600,
  }
  const termsHash = hashText(name)
  const { jobId } = await publish(ctx, creator, { ...terms, manifestHash: hashText('v2-fork-fixture'), termsHash })
  const selection = { jobId, worker: wallet.account.address, agentId, termsHash, activateBy: now + 300, nonce: jobId }
  await activate(ctx, wallet, selection, await signSelection(ctx, creator, selection), terms)
  if (bonus > 0n) await topUp(ctx, contributor, jobId, bonus)
  await submit(ctx, wallet, jobId, hashText('finished'))
  await accept(ctx, creator, jobId)
  await settle(ctx, contributor, jobId)
  return jobId
}

function assertReplayRefusals(input: {
  records: EpochChainRecord[]
  firstJob: bigint
  fromBlock: bigint
  toBlock: bigint
  shareBlock: bigint
  prices: PriceList
  borrower: `0x${string}`
}) {
  const badFee = input.records.map((record) =>
    record.eventName === 'FeeCharged' && record.jobId === input.firstJob
      ? { ...record, amount: record.amount - 1n, bonusPart: record.bonusPart - 1n }
      : record,
  )
  expect(() =>
    computeLedgerEpoch(
      replayEpochLedger(badFee, input.fromBlock, input.toBlock),
      input.prices,
      parseEther('1000000'),
      input.shareBlock,
      input.fromBlock,
    ),
  ).toThrow('rounding')
  const badRank = input.records.map((record) =>
    record.eventName === 'Activated' && record.jobId === input.firstJob ? { ...record, feeBps: 300n } : record,
  )
  expect(() => replayEpochLedger(badRank, input.fromBlock, input.toBlock)).toThrow('snapshot')
  const badWorker = input.records.map((record) =>
    record.eventName === 'FeeCharged' && record.jobId === input.firstJob
      ? { ...record, worker: input.borrower }
      : record,
  )
  expect(() =>
    computeLedgerEpoch(
      replayEpochLedger(badWorker, input.fromBlock, input.toBlock),
      input.prices,
      parseEther('1000000'),
      input.shareBlock,
      input.fromBlock,
    ),
  ).toThrow('worker or holding')
  const badSchedule = input.records.map((record) =>
    record.eventName === 'ScheduleExecuted' ? { ...record, bps: [3000n, 1000n, 300n, 0n] } : record,
  )
  expect(() => replayEpochLedger(badSchedule, input.fromBlock, input.toBlock)).toThrow('lowest bps')
}

/** Coordinator-run only: real registry, vault/fee events, paid jobs and a claim on a local Monad fork. */
test.skipIf(!forkEnabled)(
  'v2 credit epoch keeps notice and wallet shares, bounds borrowed tiers, excludes dust, and stakes its claim',
  async () => {
    const f = await startSidequestFork()
    try {
      const { ctx, creator, worker, contributor, arbitrator } = f
      const h = ctx.deployment.sidequest
      if (h === null) throw new Error('fork deployment missing')
      const c = ctx.publicClient,
        lc = logClient(f.url),
        pager = { page: 1000n }
      const setupEnd = await c.getBlockNumber({ cacheTime: 0 })
      const schedules = await pagedLogs(setupEnd > 128n ? setupEnd - 128n : 0n, setupEnd, pager, (fromBlock, toBlock) =>
        lc.getLogs({ address: h.feeSchedule, event: scheduleExecutedEvent, fromBlock, toBlock, strict: true }),
      )
      const historyStart = schedules[0]?.blockNumber
      if (historyStart === undefined) throw new Error('fresh fixture schedule constructor event missing')
      await f.send(ctx.stack.factory, factoryV2Abi, 'transfer', [creator.account.address, parseEther('50000')])
      await f.send(ctx.stack.factory, factoryV2Abi, 'transfer', [contributor.account.address, parseEther('150000')])
      await f.send(ctx.stack.factory, factoryV2Abi, 'transfer', [arbitrator.account.address, 1n])
      const firstId = await registerAgent(ctx, worker, 'https://sidequest.exchange/v2-fork-first')
      const secondId = await registerAgent(ctx, worker, 'https://sidequest.exchange/v2-fork-second')
      const borrowerId = await registerAgent(ctx, contributor, 'https://sidequest.exchange/v2-fork-borrower')
      await delegate(ctx, creator, parseEther('20'))
      await delegate(ctx, creator, parseEther('5000'), worker.account.address)
      await delegate(ctx, contributor, parseEther('5000'), worker.account.address)
      await delegate(ctx, arbitrator, 1n, worker.account.address)
      await setShare(f, worker, firstId, 5000n)
      await paidJob(f, worker, firstId, 'v2-fork-historical-id')
      await setShare(f, worker, firstId, 1000n)
      await setShare(f, worker, firstId, 7000n)
      const epoch = 1n
      const { start, end } = await epochWindowOf(c, h.miningReserve, epoch)
      await f.rpc('evm_setNextBlockTimestamp', [Number(start)])
      await f.rpc('evm_mine')
      const fromBlock = await c.getBlockNumber({ cacheTime: 0 })
      const firstJob = await paidJob(f, worker, secondId, 'v2-fork-second-id', 11n)
      await delegate(ctx, contributor, parseEther('100000'))
      await paidJob(f, contributor, borrowerId, 'v2-fork-borrowed-tier')
      await requestUndelegate(ctx, contributor, parseEther('100000'))
      await setShare(f, worker, firstId, 9000n)
      await f.rpc('evm_setNextBlockTimestamp', [Number(end) - 1])
      await f.rpc('evm_mine')
      const toBlock = await c.getBlockNumber({ cacheTime: 0 })
      const delay = BigInt(
        await c.readContract({ address: h.vault, abi: stakeVaultAbi, functionName: 'UNSTAKE_DELAY' }),
      )
      const shareStart = start > delay ? start - delay : 0n
      const shareBlock = await firstBlockAtOrAfter(c, shareStart, historyStart, fromBlock)
      const records = await readLedgerChain({
        c: lc,
        holdings: [ctx.stack.holding],
        vault: h.vault,
        feeSchedule: h.feeSchedule,
        reserve: h.miningReserve,
        identity: ctx.deployment.identity,
        fromBlock: historyStart,
        toBlock,
        pager,
      })
      const replay = replayEpochLedger(records, fromBlock, toBlock)
      const prices = {
        epoch,
        tokens: [{ token: lower(ctx.stack.factory), decimals: 18, usdPrice: parseEther('1') }],
        factoryUsdPrice: parseEther('1'),
      }
      const result = computeLedgerEpoch(replay, prices, parseEther('1000000'), shareBlock, fromBlock)
      expect(result.result.fees.map((fee) => fee.credit?.activationRank)).toEqual([1, 2])
      expect(result.result.fees.map((fee) => fee.credit?.heldRank)).toEqual([1, 0])
      expect(result.shares.find((share) => share.worker === lower(worker.account.address))).toMatchObject({
        bps: 7000n,
        agentIds: [firstId, secondId],
      })
      expect(
        result.result.backerPositions.some((position) => position.delegator === lower(arbitrator.account.address)),
      ).toBe(false)
      checkPriceRule(prices, {
        factory: ctx.stack.factory,
        factoryUsdPrice: prices.factoryUsdPrice,
        network: 'monad-testnet',
        usdPegged: [],
      })
      expect(() =>
        checkPriceRule(prices, {
          factory: ctx.stack.factory,
          factoryUsdPrice: 10n ** 14n,
          network: 'monad-testnet',
          usdPegged: [],
        }),
      ).toThrow('reference price')
      assertReplayRefusals({
        records,
        firstJob,
        fromBlock,
        toBlock,
        shareBlock,
        prices,
        borrower: lower(contributor.account.address),
      })
      await checkIntegrity({
        c,
        deployment: ctx.deployment,
        sidequest: h,
        holdings: [ctx.stack.holding],
        head: toBlock,
        ledger: replay.ledger,
        fees: result.counted,
        workers: result.shares.map((share) => share.worker),
        agentIds: [firstId, secondId, borrowerId],
      })
      const signature = await f.admin.signTypedData({
        domain: priceListDomain(10143, h.distributor),
        types: PRICE_LIST_TYPES,
        primaryType: 'PriceList',
        message: typedMessage(prices),
      })
      const inputs = inputsV2Of({
        chainId: 10143,
        epoch,
        rule: canonicalRuleV2(1n, delay, false, []),
        window: {
          start: start.toString(),
          end: end.toString(),
          fromBlock: fromBlock.toString(),
          toBlock: toBlock.toString(),
          toBlockHash: (await c.getBlock({ blockNumber: toBlock })).hash,
        },
        shareWindow: { start: shareStart.toString(), block: shareBlock.toString() },
        holdings: [ctx.stack.holding],
        priceList: priceListOf({ prices, signer: lower(f.admin.account.address), signature }),
        factoryPriceEvidence: null,
        budget: { available: parseEther('1000000').toString() },
        feeSchedules: replay.end.feeSchedules,
        fees: result.result.fees,
        topUps: result.topUps,
        backing: result.stakes,
        backerShares: result.shares,
        backerPositions: result.result.backerPositions,
      })
      const tree = buildTree(leafValues(epoch, result.result.leaves))
      const account = lower(contributor.account.address),
        leaf = result.result.leaves.find((entry) => entry.account === account)
      if (leaf === undefined) throw new Error('backer claim leaf missing')
      expect(leaf.amount).toBeGreaterThan(0n)
      await f.rpc('evm_setNextBlockTimestamp', [Number(end)])
      await f.rpc('evm_mine')
      await f.send(ctx.stack.factory, factoryV2Abi, 'transfer', [h.distributor, result.result.total])
      await f.send(h.distributor, epochDistributorAbi, 'setRoot', [
        epoch,
        tree.tree[0],
        result.result.total,
        dataHashOf(inputs),
      ])
      const position = () =>
        c.readContract({ address: h.vault, abi: stakeVaultAbi, functionName: 'positionOf', args: [account, account] })
      const before = await position()
      const index = tree.values.findIndex((entry) => entry.value[1] === account)
      const hash = await contributor.writeContract({
        address: h.distributor,
        abi: epochDistributorAbi,
        functionName: 'claim',
        args: [epoch, account, leaf.amount, proofOf(tree, index)],
      })
      expect((await c.waitForTransactionReceipt({ hash })).status).toBe('success')
      expect((await position()).shares).toBe(before.shares + leaf.amount)
    } finally {
      f.close()
    }
  },
  forkSetupTimeout() + 240_000,
)
