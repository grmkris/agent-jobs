import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import { type Address, zeroAddress } from 'viem'
import { afterEach, expect, it, vi } from 'vitest'
import { Board } from './service.ts'
import { fromNodeSqlite } from './store.ts'

const creator = '0x1111111111111111111111111111111111111111' as const
const worker = '0x2222222222222222222222222222222222222222' as const
const approver = '0x3333333333333333333333333333333333333333' as const
const arbitrator = '0x4444444444444444444444444444444444444444' as const
const other = '0x5555555555555555555555555555555555555555' as const
const databases: DatabaseSync[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) db.close()
})

function fixture(invitedWallet: Address = worker) {
  const ctx = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
  const reads: Record<string, unknown> = {
    minimumCreatorBond: 10n ** 18n,
    unfilledForfeitBps: 2500,
    CANCEL_GRACE: 600,
    treasury: creator,
    UNSTAKE_DELAY: 259200,
    decimals: 0,
    symbol: 'mUSD',
    margin: 120,
    MIN_REVIEW_WINDOW: 120,
    MIN_DISPUTE_WINDOW: 120,
    MIN_ARBITRATION_WINDOW: 300,
  }
  const identity = { wallet: invitedWallet }
  const read = vi.fn(
    async ({ functionName, args }: { functionName: string; args?: readonly unknown[] | undefined }) => {
      if (functionName === 'getAgentWallet') return args?.[0] === 9n ? identity.wallet : other
      if (functionName in reads) return reads[functionName]
      if (functionName.startsWith('MAX_')) return sdk.MAX_SIDEQUEST_WINDOW
      throw new Error(`unexpected chain read: ${functionName}`)
    },
  )
  vi.spyOn(ctx.publicClient, 'readContract').mockImplementation(read)
  // SAFETY: offer-horizon validation reads only the block timestamp from this unit-test double.
  vi.spyOn(ctx.publicClient, 'getBlock').mockResolvedValue({ timestamp: 1000n } as Awaited<
    ReturnType<sdk.Ctx['publicClient']['getBlock']>
  >)
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const sql = fromNodeSqlite(db)
  const board = new Board(sql, {
    network: 'monad-testnet',
    contexts: { main: ctx },
    domain: 'invite.test',
    uri: 'https://invite.test',
    manifestBaseUrl: 'https://invite.test/offers',
    now: () => 1000,
  })
  const input = {
    title: 'Service request',
    brief: 'Public brief',
    acceptanceCriteria: ['works'],
    tokens: [ctx.deployment.rewardTokens[0]!],
    creatorBond: '1',
    deliveryDeadline: 200_000,
    quoteDeadline: 100_000,
    windows: { reviewSeconds: 120, disputeSeconds: 120, arbitrationSeconds: 300 },
    approver,
    arbitrator,
  }
  return { board, sql, input, identity, read }
}

it.each([zeroAddress, creator, approver, arbitrator])('refuses invited wallet %s before persisting', async (wallet) => {
  const f = fixture(wallet)
  await expect(
    f.board.requestQuotes({ address: creator }, { ...f.input, invite: { agentId: '9' }, idempotencyKey: 'invite' }),
  ).rejects.toMatchObject({
    code: 'invalid',
    message: 'the invited agent must have a registered wallet distinct from creator, approver and arbitrator',
  })
  expect(f.sql.all('SELECT * FROM quote_requests')).toEqual([])
  expect(f.sql.all('SELECT * FROM hosted_idempotency')).toEqual([])
})

it.each(['0', '01', '-1', '9x', '', (2n ** 256n).toString()])(
  'refuses invalid invited agent ID %s',
  async (agentId) => {
    const f = fixture()
    await expect(
      f.board.requestQuotes({ address: creator }, { ...f.input, invite: { agentId } }),
    ).rejects.toMatchObject({
      code: 'invalid',
      message: 'invite.agentId must be a nonzero uint256 decimal string',
    })
    expect(f.read.mock.calls.some(([call]) => call.functionName === 'getAgentWallet')).toBe(false)
  },
)

it('stores and returns the invite in preparation, public discovery, creator history and request detail', async () => {
  const f = fixture()
  const result = await f.board.requestQuotes({ address: creator }, { ...f.input, invite: { agentId: '9' } })
  const invite = { agentId: '9', wallet: worker }
  expect(result).toMatchObject({ invite })
  expect(f.sql.all('SELECT invited_agent, invited_wallet FROM quote_requests')).toEqual([
    { invited_agent: '9', invited_wallet: worker },
  ])
  expect(f.read.mock.calls.find(([call]) => call.functionName === 'getAgentWallet')?.[0]).toMatchObject({
    args: [9n],
  })
  for (const caller of [{}, { address: worker }, { address: other }]) {
    expect(await f.board.listQuoteRequests(caller)).toEqual([
      expect.objectContaining({ requestId: result.requestId, invite }),
    ])
  }
  expect(await f.board.listQuoteRequests({ address: creator }, { mine: true })).toMatchObject({
    requests: [expect.objectContaining({ invite })],
  })
  expect(await f.board.listQuotes({ address: worker }, { requestId: result.requestId })).toMatchObject({ invite })
  for (const [address, agentId] of [
    [worker, '9'],
    [other, '10'],
  ] as const) {
    await f.board.submitQuote(
      { address },
      { requestId: result.requestId, agentId, token: f.input.tokens[0]!, amount: '1' },
    )
  }
  expect(f.sql.all('SELECT worker FROM quotes')).toHaveLength(2)
  expect(f.sql.all('SELECT * FROM applications')).toEqual([])
  expect(f.sql.all('SELECT * FROM tasks')).toEqual([])
})

it('replays the original invite without resolving again after the registered wallet changes', async () => {
  const f = fixture()
  const input = { ...f.input, invite: { agentId: '9' }, idempotencyKey: 'invite' }
  const first = await f.board.requestQuotes({ address: creator }, input)
  f.identity.wallet = zeroAddress
  f.read.mockClear()
  expect(await f.board.requestQuotes({ address: creator }, input)).toEqual(first)
  expect(f.read).not.toHaveBeenCalled()
  expect(f.sql.all('SELECT * FROM quote_requests')).toHaveLength(1)
})

it('stores and returns null for a request with no invite', async () => {
  const f = fixture()
  const result = await f.board.requestQuotes({ address: creator }, f.input)
  expect(result.invite).toBeNull()
  expect(f.sql.all('SELECT invited_agent, invited_wallet FROM quote_requests')).toEqual([
    { invited_agent: null, invited_wallet: null },
  ])
  expect(await f.board.listQuoteRequests({})).toEqual([expect.objectContaining({ invite: null })])
  expect(await f.board.listQuotes({ address: creator }, { requestId: result.requestId })).toMatchObject({
    invite: null,
  })
})
