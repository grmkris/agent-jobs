import { type Address, type Hex, type TransactionReceipt, encodeAbiParameters, encodeEventTopics } from 'viem'
import { expect, it, vi } from 'vitest'
import { sidequestHoldingAbi } from './abi/index.ts'
import { type Ctx } from './actions.ts'
import { context } from './client.ts'
import { bondBurnExpectation, bondSettlementEvent } from './sidequest.ts'

const holding: Address = '0x1111111111111111111111111111111111111111'
function receipt(burned: boolean, side = 1, jobId = 7n, address = holding): TransactionReceipt {
  const eventName = burned ? 'BondSlashed' : 'BondReleased'
  const args = { jobId, side, account: holding, amount: 10n }
  const blockHash = `0x${'1'.repeat(64)}` as const
  const transactionHash = `0x${'2'.repeat(64)}` as const
  // SAFETY: both indexed fields are supplied scalars, so viem emits only concrete hex topics.
  const topics = encodeEventTopics({ abi: sidequestHoldingAbi, eventName, args }) as [Hex, ...Hex[]]
  return {
    status: 'success',
    blockHash,
    transactionHash,
    blockNumber: 1n,
    transactionIndex: 0,
    from: holding,
    to: holding,
    contractAddress: null,
    cumulativeGasUsed: 0n,
    effectiveGasPrice: 0n,
    gasUsed: 0n,
    logsBloom: '0x',
    type: 'eip1559',
    logs: [
      {
        address,
        blockHash,
        transactionHash,
        blockNumber: 1n,
        transactionIndex: 0,
        logIndex: 0,
        removed: false,
        topics,
        data: encodeAbiParameters([{ type: 'uint8' }, { type: 'uint256' }], [side, 10n]),
      },
    ],
  }
}

function settlementContext(timestamp: bigint) {
  const base = context('monad-testnet', 'main', 'http://127.0.0.1:1')
  // SAFETY: the reader uses only timestamp from this original settlement block; all other client methods stay intact.
  const block = { timestamp } as Awaited<ReturnType<Ctx['publicClient']['getBlock']>>
  const getBlock = vi.fn<Ctx['publicClient']['getBlock']>().mockResolvedValue(block)
  // SAFETY: this mock preserves the public client method signature and only replaces the block timestamp read.
  const client = { ...base.publicClient, getBlock: getBlock as Ctx['publicClient']['getBlock'] }
  const ctx: Ctx = { ...base, stack: { ...base.stack, holding }, publicClient: client }
  return { ctx, getBlock }
}

it('binds actual bond release or slash evidence to Holding, job and side', () => {
  const r = receipt(false)
  expect(bondSettlementEvent([r], holding, 7n, 1)?.burned).toBe(false)
  expect(bondSettlementEvent([receipt(true)], holding, 7n, 1)?.burned).toBe(true)
  expect(bondSettlementEvent([r], holding, 8n, 1)).toBeNull()
  expect(bondSettlementEvent([r], holding, 7n, 0)).toBeNull()
  expect(
    bondSettlementEvent([receipt(true, 1, 7n, '0x2222222222222222222222222222222222222222')], holding, 7n, 1),
  ).toBeNull()
  expect(() => bondSettlementEvent([r, receipt(true)], holding, 7n, 1)).toThrow('Multiple')
  expect(() => bondSettlementEvent([{ ...r, status: 'reverted' }], holding, 7n, 1)).toThrow('successful')
})

it.each([999n, 1000n, 1001n])('uses the original settlement block %s across late resumes', async (timestamp) => {
  const r = receipt(timestamp < 1000n)
  const { ctx, getBlock } = settlementContext(timestamp)
  expect(await bondBurnExpectation(ctx, [r], 7n, { side: 1, penalty: true, expiredAt: 1000 })).toBe(timestamp < 1000n)
  expect(getBlock).toHaveBeenCalledWith({ blockHash: r.blockHash })
  await expect(
    bondBurnExpectation(ctx, [receipt(timestamp >= 1000n)], 7n, { side: 1, penalty: true, expiredAt: 1000 }),
  ).rejects.toThrow('disagrees')
})

it('does not invent a burn for a non-penalty outcome or missing receipt', async () => {
  const { ctx } = settlementContext(999n)
  expect(await bondBurnExpectation(ctx, [receipt(false)], 7n, { side: 1, penalty: false, expiredAt: 1000 })).toBe(false)
  await expect(bondBurnExpectation(ctx, [], 7n, { side: 1, penalty: true, expiredAt: 1000 })).rejects.toThrow('Missing')
})
