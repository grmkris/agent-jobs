import { Effect } from 'effect'
import { zeroAddress } from 'viem'
import { afterEach, expect, it, vi } from 'vitest'
import * as sdk from '@sidequest/sdk'
import { SPONSOR_OBJECT_NAME } from '@sidequest/board'
import type { AsyncSql, SqlValue } from '@sidequest/indexer'
import { directoryLive } from '../src/commons/directory-live.ts'

const wallet = '0x1111111111111111111111111111111111111111'
afterEach(() => vi.useRealTimers())
function fixture() {
  const base = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
  const multicall = vi.fn(async ({ contracts }: { contracts: readonly { args: readonly bigint[] }[] }) =>
    contracts.map(({ args }) => ({ status: 'success', result: args[0] === 9n ? zeroAddress : wallet })),
  )
  // SAFETY: this double returns the getAgentWallet multicall shape consumed by the directory adapter.
  const ctx = { ...base, publicClient: { ...base.publicClient, multicall } } as sdk.Ctx
  const managedProfiles = vi.fn(async () =>
    JSON.stringify([
      { agentId: '7', profile: { name: 'Ada' } },
      { agentId: '8', profile: { name: 'Duplicate' } },
    ]),
  )
  const getByName = vi.fn(() => ({ managedProfiles }))
  const queried = vi.fn()
  const all: AsyncSql['all'] = async <T>(query: string, ...params: SqlValue[]) => {
    queried(query, ...params)
    // SAFETY: the adapter queries these directory JSON columns in this unit fixture.
    return [
      { json: JSON.stringify({ agentId: '10', profile: { name: 'Duplicate' } }) },
      { json: JSON.stringify({ agentId: '11', profile: { name: 'Grace' } }) },
    ] as T[]
  }
  const directorySql: AsyncSql = { all, batch: async () => {} }
  const reader = directoryLive(directorySql, { getByName }, ctx, 'https://test.invalid')
  return { reader, multicall, getByName, managedProfiles, all: queried, ctx }
}

it('resolves unique hosted/directory names and agent ids; ambiguous names and zero wallets stay unresolved', async () => {
  const f = fixture()
  const tokens = ['Ada', 'Grace', 'Duplicate', '9', '12']
  expect(await Effect.runPromise(f.reader.resolve(tokens))).toEqual([
    { token: 'Ada', address: wallet },
    { token: 'Grace', address: wallet },
    { token: 'Duplicate', address: null },
    { token: '9', address: null },
    { token: '12', address: wallet },
  ])
  expect(f.getByName).toHaveBeenCalledWith(SPONSOR_OBJECT_NAME)
  expect(f.all).toHaveBeenCalledWith(
    expect.stringContaining('enrolled=1'),
    f.ctx.deployment.chainId,
    f.ctx.deployment.identity.toLowerCase(),
    'https://test.invalid',
  )
  expect(f.multicall).toHaveBeenCalledOnce()
})

it('caches for ten minutes and retries failed resolutions', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  const f = fixture()
  await Effect.runPromise(f.reader.resolve(['Ada']))
  await Effect.runPromise(f.reader.resolve(['ada']))
  expect(f.multicall).toHaveBeenCalledOnce()
  vi.setSystemTime(601001)
  f.multicall.mockRejectedValueOnce(new Error('offline'))
  expect(await Effect.runPromise(f.reader.resolve(['Ada']))).toEqual([{ token: 'Ada', address: null }])
  f.multicall.mockRejectedValueOnce(new Error('offline'))
  expect(await Effect.runPromise(f.reader.resolve(['13']))).toEqual([{ token: '13', address: null }])
  expect(await Effect.runPromise(f.reader.resolve(['13']))).toEqual([{ token: '13', address: wallet }])
  await Effect.runPromise(f.reader.resolve(['Ada']))
  expect(f.multicall).toHaveBeenCalledTimes(5)
})
