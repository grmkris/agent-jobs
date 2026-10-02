import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@agent-jobs/sdk'
import { type Address, type Hex, TransactionReceiptNotFoundError, decodeFunctionData, encodeFunctionData, keccak256, parseTransaction, size } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Board, BoardError } from './service.ts'
import { SPONSOR_LIMITS, SponsorDesk } from './sponsor.ts'
import { fromNodeSqlite } from './store.ts'
import { delegationManagerAbi } from './delegation.ts'
import { admissionFailure, hostedToolNames, parseHostedAdmission, readOnlyHostedTools } from './admission.ts'

const dbs: DatabaseSync[] = []
afterEach(() => dbs.splice(0).forEach(db => db.close()))
const addr = (n: string) => `0x${n.repeat(40)}` as Address
function fixture() {
  const owner = privateKeyToAccount(generatePrivateKey()), relay = privateKeyToAccount(generatePrivateKey())
  const base = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
  const stack: sdk.Stack = { ...base.stack, kind: 'hireling-v1', holding: addr('1'), evaluator: addr('2') }
  const deployment = { ...base.deployment, relay: relay.address, stacks: { main: stack }, hireling: {
    block: 0n, factory: stack.factory, safe: addr('4'), vault: addr('3'), feeSchedule: addr('5'),
    distributor: addr('6'), miningReserve: addr('7'), teamVesting: addr('8'), t0: 1,
  } }
  const db = new DatabaseSync(':memory:'); dbs.push(db)
  const sql = fromNodeSqlite(db)
  let now = 1_800_000_000, used = 0n, nonce = 0, upgraded = true, disabled = false, visible = true, balance = 100n * 10n ** 18n
  const receipts = new Map<string, Record<string, unknown>>()
  const receipt = async ({ hash }: { hash: Hex }) => {
    const found = visible ? receipts.get(hash) : undefined
    if (!found) throw new TransactionReceiptNotFoundError({ hash })
    return found
  }
  const client = {
    ...base.publicClient,
    getCode: vi.fn(async () => upgraded ? `0xef0100${deployment.delegation.delegator.slice(2)}` : '0x'),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => functionName === 'callCounts' ? used : disabled),
    getTransactionReceipt: vi.fn(receipt), waitForTransactionReceipt: vi.fn(receipt),
    getBlock: vi.fn(async () => ({ timestamp: BigInt(now) })),
    getTransactionCount: vi.fn(async () => nonce), getBalance: vi.fn(async () => balance),
    estimateGas: vi.fn(async () => 100_000n), call: vi.fn(async () => ({ data: '0x' })), getGasPrice: vi.fn(async () => 1_000_000_000n),
    sendRawTransaction: vi.fn(async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      const hash = keccak256(serializedTransaction)
      // Before any broadcast, both identity and signed bytes must already be durable.
      expect(sql.all<{ raw_tx: string; tx_hash: string; status: string; baseline_calls: number }>('SELECT * FROM sponsor_operations WHERE tx_hash=?', hash)[0]).toMatchObject({ raw_tx: serializedTransaction, tx_hash: hash, status: 'pending', baseline_calls: Number(used) })
      const tx = parseTransaction(serializedTransaction)
      expect(tx.nonce).toBe(nonce)
      const decoded = decodeFunctionData({ abi: delegationManagerAbi, data: tx.data! })
      if (decoded.functionName !== 'redeemDelegations') throw new Error('not a redemption')
      used += BigInt(decoded.args[0].length); nonce++
      receipts.set(hash, { transactionHash: hash, status: 'success', blockNumber: 5n, gasUsed: 100_000n, effectiveGasPrice: 1_000_000_000n })
      return hash
    }),
  }
  const ctx = { ...base, deployment, stack, publicClient: client } as unknown as sdk.Ctx
  const config = { sql, ctx, relay: { account: relay, rpcUrl: 'http://127.0.0.1:1' }, now: () => now, fail: (code: ConstructorParameters<typeof BoardError>[0], message: string) => new BoardError(code, message) }
  const boot = () => new SponsorDesk(config)
  const desk = boot()
  const sign = (typedData: string, account = owner) => sdk.signTypedDataJson({ account, signTypedData: (args: Parameters<typeof account.signTypedData>[0]) => account.signTypedData(args) } as never, typedData)
  const live = async () => { const p = await desk.prepare(owner.address); await desk.confirm(owner.address, await sign(p.sign.typedData)); return p }
  const cancel = (n = 1n) => ({ to: stack.holding, data: encodeFunctionData({ abi: sdk.hirelingHoldingAbi, functionName: 'cancelSelection', args: [n] }) })
  return { desk, boot, db, sql, ctx, owner, relay, client, sign, live, cancel,
    setUsed: (n: bigint) => { used = n }, setNow: (n: number) => { now = n }, advance: (n: number) => { now += n },
    setVisible: (v: boolean) => { visible = v }, setDisabled: () => { disabled = true }, setUpgraded: (v: boolean) => { upgraded = v }, setBalance: (n: bigint) => { balance = n } }
}

describe('ERC-7710 sponsorship boundaries and recovery', () => {
  it('prepared permissions read none, can be replaced, and use packed 20-byte targets plus finite D10 caveats', async () => {
    const f = fixture()
    const first = await f.desk.prepare(f.owner.address)
    expect(await f.desk.status(f.owner.address)).toEqual({ status: 'none', typedData: null, callsUsed: 0 })
    const second = await f.desk.prepare(f.owner.address)
    expect(second.sign.typedData).not.toBe(first.sign.typedData)
    const x = JSON.parse(second.sign.typedData).message as { delegate: string; authority: string; caveats: Array<{ enforcer: string; terms: Hex }> }
    expect(x.delegate).toBe(f.relay.address)
    expect(x.authority).toBe(`0x${'f'.repeat(64)}`)
    const e = f.ctx.deployment.delegation.enforcers
    for (const enforcer of [e.allowedTargets, e.allowedMethods, e.limitedCalls, e.timestamp]) expect(x.caveats.filter(c => c.enforcer === enforcer)).toHaveLength(1)
    expect(size(x.caveats.find(c => c.enforcer === e.allowedTargets)!.terms)).toBe(80)
    expect(size(x.caveats.find(c => c.enforcer === e.timestamp)!.terms)).toBe(32)
    await expect(f.desk.confirm(f.owner.address, await f.sign(first.sign.typedData))).rejects.toThrow('signature')
    await f.desk.confirm(f.owner.address, await f.sign(second.sign.typedData))
    expect((await f.desk.status(f.owner.address)).status).toBe('live')
  })
  it('refuses wrong signer, an unupgraded wallet, policy/key mismatch, and unavailable chain state', async () => {
    const f = fixture(), p = await f.desk.prepare(f.owner.address)
    await expect(f.desk.confirm(f.owner.address, await f.sign(p.sign.typedData, f.relay))).rejects.toThrow('signature')
    f.setUpgraded(false)
    await expect(f.desk.confirm(f.owner.address, await f.sign(p.sign.typedData))).rejects.toThrow('upgrade')
    f.setUpgraded(true)
    await f.desk.confirm(f.owner.address, await f.sign(p.sign.typedData))
    f.client.readContract.mockRejectedValueOnce(new Error('RPC down'))
    await expect(f.desk.status(f.owner.address)).rejects.toThrow('RPC down')
  })
  it('persists signed bytes before broadcast and reconciles a lost response/restart without another send', async () => {
    const f = fixture(); await f.live(); f.setVisible(false)
    const first = await f.desk.submit(f.owner.address, [f.cancel()], 'lost-response')
    expect(first.status).toBe('pending')
    f.setVisible(true)
    const second = await f.boot().submit(f.owner.address, [f.cancel()], 'lost-response')
    expect(second).toMatchObject({ operationId: first.operationId, txHash: first.txHash, status: 'confirmed', callsUsed: 1 })
    expect(f.client.sendRawTransaction).toHaveBeenCalledTimes(1)
    expect(await f.boot().operation(f.owner.address, first.operationId)).toEqual(second)
    expect(f.client.sendRawTransaction).toHaveBeenCalledTimes(1)
    await expect(f.desk.operation(f.relay.address, first.operationId)).rejects.toThrow('no sponsorship operation')
  })
  it('key dedupe survives metadata changes and grants; another key permits identical legitimate calls', async () => {
    const f = fixture(); await f.live()
    const first = await f.desk.submit(f.owner.address, [f.cancel()], 'one')
    expect(await f.desk.submit(f.owner.address, [{ ...f.cancel(), value: '0', chainId: f.ctx.deployment.chainId }], 'one')).toEqual(first)
    await expect(f.desk.submit(f.owner.address, [f.cancel(2n)], 'one')).rejects.toMatchObject({ reason: 'policy' })
    const second = await f.desk.submit(f.owner.address, [f.cancel()], 'two')
    expect(second.operationId).not.toBe(first.operationId)
    expect(second.callsUsed).toBe(2)
    expect(f.client.sendRawTransaction).toHaveBeenCalledTimes(2)
    await f.desk.revoke(f.owner.address); await f.live()
    expect((await f.desk.submit(f.owner.address, [f.cancel()], 'one')).txHash).toBe(first.txHash)
    expect(f.client.sendRawTransaction).toHaveBeenCalledTimes(2)
  })
  it('D15 refuses every omitted mutating method and noncanonical calldata before simulation', async () => {
    const f = fixture(); await f.live()
    for (const [to, abi, methods] of [
      [f.ctx.stack.holding, sdk.hirelingHoldingAbi, ['publish', 'topUp', 'setDefaultArbitrator']],
      [f.ctx.stack.evaluator, sdk.hirelingEvaluatorAbi, ['rule', 'ruleWithSignature', 'cancelRuling', 'notePause', 'setVerifier']],
      [f.ctx.deployment.hireling!.vault, sdk.stakeVaultAbi, ['stake', 'stakeWithPermit', 'requestUnstake', 'setHoldingDenied']],
      [f.ctx.deployment.core, sdk.coreAbi, ['setPayoutReceiver', 'pause', 'upgradeToAndCall']],
    ] as const) {
      for (const name of methods) {
        const fn = abi.find(x => x.type === 'function' && x.name === name)!
        const data = (await import('viem')).toFunctionSelector(fn as import('viem').AbiFunction)
        await expect(f.desk.submit(f.owner.address, [{ to, data }], name)).rejects.toMatchObject({ reason: 'policy' })
      }
    }
    await expect(f.desk.submit(f.owner.address, [{ ...f.cancel(), value: '1' }], 'value')).rejects.toThrow('zero value')
    await expect(f.desk.submit(f.owner.address, [{ ...f.cancel(), data: `${f.cancel().data}00` }], 'trailing')).rejects.toThrow('valid calldata')
    await expect(f.desk.submit(f.owner.address, [{ ...f.cancel(), to: f.owner.address }], 'target')).rejects.toMatchObject({ reason: 'policy' })
    expect(f.client.estimateGas).not.toHaveBeenCalled()
    expect(f.client.sendRawTransaction).not.toHaveBeenCalled()
  })
  it('uses summed ADR gas floors and receipt gas cost, while retaining conservative pending reservations', async () => {
    const f = fixture(); await f.live()
    const calls = [
      { to: f.ctx.stack.evaluator, data: encodeFunctionData({ abi: sdk.hirelingEvaluatorAbi, functionName: 'retryDeferred', args: [1n] }) },
      { to: f.ctx.stack.holding, data: encodeFunctionData({ abi: sdk.hirelingHoldingAbi, functionName: 'settle', args: [1n] }) },
    ]
    const op = await f.desk.submit(f.owner.address, calls, 'deferred')
    const raw = f.sql.all<{ raw_tx: Hex; cost: string; reserved_cost: string }>('SELECT * FROM sponsor_operations WHERE id=?', op.operationId)[0]!
    expect(parseTransaction(raw.raw_tx).gas).toBe(sdk.V1_GAS.retryDeferred + sdk.V1_GAS.settle + 100_000n)
    expect(BigInt(raw.cost)).toBe(100_000n * 1_000_000_000n)
    expect(BigInt(raw.reserved_cost)).toBeGreaterThan(BigInt(raw.cost))
    expect(op.callsUsed).toBe(2)
  })
  it('enforces global cap, balance floor, wallet window, and simulation failure without persisting/broadcasting', async () => {
    const f = fixture(); await f.live()
    f.setBalance(SPONSOR_LIMITS.relayFloorWei)
    await expect(f.desk.submit(f.owner.address, [f.cancel()], 'floor')).rejects.toMatchObject({ reason: 'floor' })
    f.setBalance(100n * 10n ** 18n)
    f.client.call.mockRejectedValueOnce(new Error('revert'))
    await expect(f.desk.submit(f.owner.address, [f.cancel()], 'simulation')).rejects.toMatchObject({ reason: 'simulation' })
    expect(f.sql.all('SELECT * FROM sponsor_operations')).toHaveLength(0)
    const op = await f.desk.submit(f.owner.address, [f.cancel()], 'initial')
    f.sql.run('UPDATE sponsor_operations SET cost=? WHERE id=?', SPONSOR_LIMITS.dailyWei.toString(), op.operationId)
    await expect(f.desk.submit(f.relay.address, [f.cancel()], 'other-wallet')).rejects.toThrow('confirm')
    await expect(f.desk.submit(f.owner.address, [f.cancel(2n)], 'cap')).rejects.toMatchObject({ reason: 'cap' })
    f.sql.run('UPDATE sponsor_operations SET cost=?, calls=? WHERE id=?', '1', SPONSOR_LIMITS.walletCalls, op.operationId)
    await expect(f.desk.submit(f.owner.address, [f.cancel(2n)], 'rate')).rejects.toMatchObject({ reason: 'rate' })
    f.advance(SPONSOR_LIMITS.walletWindow + 1)
    expect((await f.desk.submit(f.owner.address, [f.cancel(2n)], 'after-window')).status).toBe('confirmed')
    expect(f.client.sendRawTransaction).toHaveBeenCalledTimes(2)
  })
  it('serializes concurrent sends and identical retries; an unresolved receipt blocks another action', async () => {
    const f = fixture(); await f.live()
    const results = await Promise.all([f.desk.submit(f.owner.address, [f.cancel()], 'one'), f.desk.submit(f.owner.address, [f.cancel()], 'one'), f.desk.submit(f.owner.address, [f.cancel(2n)], 'two')])
    expect(results[0]).toEqual(results[1]); expect(results[2]?.callsUsed).toBe(2)
    expect(f.client.sendRawTransaction).toHaveBeenCalledTimes(2)
    f.setVisible(false)
    const unresolved = await f.desk.submit(f.owner.address, [f.cancel(3n)], 'three')
    expect(unresolved.status).toBe('pending')
    await expect(f.desk.submit(f.owner.address, [f.cancel(4n)], 'four')).rejects.toMatchObject({ reason: 'pending' })
    const sends = f.client.sendRawTransaction.mock.calls.length
    expect((await f.desk.operation(f.owner.address, unresolved.operationId)).status).toBe('pending')
    expect(f.client.sendRawTransaction).toHaveBeenCalledTimes(sends)
  })
  it('chain count/expiry/revocation determine status and revocation remains available during drain', async () => {
    const f = fixture(); await f.live()
    f.setUsed(100n); expect((await f.desk.status(f.owner.address)).status).toBe('used')
    f.setUsed(0n); f.advance(SPONSOR_LIMITS.validity); expect((await f.desk.status(f.owner.address)).status).toBe('expired')
    f.setDisabled(); expect((await f.desk.status(f.owner.address)).status).toBe('revoked')
    expect((await f.desk.revoke(f.owner.address)).transactions).toEqual([])
    for (const tool of ['sponsor_status', 'sponsor_operation']) expect(readOnlyHostedTools.has(tool)).toBe(true)
    for (const tool of ['sponsor_prepare', 'sponsor_confirm', 'sponsor_submit']) {
      expect(hostedToolNames.has(tool)).toBe(true); expect(readOnlyHostedTools.has(tool)).toBe(false)
      expect(admissionFailure(parseHostedAdmission('1'), 'monad-mainnet', 'public', tool, f.owner.address)).toContain('drain')
    }
    expect(admissionFailure(parseHostedAdmission('1'), 'monad-mainnet', 'public', 'sponsor_revoke', f.owner.address)).toBeUndefined()
  })
  it('board sponsorship methods require the signed-in owner, including read-only polling', async () => {
    const f = fixture()
    const board = new Board(f.sql, { network: 'monad-testnet', contexts: { main: f.ctx }, domain: 'test.invalid', uri: 'https://test.invalid', manifestBaseUrl: '' })
    expect(() => board.sponsorStatus({}, { wallet: f.owner.address })).toThrow('Sign in')
    expect(() => board.sponsorPrepare({ address: f.relay.address }, { wallet: f.owner.address })).toThrow('authenticated wallet')
  })
})
