import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@agent-jobs/sdk'
import { type Address, type Hex, encodeFunctionData, erc20Abi, keccak256, parseTransaction } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type TxRequest } from './api.ts'
import { type SponsorCall, type SponsorOperation, type SponsorPrep, type SponsorStatus, readDelegation, sponsorKey, sponsorRulesFor, sponsorable, submitFailure } from './sponsor.ts'

/**
 * The board's real sponsorship desk (B6, read-only here): what Explore reads must be exactly what it produces. Loaded
 * by path, so Explore's typecheck does not compile the board's sources; this interface is the contract Explore uses,
 * and the assertions below check the desk keeps to it.
 */
interface Desk {
  status(wallet: string): Promise<SponsorStatus>
  prepare(wallet: string): Promise<SponsorPrep>
  confirm(wallet: string, signature: string): Promise<SponsorStatus>
  revoke(wallet: string): Promise<{ transactions: TxRequest[] }>
  submit(wallet: string, entries: Array<{ grant: Hex; calls: SponsorCall[] }>, key: string): Promise<SponsorOperation>
}
const boardSrc = (file: string) => new URL(`../../../packages/board/src/${file}`, import.meta.url).href
const { SponsorDesk } = (await import(/* @vite-ignore */ boardSrc('sponsor.ts'))) as { SponsorDesk: new (deps: unknown) => Desk }
const { fromNodeSqlite } = (await import(/* @vite-ignore */ boardSrc('store.ts'))) as { fromNodeSqlite: (db: DatabaseSync) => unknown }

// The API turns a desk failure into { ok:false, code, message, reason? } (apps/api/src/board.ts); the client into ApiError.
const fail = (code: string, message: string) => Object.assign(new Error(message), { code })
async function asClientError(p: Promise<unknown>): Promise<ApiError> {
  const e = (await p.then(() => null, (x: unknown) => x)) as { code?: string; message: string; reason?: string } | null
  if (e === null) throw new Error('expected a refusal')
  return new ApiError(e.code ?? 'error', e.message, e.reason)
}

const dbs: DatabaseSync[] = []
afterEach(() => dbs.splice(0).forEach((db) => db.close()))
const addr = (n: string) => `0x${n.repeat(40)}` as Address

/** A SponsorDesk on testnet's deployment with Hireling contracts at fixed addresses and a stubbed chain, as B6's own tests. */
function board() {
  const owner = privateKeyToAccount(generatePrivateKey())
  const relay = privateKeyToAccount(generatePrivateKey())
  const base = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
  const stack: sdk.Stack = { ...base.stack, kind: 'hireling-v1', holding: addr('1'), evaluator: addr('2') }
  const hireling = { block: 0n, factory: stack.factory, safe: addr('4'), vault: addr('3'), feeSchedule: addr('5'), distributor: addr('6'), miningReserve: addr('7'), teamVesting: addr('8'), t0: 1 }
  const deployment = { ...base.deployment, relay: relay.address, stacks: { main: stack }, hireling }
  const db = new DatabaseSync(':memory:')
  dbs.push(db)
  let used = 0n
  let nonce = 0
  let balance = 100n * 10n ** 18n
  const receipts = new Map<string, Record<string, unknown>>()
  // Unknown hashes answer undefined, the same branch as the board's TransactionReceiptNotFoundError (whose class is
  // the board's own viem instance, not this test's).
  const receipt = async ({ hash }: { hash: Hex }) => receipts.get(hash)
  const client = {
    ...base.publicClient,
    getCode: vi.fn(async () => `0xef0100${deployment.delegation.delegator.slice(2)}`),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => (functionName === 'callCounts' ? used : false)),
    getTransactionReceipt: vi.fn(receipt),
    waitForTransactionReceipt: vi.fn(receipt),
    getBlock: vi.fn(async () => ({ timestamp: 1_800_000_000n, baseFeePerGas: 100_000_000_000n })),
    getTransactionCount: vi.fn(async () => nonce),
    getBalance: vi.fn(async () => balance),
    estimateGas: vi.fn(async () => 100_000n),
    call: vi.fn(async () => ({ data: '0x' })),
    getGasPrice: vi.fn(async () => 102_000_000_000n),
    estimateMaxPriorityFeePerGas: vi.fn(async () => 2_000_000_000n),
    sendRawTransaction: vi.fn(async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      const hash = keccak256(serializedTransaction)
      used += 1n
      nonce += 1
      receipts.set(hash, { transactionHash: hash, status: 'success', blockNumber: 5n, gasUsed: 100_000n, effectiveGasPrice: 102_000_000_000n })
      return hash
    }),
  }
  const ctx = { ...base, deployment, stack, publicClient: client } as unknown as sdk.Ctx
  const desk = new SponsorDesk({ sql: fromNodeSqlite(db), ctx, relay: { account: relay, rpcUrl: 'http://127.0.0.1:1' }, now: () => 1_800_000_000, fail })
  const sign = (typedData: string) => sdk.signTypedDataJson({ account: owner, signTypedData: (args: Parameters<typeof owner.signTypedData>[0]) => owner.signTypedData(args) } as never, typedData)
  const rules = sponsorRulesFor({ holding: stack.holding, evaluator: stack.evaluator, vault: hireling.vault }, deployment)
  const tx = (to: Address, data: Hex): TxRequest => ({ description: 'step', chainId: deployment.chainId, to, data, value: '0' })
  return { desk, owner, relay, stack, hireling, deployment, rules, sign, tx, client, setBalance: (n: bigint) => (balance = n) }
}

describe('Explore against the board’s real sponsorship desk', () => {
  it('reads the delegation sponsor_prepare hands out, and its D15 policy', async () => {
    const b = board()
    const prep = await b.desk.prepare(b.owner.address)
    expect(prep).toMatchObject({ sign: { typedData: expect.any(String) }, upgrade: null })
    const read = readDelegation(prep.sign.typedData, b.owner.address, b.rules)
    expect(read).toMatchObject({ ok: true })
    if (!read.ok) return
    expect(read.policy.targets.map((t) => t.name)).toEqual(['Holding', 'Evaluator', 'Stake vault', 'Core', 'Delegation manager'])
    expect(read.policy.calls).toBe(100n)
    expect(read.policy.validUntil).toBe(1_800_000_000 + 86_400)
    const names = read.policy.methods.map((m) => m.name)
    for (const allowed of ['activate', 'settle', 'claimTopUpRefund', 'accept', 'retryDeferred', 'cancelUndelegate', 'withdraw']) expect(names).toContain(allowed)
    for (const excluded of ['topUp', 'publish', 'delegate', 'requestUndelegate', 'setHoldingDenied', 'rule']) expect(names).not.toContain(excluded)
    // Another wallet's page refuses it; so does one expecting another relay.
    expect(readDelegation(prep.sign.typedData, b.relay.address, b.rules)).toMatchObject({ ok: false })
    expect(readDelegation(prep.sign.typedData, b.owner.address, { ...b.rules, relay: addr('9') })).toMatchObject({ ok: false })
  })

  it('confirms with the wallet’s signature, and sponsor_status reads back as live in Explore’s shape', async () => {
    const b = board()
    expect(await b.desk.status(b.owner.address)).toEqual({ status: 'none', typedData: null, delegationHash: null, callsUsed: 0 })
    const prep = await b.desk.prepare(b.owner.address)
    const status = await b.desk.confirm(b.owner.address, await b.sign(prep.sign.typedData))
    expect(status).toEqual({ status: 'live', typedData: expect.any(String), delegationHash: expect.any(String), callsUsed: 0 })
    const read = readDelegation(status.typedData as string, b.owner.address, b.rules)
    expect(read).toMatchObject({ ok: true })
    if (!read.ok) return
    const live = { policy: read.policy, callsUsed: status.callsUsed }
    const settle = b.tx(b.stack.holding, encodeFunctionData({ abi: sdk.hirelingHoldingAbi, functionName: 'settle', args: [1n] }))
    const topUp = b.tx(b.stack.holding, encodeFunctionData({ abi: sdk.hirelingHoldingAbi, functionName: 'topUp', args: [1n, 1n] }))
    const approve = b.tx(b.deployment.rewardTokens[0] as Address, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [b.stack.holding, 1n] }))
    expect(sponsorable([settle], live, b.deployment.chainId, 1_800_000_000)).toBe(true)
    expect(sponsorable([topUp], live, b.deployment.chainId, 1_800_000_000)).toBe(false)
    expect(sponsorable([approve, settle], live, b.deployment.chainId, 1_800_000_000)).toBe(false)
  })

  it('sends with Explore’s key and calls, returns one operation per key, and maps refusals the way TxSteps acts on them', async () => {
    const b = board()
    const prep = await b.desk.prepare(b.owner.address)
    await b.desk.confirm(b.owner.address, await b.sign(prep.sign.typedData))
    const call = { to: b.stack.holding, data: encodeFunctionData({ abi: sdk.hirelingHoldingAbi, functionName: 'settle', args: [1n] }), value: '0' as const }
    const grant = (await b.desk.status(b.owner.address)).delegationHash!
    const key = sponsorKey()
    const op = await b.desk.submit(b.owner.address, [{ grant, calls: [call] }], key)
    expect(op).toEqual({ operationId: expect.stringMatching(/^0x[0-9a-f]{64}$/), status: 'confirmed', txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/), callsUsed: 1 })
    const sent = b.client.sendRawTransaction.mock.calls.at(0)?.[0]
    if (sent === undefined) throw new Error('sponsorship did not send a transaction')
    const signed = parseTransaction(sent.serializedTransaction)
    expect(signed.maxPriorityFeePerGas).toBe(2_000_000_000n)
    expect(signed.maxPriorityFeePerGas).toBeLessThan(await b.client.getGasPrice())
    expect(signed.maxFeePerGas).toBe(2n * (await b.client.getBlock()).baseFeePerGas)
    // A retry after a lost answer: same key, same operation, nothing new sent.
    expect(await b.desk.submit(b.owner.address, [{ grant, calls: [call] }], key)).toEqual(op)
    // The same calls as a new action, with a new key, go again.
    expect((await b.desk.submit(b.owner.address, [{ grant, calls: [call] }], sponsorKey())).operationId).not.toBe(op.operationId)

    const outside = { to: b.deployment.rewardTokens[0] as string, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [b.stack.holding, 1n] }), value: '0' as const }
    expect(submitFailure(await asClientError(b.desk.submit(b.owner.address, [{ grant, calls: [outside] }], sponsorKey())))).toMatchObject({ kind: 'wallet' })
    b.setBalance(0n)
    const floor = await asClientError(b.desk.submit(b.owner.address, [{ grant, calls: [call] }], sponsorKey()))
    expect(floor.reason).toBe('floor')
    expect(submitFailure(floor)).toMatchObject({ kind: 'wallet', why: expect.stringMatching(/low on gas money/) })
  })

  it('revokes with the transactions shape Explore sends', async () => {
    const b = board()
    const prep = await b.desk.prepare(b.owner.address)
    await b.desk.confirm(b.owner.address, await b.sign(prep.sign.typedData))
    const r = await b.desk.revoke(b.owner.address)
    expect(r.transactions).toHaveLength(1)
    expect(r.transactions[0]).toMatchObject({ chainId: b.deployment.chainId, to: b.deployment.delegation.manager, value: '0' })
    expect((await b.desk.status(b.owner.address)).status).toBe('revoked')
  })
})
