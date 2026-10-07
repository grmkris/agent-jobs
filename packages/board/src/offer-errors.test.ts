/** An RPC failure while preparing an offer is not a refusal: its text names the provider URL and never reaches a reply. */
import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { agentFailureReply } from './agent-failure.ts'
import { BoardError } from './board-error.ts'
import { Board } from './service.ts'
import { fromNodeSqlite } from './store.ts'

const creator = '0x1111111111111111111111111111111111111111' as const
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function fixture(failBounds: boolean) {
  const base = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
  const read = vi.fn(async ({ functionName }: { functionName: string }) => {
    if (functionName === 'paused') return false
    if (functionName === 'decimals') return 0
    if (functionName === 'symbol') return 'mUSD'
    if (failBounds && functionName.startsWith('MIN_')) {
      throw Object.assign(
        new Error(
          'HTTP request failed.\n\nURL: https://monad.example/v2/SECRETKEY\nRequest body: {"apiKey":"short-secret"}',
        ),
        { name: 'HttpRequestError', status: 401 },
      )
    }
    if (functionName === 'MIN_REVIEW_WINDOW' || functionName === 'MIN_DISPUTE_WINDOW') return 120
    if (functionName === 'MIN_ARBITRATION_WINDOW') return 300
    if (functionName.startsWith('MAX_')) return sdk.MAX_SIDEQUEST_WINDOW
    throw new Error(`unexpected chain read: ${functionName}`)
  })
  const client = { ...base.publicClient, readContract: read, getBlockNumber: vi.fn(async () => 100n) }
  const ctx = { ...base, stack: { ...base.stack, kind: 'sidequest-v1' }, publicClient: client } as unknown as sdk.Ctx
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const board = new Board(fromNodeSqlite(db), {
    network: 'monad-testnet',
    contexts: { main: ctx },
    domain: 'offer.test',
    uri: 'https://offer.test',
    manifestBaseUrl: 'https://offer.test/offers',
    now: () => 1000,
  })
  const input = {
    title: 'Offer',
    brief: 'Brief',
    acceptanceCriteria: ['works'],
    token: base.deployment.rewardTokens[0]!,
    reward: '1',
    creatorBond: '0',
    workerBond: '0',
    deliveryDeadline: 200_000,
    windows: { reviewSeconds: 120, disputeSeconds: 120, arbitrationSeconds: 300 },
    arbitrator: '0x4444444444444444444444444444444444444444',
  }
  return { board, input, read }
}

it('create_task and request_quotes pass a failed bounds read to the boundary, not as a trusted refusal', async () => {
  const f = fixture(true)
  const failures = [
    await f.board.createTask({ address: creator }, f.input).catch((error: unknown) => error),
    await f.board
      .requestQuotes({ address: creator }, { ...f.input, tokens: [f.input.token], quoteDeadline: 100_000 })
      .catch((error: unknown) => error),
  ]
  expect(f.read.mock.calls.some(([call]) => call.functionName.startsWith('MIN_'))).toBe(true)
  for (const failure of failures) {
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(BoardError)
    const reply = agentFailureReply(failure, 'The board could not complete this call', vi.fn(), 'error')
    expect(reply).toMatchObject({ code: 'error', reason: 'internal', retry: 'same-key' })
    expect(JSON.stringify(reply)).not.toMatch(/SECRETKEY|monad\.example|short-secret|HTTP request/)
  }
})

it('a local validation failure is still an invalid refusal with its own text', async () => {
  const f = fixture(false)
  await expect(
    f.board.createTask(
      { address: creator },
      { ...f.input, windows: { reviewSeconds: 1, disputeSeconds: 120, arbitrationSeconds: 300 } },
    ),
  ).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('window') })
})
