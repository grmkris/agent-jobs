import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import { zeroAddress, type Address } from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Board } from './service.ts'
import { fromNodeSqlite } from './store.ts'
import { canonicalJson, termsHash, type OfferTerms } from './terms.ts'

vi.mock('@sidequest/sdk', async (original) => ({
  ...(await original<typeof sdk>()), getJob: vi.fn(), getListing: vi.fn(), sidequestState: vi.fn(), agentWallet: vi.fn(),
}))

const creator = '0x1111111111111111111111111111111111111111' as const
const worker = '0x2222222222222222222222222222222222222222' as const
const curator = '0x3333333333333333333333333333333333333333' as const
const databases: DatabaseSync[] = []
afterEach(() => { databases.splice(0).forEach((database) => database.close()); vi.clearAllMocks() })

function fixture() {
  // Use the current v1 pair for selections.
  const historical = sdk.deployment('monad-testnet')
  const base = { ...sdk.contextFor('monad-testnet', historical.stacks.main!, 'http://127.0.0.1:1'), deployment: historical }
  const verify = vi.fn(async () => true)
  const read = vi.fn(async ({ functionName }: { functionName: string }) => {
    if (functionName === 'selectionNonceUsed' || functionName === 'paused') return false
    throw new Error(`unexpected read ${functionName}`)
  })
  const ctx = { ...base, publicClient: { ...base.publicClient, verifyTypedData: verify, readContract: read } } as unknown as sdk.Ctx
  const database = new DatabaseSync(':memory:')
  databases.push(database)
  const sql = fromNodeSqlite(database)
  let now = 1_000
  const boot = () => new Board(sql, { network: 'monad-testnet', contexts: { main: ctx }, domain: 'fixture.test', uri: 'https://fixture.test', manifestBaseUrl: 'https://fixture.test/offers', now: () => now })
  const board = boot()
  const terms: OfferTerms = {
    v: 2, taskId: 'selection-fixture', projectId: null, policyVersion: null, mode: 'hire', title: 'Selection fixture', brief: 'Test only', acceptanceCriteria: [],
    deployment: { chainId: base.deployment.chainId, core: base.deployment.core, holding: base.stack.holding, evaluator: base.stack.evaluator, identity: base.deployment.identity },
    creator, approver: creator, arbitrator: base.deployment.arbitrator, token: base.deployment.rewardTokens[0]!, reward: 5n, creatorBond: 0n, workerBond: 0n,
    deliveryDeadline: 1_200, windows: { reviewSeconds: 100, disputeSeconds: 100, arbitrationSeconds: 100 }, eligibility: null, evidencePolicy: null, quote: null, salt: sdk.EMPTY_HASH,
  }
  const hash = termsHash(terms)
  sql.run('INSERT INTO tasks (id, creator, stack, terms_json, terms_hash, job_id, from_block, created_at, pool_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', terms.taskId, terms.creator, 'main', canonicalJson(terms), hash, '61', 0, 0, null)
  sql.run('INSERT INTO applications (id, task_id, worker, agent_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)', 'app-1', terms.taskId, worker, '7001', 'Test only', 0)
  sql.run('INSERT INTO selections (task_id, nonce, application_id, worker, agent_id, activate_by, signature, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', terms.taskId, '1', 'app-1', worker, '7001', 1_100, '0x1234', 10)
  vi.mocked(sdk.getJob).mockResolvedValue({ statusName: 'Open', provider: zeroAddress, submittedAt: 0 } as unknown as Awaited<ReturnType<typeof sdk.getJob>>)
  const listing = { creator, approver: creator, arbitrator: terms.arbitrator, token: terms.token, reward: terms.reward,
    creatorBond: 0n, workerBond: 0n, deliveryDeadline: terms.deliveryDeadline, policyHash: hash,
    reviewWindow: terms.windows.reviewSeconds, disputeWindow: terms.windows.disputeSeconds, arbitrationWindow: terms.windows.arbitrationSeconds,
    feeBps: 0, fee: 0n, bonus: 0n }
  vi.mocked(sdk.getListing).mockResolvedValue(listing as unknown as Awaited<ReturnType<typeof sdk.getListing>>)
  vi.mocked(sdk.sidequestState).mockResolvedValue({
    job: { statusName: 'Open', provider: zeroAddress, submittedAt: 0 }, listing,
    terms: { deliveryDeadline: terms.deliveryDeadline, funded: 0n }, decision: { outcome: 0, rejectedAt: 0, disputedAt: 0, violation: 0 },
    outcome: 'None', status: 'open', paused: false, deferredDecision: false, collectPending: false,
    reviewEndsAt: null, disputeEndsAt: null, arbitrationEndsAt: null,
  } as unknown as Awaited<ReturnType<typeof sdk.sidequestState>>)
  vi.mocked(sdk.agentWallet).mockResolvedValue(worker)
  const get = (address?: Address) => board.getTask(address === undefined ? {} : { address }, { taskId: terms.taskId })
  return { get, boot, sql, terms, read, verify, setNow: (value: number) => { now = value } }
}

describe('get_task creator selection authorization and persistence', () => {
  it('hydrates after a board restart without altering open chain state or exposing a signature/nonce', async () => {
    const context = fixture()
    const first = await context.get(creator)
    const refreshed = await context.boot().getTask({ address: creator }, { taskId: context.terms.taskId })
    expect(refreshed.selection).toEqual(first.selection)
    expect(refreshed.selection).toEqual([{ state: 'signed', applicationId: 'app-1', agentId: '7001', activateBy: 1_100 }])
    expect(refreshed.chain).toMatchObject({ status: 'open', provider: null })
    expect(refreshed.nextAction).toEqual({ actor: 'worker', action: 'activate', deadline: 1_100 })
    expect(context.read).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'selectionNonceUsed', args: [creator, 1n] }))
    expect(context.verify).toHaveBeenCalledWith(expect.objectContaining({ address: creator, primaryType: 'Selection', message: expect.objectContaining({ jobId: 61n }) }))
  })

  it.each([undefined, worker, curator])('omits creator selection data for unauthorized caller %s', async (address) => {
    const context = fixture()
    const task = await context.get(address)
    expect(task).not.toHaveProperty('selection')
    expect(task).not.toHaveProperty('selectionObservedAt')
    await context.boot().listTasks(address === undefined ? {} : { address }, {})
    expect(context.verify).not.toHaveBeenCalled()
    expect(context.read.mock.calls.some(([call]) => call.functionName === 'selectionNonceUsed')).toBe(false)
  })

  it('expires a persisted selection strictly after its cutoff', async () => {
    const context = fixture()
    context.setNow(1_101)
    expect((await context.get(creator)).selection?.[0]?.state).toBe('expired')
    expect(context.verify).not.toHaveBeenCalled()
  })

  it('rejects a revoked nonce, rotated wallet, and invalid current creator signature', async () => {
    const context = fixture()
    context.read.mockImplementation(async ({ functionName }) => functionName === 'selectionNonceUsed')
    expect((await context.get(creator)).selection?.[0]?.state).toBe('invalid')
    context.read.mockImplementation(async () => false)
    vi.mocked(sdk.agentWallet).mockResolvedValue(curator)
    expect((await context.get(creator)).selection?.[0]?.state).toBe('invalid')
    vi.mocked(sdk.agentWallet).mockResolvedValue(worker)
    context.verify.mockResolvedValue(false)
    expect((await context.get(creator)).selection?.[0]?.state).toBe('invalid')
  })

  it('fails closed when the persisted application identity changes', async () => {
    const context = fixture()
    context.sql.run("UPDATE applications SET agent_id = '7002' WHERE id = 'app-1'")
    expect((await context.get(creator)).selection?.[0]?.state).toBe('invalid')
  })

  it('does not claim valid or invalid when RPC signature validation is unavailable', async () => {
    const context = fixture()
    context.verify.mockRejectedValue(new Error('RPC down'))
    expect((await context.get(creator)).selection?.[0]?.state).toBe('unavailable')
  })
})
