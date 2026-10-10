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
import { stateContractsOf, stateHashOf, stateOf, type MiningState } from './state.ts'
import { prepareCheckpointReplay, readStateContext } from './checkpoint.ts'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
      const firstState = stateOf(
        replay.ledger,
        await readStateContext({
          c,
          epoch,
          chainId: 10143,
          reserve: h.miningReserve,
          deploymentBlock: historyStart,
          genesisBlock: historyStart,
          head: toBlock,
          delay,
          contracts: {
            holdings: [ctx.stack.holding],
            vault: h.vault,
            identity: ctx.deployment.identity,
            feeSchedule: h.feeSchedule,
            reserve: h.miningReserve,
            distributor: h.distributor,
          },
        }),
      )
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
        checkpoint: { previous: null, stateHash: stateHashOf(firstState) },
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
      await assertNextEpoch(f, { historyStart, delay, firstState, inputs, firstId })
    } finally {
      f.close()
    }
  },
  forkSetupTimeout() + 240_000,
)

async function assertNextEpoch(
  f: Fork,
  first: {
    historyStart: bigint
    delay: bigint
    firstState: MiningState
    inputs: ReturnType<typeof inputsV2Of>
    firstId: bigint
  },
) {
  const { ctx } = f,
    h = ctx.deployment.sidequest
  if (h === null) throw new Error('fork deployment missing')
  const c = ctx.publicClient,
    epoch = 2n,
    contracts = {
      holdings: [ctx.stack.holding],
      vault: h.vault,
      identity: ctx.deployment.identity,
      feeSchedule: h.feeSchedule,
      reserve: h.miningReserve,
      distributor: h.distributor,
    }
  const { start, end } = await epochWindowOf(c, h.miningReserve, epoch)
  const now = (await c.getBlock()).timestamp
  if (now < start) {
    await f.rpc('evm_setNextBlockTimestamp', [Number(start)])
    await f.rpc('evm_mine')
  }
  await paidJob(f, f.worker, first.firstId, 'v2-fork-checkpoint-next-epoch')
  await f.rpc('evm_setNextBlockTimestamp', [Number(end) - 1])
  await f.rpc('evm_mine')
  const head = await c.getBlockNumber({ cacheTime: 0 })
  const fromBlock = await firstBlockAtOrAfter(c, start, first.historyStart, head)
  const toBlock = head,
    lc = logClient(f.url),
    pager = { page: 1000n }
  const shareStart = start > first.delay ? start - first.delay : 0n
  const shareBlock = await firstBlockAtOrAfter(c, shareStart, first.historyStart, fromBlock)
  const dir = mkdtempSync(join(tmpdir(), 'credit-fork-checkpoint-'))
  try {
    writeFileSync(
      join(dir, 'epoch-1.json'),
      JSON.stringify({ rule: 2, chainId: 10143, epoch: '1', inputs: first.inputs, dataHash: dataHashOf(first.inputs) }),
    )
    writeFileSync(join(dir, 'state-1.json'), JSON.stringify(first.firstState))
    const stateContext = (candidate: bigint) =>
      readStateContext({
        c,
        epoch: candidate,
        chainId: 10143,
        reserve: h.miningReserve,
        deploymentBlock: first.historyStart,
        genesisBlock: first.historyStart,
        head,
        delay: first.delay,
        contracts,
      })
    const base = {
      epoch,
      fromEpoch: 1n,
      fromBlock,
      toBlock,
      genesisBlock: first.historyStart,
      chainId: 10143,
      rule: canonicalRuleV2(1n, first.delay, false, []),
      contracts: stateContractsOf(contracts),
      checkpointDir: dir,
      reader: {
        readRoot: (candidate: bigint) =>
          c.readContract({
            address: h.distributor,
            abi: epochDistributorAbi,
            functionName: 'rootOf',
            args: [candidate],
          }),
        blockHash: async (blockNumber: bigint) => (await c.getBlock({ blockNumber })).hash,
      },
      stateContext,
      readRecords: (from: bigint, to: bigint) =>
        readLedgerChain({
          c: lc,
          holdings: [ctx.stack.holding],
          vault: h.vault,
          identity: ctx.deployment.identity,
          feeSchedule: h.feeSchedule,
          reserve: h.miningReserve,
          fromBlock: from,
          toBlock: to,
          pager,
        }),
    }
    const incremental = await prepareCheckpointReplay(base)
    const genesis = await prepareCheckpointReplay({
      ...base,
      checkpointDir: '/no-fork-checkpoint-files',
      fromGenesis: true,
    })
    expect(incremental.previous).toEqual(genesis.previous)
    expect(incremental.previous?.stateHash).toBe(stateHashOf(first.firstState))
    const prices = {
      epoch,
      tokens: [{ token: lower(ctx.stack.factory), decimals: 18, usdPrice: parseEther('1') }],
      factoryUsdPrice: parseEther('1'),
    }
    const compute = (prepared: typeof incremental) => {
      const replay = replayEpochLedger(prepared.records, fromBlock, toBlock, prepared.ledger)
      const result = computeLedgerEpoch(replay, prices, parseEther('1000000'), shareBlock, fromBlock)
      return { replay, result }
    }
    const a = compute(incremental),
      b = compute(genesis)
    expect(a.result.result.total).toBeGreaterThan(0n)
    const nextStateContext = await stateContext(epoch)
    expect(JSON.stringify(stateOf(a.replay.ledger, nextStateContext))).toBe(
      JSON.stringify(stateOf(b.replay.ledger, nextStateContext)),
    )
    const canonical = (run: typeof a) =>
      inputsV2Of({
        chainId: 10143,
        epoch,
        rule: base.rule,
        window: {
          start: String(start),
          end: String(end),
          fromBlock: String(fromBlock),
          toBlock: String(toBlock),
          toBlockHash: nextStateContext.blockHash,
        },
        shareWindow: { start: String(shareStart), block: String(shareBlock) },
        holdings: [ctx.stack.holding],
        priceList: {
          message: {
            epoch: '2',
            tokens: prices.tokens.map((token) => ({ ...token, usdPrice: String(token.usdPrice) })),
            factoryUsdPrice: String(prices.factoryUsdPrice),
          },
        },
        factoryPriceEvidence: null,
        budget: { available: String(parseEther('1000000')) },
        feeSchedules: run.replay.end.feeSchedules,
        fees: run.result.result.fees,
        topUps: run.result.topUps,
        backing: run.result.stakes,
        backerShares: run.result.shares,
        backerPositions: run.result.result.backerPositions,
        checkpoint: {
          previous: incremental.previous,
          stateHash: stateHashOf(stateOf(run.replay.ledger, nextStateContext)),
        },
      })
    const inputs = canonical(a)
    expect(JSON.stringify(inputs)).toBe(JSON.stringify(canonical(b)))
    const tree = buildTree(leafValues(epoch, a.result.result.leaves))
    expect(JSON.stringify(tree)).toBe(JSON.stringify(buildTree(leafValues(epoch, b.result.result.leaves))))
    await f.rpc('evm_setNextBlockTimestamp', [Number(end)])
    await f.rpc('evm_mine')
    await f.send(ctx.stack.factory, factoryV2Abi, 'transfer', [h.distributor, a.result.result.total])
    await f.send(h.distributor, epochDistributorAbi, 'setRoot', [
      epoch,
      tree.tree[0],
      a.result.result.total,
      dataHashOf(inputs),
    ])
    const root = await c.readContract({
      address: h.distributor,
      abi: epochDistributorAbi,
      functionName: 'rootOf',
      args: [epoch],
    })
    expect(root.dataHash).toBe(dataHashOf(inputs))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
