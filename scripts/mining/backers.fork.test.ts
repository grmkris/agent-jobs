import { expect, test } from 'bun:test'
import { forkEnabled, forkSetupTimeout, startSidequestFork } from '../../packages/sdk/test/sidequest-fixture.ts'
import {
  accept,
  activate,
  delegate,
  hashText,
  publish,
  registerAgent,
  settle,
  signSelection,
  submit,
} from '../../packages/sdk/src/actions.ts'
import { epochDistributorAbi } from '../../packages/sdk/src/abi/epochDistributor.ts'
import { stakeVaultAbi } from '../../packages/sdk/src/abi/stakeVault.ts'
import { BACKER_SHARE_KEY, backerInputs } from './backers.ts'
import { readBackerWorkers } from './backers-chain.ts'
import { epochWindowOf, holdingLogs } from './chain.ts'
import { computeEpoch, dataHashOf, leafValues } from './compute.ts'
import { buildTree, proofOf } from './tree.ts'
import { getAddress, parseAbi, parseEther, type Address } from './viem.ts'

// SAFETY: The wallet address is ABI-validated; case normalization preserves its address shape.
const lower = (address: Address) => address.toLowerCase() as Address
const identityAbi = parseAbi(['function setMetadata(uint256 agentId, string metadataKey, bytes metadataValue)'])

/** Coordinator-run only: real registry metadata, two backers, a paid job and a claim into the backer's own pool. */
test.skipIf(!forkEnabled)(
  'backer-share epoch claims increase the backer self-position on the local Monad fork',
  async () => {
    const f = await startSidequestFork()
    try {
      const { ctx, creator, worker, contributor, arbitrator } = f
      const h = ctx.deployment.sidequest
      if (h === null) throw new Error('fork deployment missing')
      const historyStart = await ctx.publicClient.getBlockNumber({ cacheTime: 0 })
      const agentId = await registerAgent(ctx, worker, 'https://sidequest.exchange/backer-mining-local-fork')
      await delegate(ctx, creator, parseEther('20'))
      await delegate(ctx, creator, parseEther('100'), worker.account.address)
      await delegate(ctx, contributor, parseEther('200'), worker.account.address)
      // The registering worker owns the real ERC-8004 agent, so it sets its own metadata.
      const metadataTx = await worker.writeContract({
        address: ctx.deployment.identity,
        abi: identityAbi,
        functionName: 'setMetadata',
        args: [agentId, BACKER_SHARE_KEY, `0x${5000n.toString(16).padStart(64, '0')}`],
      })
      expect((await ctx.publicClient.waitForTransactionReceipt({ hash: metadataTx })).status).toBe('success')
      const epoch = 1n
      const { start, end } = await epochWindowOf(ctx.publicClient, h.miningReserve, epoch)
      await f.rpc('evm_setNextBlockTimestamp', [Number(start)])
      await f.rpc('evm_mine')
      const fromBlock = await ctx.publicClient.getBlockNumber({ cacheTime: 0 })
      const now = Number(start)
      const terms = {
        creator: creator.account.address,
        approver: creator.account.address,
        token: ctx.stack.factory,
        reward: parseEther('100'),
        creatorBond: parseEther('10'),
        workerBond: 0n,
        arbitrator: arbitrator.account.address,
        reviewWindow: 120,
        disputeWindow: 120,
        arbitrationWindow: 300,
        deliveryDeadline: now + 600,
      }
      const termsHash = hashText('backer-share-fork')
      const { jobId } = await publish(ctx, creator, {
        ...terms,
        manifestHash: hashText('fixture'),
        termsHash,
      })
      const selection = { jobId, worker: worker.account.address, agentId, termsHash, activateBy: now + 300, nonce: 1n }
      await activate(ctx, worker, selection, await signSelection(ctx, creator, selection), terms)
      await submit(ctx, worker, jobId, hashText('finished'))
      await accept(ctx, creator, jobId)
      await settle(ctx, contributor, jobId)
      await f.rpc('evm_setNextBlockTimestamp', [Number(end) - 1])
      await f.rpc('evm_mine')
      const toBlock = await ctx.publicClient.getBlockNumber({ cacheTime: 0 })
      const logs = await holdingLogs(ctx.publicClient, [ctx.stack.holding], fromBlock, toBlock, 1000n)
      expect(logs.fees).toHaveLength(1)
      const backerWorkers = await readBackerWorkers({
        c: ctx.publicClient,
        identity: ctx.deployment.identity,
        vault: h.vault,
        holdings: [ctx.stack.holding],
        fees: logs.fees,
        deploymentBlock: historyStart,
        fromBlock,
        toBlock,
        page: 1000n,
      })
      expect(backerWorkers[0]?.bps).toBe(5000n)
      expect(backerWorkers[0]?.positions.filter((position) => position.weight > 0n)).toHaveLength(2)
      const result = computeEpoch({
        ...logs,
        backerWorkers,
        budget: parseEther('1000000'),
        prices: {
          epoch,
          tokens: [{ token: lower(ctx.stack.factory), decimals: 18, usdPrice: parseEther('1') }],
          factoryUsdPrice: parseEther('1'),
        },
      })
      const account = lower(contributor.account.address)
      const backerLeaf = result.leaves.find((leaf) => leaf.account === account)
      expect(backerLeaf?.amount).toBeGreaterThan(0n)
      if (backerLeaf === undefined) throw new Error('backer leaf missing')
      const tree = buildTree(leafValues(epoch, result.leaves))
      const index = tree.values.findIndex((entry) => entry.value[1] === account)
      const dataHash = dataHashOf({ chainId: 10143, epoch: epoch.toString(), ...backerInputs(backerWorkers) })
      await f.rpc('evm_setNextBlockTimestamp', [Number(end)])
      await f.rpc('evm_mine')
      // Fixture admin supplies only the leaf total; this rehearsal does not broadcast to the remote testnet.
      await f.send(ctx.stack.factory, parseAbi(['function transfer(address,uint256) returns (bool)']), 'transfer', [
        h.distributor,
        result.total,
      ])
      await f.send(h.distributor, epochDistributorAbi, 'setRoot', [epoch, tree.tree[0], result.total, dataHash])
      const position = () =>
        ctx.publicClient.readContract({
          address: h.vault,
          abi: stakeVaultAbi,
          functionName: 'positionOf',
          args: [getAddress(account), getAddress(account)],
        })
      const before = await position()
      const claim = await contributor.writeContract({
        address: h.distributor,
        abi: epochDistributorAbi,
        functionName: 'claim',
        args: [epoch, account, backerLeaf.amount, proofOf(tree, index)],
      })
      expect((await ctx.publicClient.waitForTransactionReceipt({ hash: claim })).status).toBe('success')
      expect((await position()).shares).toBe(before.shares + backerLeaf.amount)
    } finally {
      f.close()
    }
  },
  forkSetupTimeout() + 120_000,
)
