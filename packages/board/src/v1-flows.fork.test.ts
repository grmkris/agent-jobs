import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import { parseEther } from 'viem'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { forkEnabled, forkSetupTimeout, startSidequestFork } from '../../sdk/test/sidequest-fixture.ts'
import { tools } from '../../../apps/api/src/tools.ts'
import { Board } from './service.ts'
import { fromNodeSqlite } from './store.ts'

const fork = forkEnabled ? describe : describe.skip
fork('live hosted runner through the REST/MCP registry on a real local fork', () => {
  let f: Awaited<ReturnType<typeof startSidequestFork>>, board: Board, db: DatabaseSync, agentId: bigint
  const boot = () => new Board(fromNodeSqlite(db), { network: 'monad-testnet', contexts: { main: f.ctx }, relay: { account: f.admin.account as import('viem').LocalAccount, rpcUrl: f.url },
    domain: 'fork.test', uri: 'https://fork.test', manifestBaseUrl: 'https://fork.test/offers', now: () => Math.floor(Date.now() / 1000) })
  beforeAll(async () => {
    f = await startSidequestFork(); db = new DatabaseSync(':memory:')
    const ctx = { ...f.ctx, deployment: { ...f.ctx.deployment, relay: f.admin.account.address } }
    f.ctx = ctx
    board = boot()
    agentId = await sdk.registerAgent(ctx, f.worker, 'https://sidequest.exchange/hosted-live-runner')
    await sdk.delegate(ctx, f.creator, parseEther('100')); await sdk.delegate(ctx, f.worker, parseEther('100'))
  }, forkSetupTimeout())
  afterAll(() => { db?.close(); f?.close() })
  for (const lost of ['create_task', 'request_quotes', 'submit_quote', 'pick_quote'] as const) {
    it(`recovers a lost ${lost} response with the same remote IDs and no duplicate draft`, async () => {
      const flow = lost === 'create_task' ? 'direct-hire' : 'quotes'
      let durable: sdk.FlowState = { binding: `lost-${lost}`, values: {}, sends: {} }, interrupt = true
      let remote: { taskId?: string; requestId?: string; quoteId?: string; applicationId?: string } | undefined
      const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
      const before = { tasks: count('tasks'), requests: count('quote_requests'), applications: count('applications') }
      const deps = { ...f, relay: f.admin, agentId, token: f.ctx.stack.factory, reward: parseEther('1'), bond: parseEther('10'), waitUntil: async () => undefined, log: () => undefined,
        call: async <T>(wallet: sdk.Wallet, name: string, input: Record<string, unknown>) => {
          const result = await tools[name]!.run(board, { address: wallet.account.address }, input, { network: 'monad-testnet', mcpSession: undefined })
          if (interrupt && name === lost) { remote = result as typeof remote; throw new Error('response lost after remote commit') }
          if (name === lost && lost !== 'submit_quote') expect(result).toEqual(remote)
          return result as T
        } }
      const journal = () => new sdk.FlowJournal(f.ctx, sdk.parseFlowJson(sdk.flowJson(durable)), state => { durable = sdk.parseFlowJson(sdk.flowJson(state)) }, () => undefined)
      await expect(sdk.runV1HostedFlow({ ...deps, journal: journal() }, flow)).rejects.toThrow('response lost')
      expect(remote).toBeDefined()
      board = boot(); interrupt = false
      await sdk.runV1HostedFlow({ ...deps, journal: journal() }, flow)
      expect(durable.values[`${flow}/done`]).toBe(true)
      expect(count('tasks') - before.tasks).toBe(1)
      expect(count('applications') - before.applications).toBe(1)
      expect(count('quote_requests') - before.requests).toBe(flow === 'quotes' ? 1 : 0)
      if (lost === 'submit_quote') expect(db.prepare('SELECT id FROM quotes WHERE id=?').get(remote!.quoteId!)).toEqual({ id: remote!.quoteId })
    }, 180_000)
  }
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
