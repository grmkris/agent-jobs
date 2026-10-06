/** A confirmed hosted publish that names its worker continues to select_worker under a derived key. */
import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@agent-jobs/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentExecutor, type AgentToolRequest } from './agent-executor.ts'
import type { AgentSigning } from './agent-signing.ts'
import type { SponsorDesk } from './sponsor.ts'
import { fromNodeSqlite } from './store.ts'

const operator = '0x1111111111111111111111111111111111111111' as const
const agentAddress = '0x2222222222222222222222222222222222222222' as const
const databases: DatabaseSync[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })

function fixture(selectWorker: () => Promise<Record<string, unknown>>) {
  const ctx = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
  const db = new DatabaseSync(':memory:'); databases.push(db)
  const sql = fromNodeSqlite(db)
  const calls: string[] = []
  const prepareTool = vi.fn(async (request: AgentToolRequest) => {
    calls.push(request.tool)
    if (request.tool === 'report_transaction') return { reported: true }
    if (request.tool === 'select_worker') return selectWorker()
    if (request.tool === 'submit_selection') return { taskId: request.args.taskId, selected: true }
    throw new Error(`unexpected tool ${request.tool}`)
  })
  const sponsor = { ready: async () => {}, submit: vi.fn(async () => ({ status: 'confirmed', txHash: `0x${'ab'.repeat(32)}` })) } as unknown as SponsorDesk
  const signing = { signTool: vi.fn(async (_agent: string, _operation: string, _typedData: string, verify: () => Promise<string>) => { await verify(); return `0x${'cd'.repeat(65)}` }) } as unknown as AgentSigning
  const executor = new AgentExecutor({ sql, now: () => 1000, context: ctx, sponsor, signing, prepareTool, verifyToolSigning: async () => 'ok' })
  executor.agents.create({ id: 'agent', operator, privyUserId: 'did:privy:test', name: 'agent', registry: ctx.deployment.identity, chainId: ctx.deployment.chainId })
  executor.agents.bindWallet('agent', 'wallet', agentAddress)
  for (const state of ['upgraded', 'grants-live', 'registered', 'active'] as const) executor.agents.advance('agent', state)
  /** A publish already sent through the relay: the retry path reaches #finish without grants or mapping. */
  const sent = (tool: 'create_task' | 'pick_quote', key: string, action: Record<string, unknown>) => {
    const operation = executor.agents.begin('agent', key, 'public', tool, { title: key })
    executor.agents.freezeStep(operation.id, 'action', { transactions: [{ to: operator, data: '0x', value: '0' }], ...action })
    sql.run("UPDATE agent_operations SET stage='sending', sponsor_operation_id=? WHERE id=?", 'sponsor-1', operation.id)
    return { agentId: 'agent', boardId: 'public', operationKey: key, tool, args: { title: key } }
  }
  return { executor, sent, calls, signing }
}

const typedData = JSON.stringify({ message: { nonce: '7' } })

it('selects the invited worker in the same call and resumes it on retry', async () => {
  const f = fixture(async () => ({ nonce: '7', sign: { typedData } }))
  const input = f.sent('create_task', 'hire-1', { taskId: 't1', applicationId: 'a1' })
  const result = await f.executor.execute(input)
  expect(result).toMatchObject({ status: 'confirmed', result: { taskId: 't1', applicationId: 'a1', selection: { status: 'confirmed', result: { taskId: 't1', selected: true } } } })
  expect(f.calls).toEqual(['report_transaction', 'select_worker', 'submit_selection'])
  expect(await f.executor.execute(input)).toEqual(result)
  // The derived key names the same frozen selection: no second Selection signature.
  const again = await f.executor.execute({ ...input, operationKey: 'hire-1-sel', tool: 'select_worker', args: { taskId: 't1', applicationId: 'a1' } })
  expect(again.operationId).toBe((result as { result: { selection: { operationId: string } } }).result.selection.operationId)
  expect(f.signing.signTool).toHaveBeenCalledTimes(1)
})

it('returns the confirmed publish with the selection to retry when selection fails, without its error text', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const f = fixture(async () => { throw new Error('request to https://rpc.example/v2/SECRETKEY failed') })
    const result = await f.executor.execute(f.sent('pick_quote', 'pick-1', { taskId: 't2', applicationId: 'a2' }))
    expect(result).toMatchObject({ status: 'confirmed', result: { taskId: 't2', selection: {
      status: 'failed', reason: 'internal', retry: 'same-key', next: { tool: 'select_worker', args: { taskId: 't2', applicationId: 'a2', operationKey: 'pick-1-sel' } },
    } } })
    expect(JSON.stringify(result)).not.toContain('SECRETKEY')
  } finally { spy.mockRestore() }
})

it('leaves a publish without a named worker unchanged', async () => {
  const f = fixture(async () => { throw new Error('not called') })
  const result = await f.executor.execute(f.sent('create_task', 'open-1', { taskId: 't3' }))
  expect(result).toMatchObject({ status: 'confirmed' })
  expect((result as { result: Record<string, unknown> }).result.selection).toBeUndefined()
  expect(f.calls).toEqual(['report_transaction'])
})
