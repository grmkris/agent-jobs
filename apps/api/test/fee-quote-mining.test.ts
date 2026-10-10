import * as sdk from '@sidequest/sdk'
import { Board, fromNodeSqlite } from '@sidequest/board'
import { DatabaseSync } from 'node:sqlite'
import { tools } from '../src/tools.ts'
import { expect, it, vi } from 'vitest'
import { miningQuote } from '../src/fee-quote.ts'

it.each([
  [3000, 0, 4000, 40],
  [1000, 1, 6000, 60],
  [300, 2, 8000, 80],
  [100, 3, 10000, 100],
])('quotes the activation mining boost at fee rate %i', (feeBps, tier, boostBps, creditBps) => {
  expect(miningQuote(feeBps, [3000, 1000, 300, 100])).toEqual({ floorBps: 100, tier, boostBps, creditBps })
})
it('uses a changed live floor and integer rounding', () => {
  expect(miningQuote(1000, [3000, 1000, 300, 101])).toEqual({ floorBps: 101, tier: 1, boostBps: 6000, creditBps: 60 })
})
it.each([
  { bps: [3000, 1000, 300, 0] },
  { bps: [3000, 1000, 1000, 100] },
  { bps: [3000, 1000, 300] },
  { bps: [3000, 1000, 300, 0.5] },
])('refuses an invalid mining schedule $bps', ({ bps }) => {
  expect(() => miningQuote(3000, bps)).toThrow('mining fee schedule is invalid')
})
it('refuses a quote from a schedule that changed during the read', () => {
  expect(() => miningQuote(1000, [3000, 900, 300, 100])).toThrow('re-quote activation')
})

it('adds mining fields to the quoted worker without changing fee and net', async () => {
  const ctx = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
  const context = vi.spyOn(sdk, 'context').mockReturnValue(ctx)
  const schedule = vi.spyOn(ctx.publicClient, 'readContract').mockResolvedValue({
    thresholds: [0n, 10n, 100n, 1000n],
    bps: [3000, 1000, 300, 101],
    treasury: ctx.deployment.sidequest!.safe,
  })
  const db = new DatabaseSync(':memory:')
  const board = new Board(fromNodeSqlite(db), {
    network: 'monad-testnet',
    contexts: { main: ctx },
    domain: 'unit',
    uri: 'https://test.invalid',
    manifestBaseUrl: '',
  })
  const feeQuote = vi.spyOn(board, 'feeQuote').mockResolvedValue({ feeBps: 1000, fee: '100', net: '900' })
  try {
    const worker = ctx.deployment.relay
    const toolContext = { network: 'monad-testnet' as const, mcpSession: undefined, rpcUrl: 'http://127.0.0.1:1' }
    expect(await tools.fee_quote!.run(board, {}, { taskId: 'task-7', worker }, toolContext)).toEqual({
      feeBps: 1000,
      fee: '100',
      net: '900',
      mining: { floorBps: 101, tier: 1, boostBps: 6000, creditBps: 60 },
    })
    expect(feeQuote).toHaveBeenCalledWith({}, { taskId: 'task-7', worker })
    expect(schedule).toHaveBeenCalledWith(
      expect.objectContaining({ address: ctx.deployment.sidequest!.feeSchedule, functionName: 'schedule' }),
    )
  } finally {
    schedule.mockRestore()
    context.mockRestore()
    db.close()
  }
})
