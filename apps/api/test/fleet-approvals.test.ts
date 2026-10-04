import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { createManagedAgent, listApprovals, migrateFleet, type FleetSql } from '@agent-jobs/board'
import { fleetRoute } from '../src/fleet-routes.ts'
import { queueToolApproval } from '../src/mcp-fleet.ts'

const owner = '0x0000000000000000000000000000000000000001'
const wallet = '0x0000000000000000000000000000000000000002'
async function setup() {
  const db = new DatabaseSync(':memory:')
  const sql: FleetSql = {
    all: async <T>(query: string, ...params: (string | number | null)[]) => db.prepare(query).all(...params) as T[],
    batch: async statements => { db.exec('BEGIN'); try { for (const s of statements) db.prepare(s.query).run(...s.params); db.exec('COMMIT') } catch (e) { db.exec('ROLLBACK'); throw e } },
  }
  await migrateFleet(sql)
  const agent = await createManagedAgent(sql, { owner, name: 'Approvals worker', walletAddress: wallet, now: 100 })
  const input = { sql, owner, agentId: agent.id, tool: 'select_worker', args: { taskId: 'task-1', applicationId: 'app-1' }, result: { nonce: '7', sign: { typedData: '{}' } }, now: 100, chainId: 10143, network: 'monad-testnet', boardId: 'public', walletAddress: wallet }
  const queued = (await queueToolApproval(input))!
  const runTool = vi.fn(async () => ({ ok: true as const, result: { worker: wallet } }))
  const route = (path: string, body: Record<string, unknown>, now = 101, actor = owner) => fleetRoute({ sql, method: 'POST', path, body, origin: 'https://hireling.test', owner: actor, now, network: 'monad-testnet', rpcUrl: 'http://127.0.0.1:1', appId: '', runTool })
  return { db, sql, input, queued, route, runTool }
}

describe('frozen approval execution', () => {
  it('preserves decided and expired statuses on idempotent MCP retries', async () => {
    const f = await setup()
    expect(await queueToolApproval(f.input)).toEqual(f.queued)
    await f.route(`/api/approvals/${f.queued.approvalId}/approve`, { decision: 'reject' })
    expect(await queueToolApproval({ ...f.input, now: 102 })).toMatchObject({ approvalId: f.queued.approvalId, status: 'rejected' })
    const fresh = { ...f.input, args: { taskId: 'task-2' }, now: 102 }
    const second = (await queueToolApproval(fresh))!
    expect(await queueToolApproval({ ...fresh, now: 702 })).toMatchObject({ approvalId: second.approvalId, status: 'expired' })
    expect((await f.sql.all('SELECT * FROM agent_approvals')).length).toBe(2)
    f.db.close()
  })

  it('requires owner approval, the exact hash, and one durable execution claim', async () => {
    const f = await setup(), base = `/api/approvals/${f.queued.approvalId}`
    const approval = (await listApprovals(f.sql, owner, 101))[0]!
    expect((await f.route(`${base}/claim`, { actionHash: approval.payload.actionHash }))?.status).toBe(403)
    expect((await f.route(`${base}/approve`, { decision: 'approve' }, 101, wallet))?.status).toBe(404)
    await f.route(`${base}/approve`, { decision: 'approve' })
    expect((await f.route(`${base}/claim`, { actionHash: 'changed' }))?.status).toBe(403)
    const claim = await f.route(`${base}/claim`, { actionHash: approval.payload.actionHash })
    const claimId = (claim!.body as { result: { claimId: string } }).result.claimId
    expect((await f.route(`${base}/claim`, { actionHash: approval.payload.actionHash }))?.status).toBe(409)
    expect((await f.route(`${base}/claim`, { actionHash: approval.payload.actionHash, claimId }))?.status).toBe(200)
    expect((await f.route(`${base}/continue`, { claimId: 'another-device', signature: '0xab' }))?.status).toBe(403)
    expect(f.runTool).not.toHaveBeenCalled()
    f.db.close()
  })

  it('continues only the frozen selection once and completes after its verified continuation', async () => {
    const f = await setup(), base = `/api/approvals/${f.queued.approvalId}`
    await f.route(`${base}/approve`, { decision: 'approve' })
    const approval = (await listApprovals(f.sql, owner, 101))[0]!
    const claim = await f.route(`${base}/claim`, { actionHash: approval.payload.actionHash })
    const claimId = (claim!.body as { result: { claimId: string } }).result.claimId
    expect((await f.route(`${base}/complete`, { claimId, transactionHashes: [] }))?.status).toBe(400)
    expect((await f.route(`${base}/continue`, { claimId, signature: '0xab', taskId: 'injected' }))?.status).toBe(200)
    expect(f.runTool).toHaveBeenCalledExactlyOnceWith('submit_selection', { taskId: 'task-1', nonce: '7', signature: '0xab' }, wallet, 'public')
    expect((await f.route(`${base}/continue`, { claimId, signature: '0xcd' }))?.status).toBe(200)
    expect(f.runTool).toHaveBeenCalledTimes(1)
    expect((await f.route(`${base}/complete`, { claimId, transactionHashes: [] }))?.status).toBe(200)
    expect((await listApprovals(f.sql, owner, 102))[0]?.execution).toEqual({ state: 'completed', transactionHashes: [] })
    f.db.close()
  })
})
