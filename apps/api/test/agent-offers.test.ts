import { DatabaseSync } from 'node:sqlite'
import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Test from 'alchemy/Test/Vitest'
import * as Effect from 'effect/Effect'
import { expect } from 'vitest'
import { type LocalAccount, erc20Abi, keccak256, stringToHex } from 'viem'
import * as sdk from '@sidequest/sdk'
import { AgentExecutor, AgentSigning, AgentStore, Board, BoardError, GrantStore, canonicalJson, fromNodeSqlite, type AgentPreparedCall, type AgentToolRequest } from '@sidequest/board'
import { forkEnabled, startSidequestFork } from '../../../packages/sdk/test/sidequest-fixture.ts'
import AgentOffersProbe from './agent-offers-worker.ts'

const { test, beforeAll, deploy } = Test.make({ providers: Cloudflare.providers(), state: Alchemy.localState(), dev: true })
const Stack = Alchemy.Stack('AgentOffersLocalTest', { providers: Cloudflare.providers(), state: Alchemy.localState() }, Effect.gen(function* () {
  const worker = yield* AgentOffersProbe
  return { url: worker.url }
}))
const stack = beforeAll(deploy(Stack))

async function publish(url: string, boardId: string, action: AgentPreparedCall, unavailable = false, readOnly = false) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ boardId, action, unavailable, readOnly }) })
  return response.json() as Promise<{ ok: boolean; runtime: string; manifest?: string; attribution?: { boardId: string; taskId: string } }>
}

test('managed offer publication verifies real workerd R2 and D1, resumes idempotently and refuses conflicts', Effect.gen(function* () {
  const { url } = yield* stack
  const manifest = canonicalJson({ title: `Offer ${crypto.randomUUID()}` })
  const action = { manifest, termsHash: keccak256(stringToHex(manifest)), taskId: crypto.randomUUID() }
  const result = yield* Effect.promise(() => publish(url!, 'original-board', action))
  expect(result).toMatchObject({ ok: true, runtime: 'Cloudflare-Workers', manifest, attribution: { boardId: 'original-board', taskId: action.taskId } })
  expect(yield* Effect.promise(() => publish(url!, 'original-board', action))).toEqual(result)
  expect(yield* Effect.promise(() => publish(url!, 'different-board', action))).toMatchObject({ ok: false })
  expect(yield* Effect.promise(() => publish(url!, 'original-board', { ...action, manifest: '{}' }))).toMatchObject({ ok: false })
  expect(yield* Effect.promise(() => publish(url!, 'original-board', action, true))).toMatchObject({ ok: false })
}))

test.skipIf(!forkEnabled)('an approval-completed hire has public terms before escrow and needs no MCP retry', Effect.gen(function* () {
  const { url } = yield* stack
  yield* Effect.promise(async () => {
    const fixture = await startSidequestFork()
    const database = new DatabaseSync(':memory:')
    const tenantDatabase = new DatabaseSync(':memory:')
    try {
      const ctx = { ...fixture.ctx, deployment: { ...fixture.ctx.deployment, relay: fixture.admin.account.address } }
      const now = Number((await ctx.publicClient.getBlock()).timestamp)
      const sql = fromNodeSqlite(database)
      const agents = new AgentStore(sql, () => now)
      const grants = new GrantStore(sql, ctx)
      const agent = fixture.contributor
      const operator = fixture.creator
      const token = ctx.deployment.rewardTokens[0]!
      const workerId = await sdk.registerAgent(ctx, fixture.worker, 'https://fixture.invalid/worker')
      for (const wallet of [agent, operator]) {
        const authorization = await wallet.signAuthorization({ contractAddress: ctx.deployment.delegation.delegator, executor: fixture.admin.account.address })
        await ctx.publicClient.waitForTransactionReceipt({ hash: await fixture.admin.sendTransaction({ to: wallet.account.address, data: '0x', authorizationList: [authorization] }) })
      }
      await fixture.send(token, [...erc20Abi, { type: 'function', name: 'mint', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' }], 'mint', [operator.account.address, 100_000_000n])
      agents.create({ id: 'publication-fixture', operator: operator.account.address, privyUserId: 'did:privy:fork-fixture', name: 'Publication fixture', registry: ctx.deployment.identity, chainId: ctx.deployment.chainId })
      agents.bindWallet('publication-fixture', 'fixture-wallet', agent.account.address)
      for (const state of ['upgraded', 'grants-live', 'registered', 'active'] as const) agents.advance('publication-fixture', state)
      const board = new Board(fromNodeSqlite(tenantDatabase), { network: 'monad-testnet', contexts: { main: ctx }, domain: 'fixture.invalid', uri: 'https://fixture.invalid', manifestBaseUrl: 'https://fixture.invalid/offers', now: () => now })
      const signing = new AgentSigning(sql, ctx, {
        signTypedData: (_id, data) => sdk.signTypedDataJson(agent, data),
        signAuthorization: (_id, contract, chainId, nonce) => agent.signAuthorization({ contractAddress: contract, chainId, nonce, executor: fixture.admin.account.address }),
      }, () => now)
      const prepareTool = async (request: AgentToolRequest): Promise<AgentPreparedCall> => {
        if (request.tool === 'report_transaction') {
          await board.reportTransaction(request.caller, request.args as never)
          return { reported: true }
        }
        if (request.tool !== 'create_task') throw new Error('Unexpected publication fixture tool')
        const prepared = await board.createTask(request.caller, request.args as never)
        const preparedAction = prepared as unknown as AgentPreparedCall
        return preparedAction
      }
      const sponsor = new (await import('@sidequest/board')).SponsorDesk({ sql, ctx, now: () => now,
        relay: { account: fixture.admin.account as LocalAccount, rpcUrl: fixture.url }, fail: (code, message) => new BoardError(code, message) })
      const boot = (verify = true) => new AgentExecutor({ sql, context: ctx, now: () => now, sponsor, signing, prepareTool,
        ...(verify ? { verifyAction: async (action: AgentPreparedCall) => {
          const publication = await publish(url!, 'original-board', action)
          if (!publication.ok) throw new Error('Native offer publication failed')
        } } : {}),
        verifyToolSigning: request => board.verifyAgentSigning(request.caller, request) })
      const input = { agentId: 'publication-fixture', boardId: 'original-board', operationKey: 'approval-hire', tool: 'create_task', args: {
        title: 'Approved publication fixture', brief: 'Fork proof only', acceptanceCriteria: [], token, reward: '1', creatorBond: '0', workerBond: '0',
        deliveryDeadline: now + 86400, mode: 'hire', invite: { agentId: workerId.toString() }, windows: { reviewSeconds: 3600, disputeSeconds: 3600, arbitrationSeconds: 43200 },
      } }
      const approval = await boot(false).execute(input)
      expect(approval.status).toBe('approval')
      const action = agents.step<AgentPreparedCall>(approval.operationId, 'action')!
      const missing = await publish(url!, 'original-board', action, false, true)
      expect(missing.manifest).toBeUndefined()
      expect(missing.attribution).toBeUndefined()
      const exact = grants.prepare(operator.account.address, { kind: 'allowance-once', delegator: operator.account.address, agent: agent.account.address, token, amount: 1_000_000n, salt: 1n, start: now })
      await grants.confirm(exact.hash, await sdk.signTypedDataJson(operator, exact.typedData))
      agents.decide(approval.operationId, operator.account.address, true, { allowanceHash: exact.hash })
      expect((await boot().execute(input)).status).toBe('confirmed')
      expect(agents.approval(approval.operationId).status).toBe('executed')
      expect((await board.getTask({}, { taskId: String(action.taskId) })).jobId).not.toBeNull()
      // Read the independent public storage after approval completion; no subsequent MCP/executor call.
      expect(await publish(url!, 'original-board', action, false, true)).toMatchObject({ ok: true, manifest: action.manifest, attribution: { boardId: 'original-board', taskId: action.taskId } })
      expect(database.prepare('SELECT count(*) count FROM sponsor_operations').get()).toEqual({ count: 1 })
    } finally {
      database.close()
      tenantDatabase.close()
      fixture.close()
    }
  })
}), { timeout: 240_000 })
