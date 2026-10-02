import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@agent-jobs/sdk'
import { parseEther } from 'viem'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { forkEnabled, startHirelingFork } from '../../sdk/test/hireling-fixture.ts'
import { tools } from '../../../apps/api/src/tools.ts'
import { Board } from './service.ts'
import { fromNodeSqlite } from './store.ts'

const fork = forkEnabled ? describe : describe.skip
fork('live hosted runner through the REST/MCP registry on a real local fork', () => {
  let f: Awaited<ReturnType<typeof startHirelingFork>>, board: Board, db: DatabaseSync, agentId: bigint
  beforeAll(async () => {
    f = await startHirelingFork(); db = new DatabaseSync(':memory:')
    const ctx = { ...f.ctx, deployment: { ...f.ctx.deployment, relay: f.admin.account.address } }
    f.ctx = ctx
    board = new Board(fromNodeSqlite(db), { network: 'monad-testnet', contexts: { main: ctx }, relay: { account: f.admin.account as import('viem').LocalAccount, rpcUrl: f.url },
      domain: 'fork.test', uri: 'https://fork.test', manifestBaseUrl: 'https://fork.test/offers', now: () => Math.floor(Date.now() / 1000) })
    agentId = await sdk.registerAgent(ctx, f.worker, 'https://hireling.xyz/hosted-live-runner')
    await sdk.stake(ctx, f.creator, parseEther('100')); await sdk.stake(ctx, f.worker, parseEther('100'))
  }, 180_000)
  afterAll(() => { db?.close(); f?.close() })
  for (const flow of ['direct-hire', 'quotes', 'budget-advance', 'budget-call'] as const) {
    it(`runs ${flow} through real registry tools and confirms its original operations`, async () => {
      const state: sdk.FlowState = { binding: 'fork', values: {}, sends: {} }
      const journal = new sdk.FlowJournal(f.ctx, state, () => undefined, () => undefined)
      await sdk.runV1HostedFlow({ ...f, relay: f.admin, journal, agentId, token: f.ctx.stack.factory, reward: parseEther('1'), bond: parseEther('10'),
        waitUntil: async () => undefined, log: () => undefined,
        call: async <T>(wallet: sdk.Wallet, name: string, input: Record<string, unknown>) => await tools[name]!.run(board, { address: wallet.account.address }, input, { network: 'monad-testnet', mcpSession: undefined }) as T }, flow)
      expect(state.values[`${flow}/done`]).toBe(true)
    }, 180_000)
  }
})
