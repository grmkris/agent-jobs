/** ERC-7710 gas sponsorship. Only the relay signs transactions; the wallet signs its own bounded delegation. */
import * as sdk from '@agent-jobs/sdk'
import {
  type Abi, type AbiFunction, type Address, type Hex, type LocalAccount,
  concat, decodeFunctionData, encodeAbiParameters, encodeFunctionData, encodePacked,
  getAddress, isAddress, keccak256, recoverAddress, stringToHex, toFunctionSelector,
} from 'viem'
import {
  type Caveat, type Delegation, ROOT_AUTHORITY, callsMade, delegationDigest, delegationHash, delegationJson,
  delegationTypedData, disableCalldata, isDisabled, parseDelegation, redeemCallsCalldata,
} from './delegation.ts'
import type { Sql } from './store.ts'
import { migrateGrantSchema } from './agent-schema.ts'
import { RelaySender, withRelayNonce } from './relay.ts'
import { type SponsorOperation as Operation, type SponsorResult, SponsorRecovery } from './sponsor-recovery.ts'
import { SPONSOR_LIMITS, sponsorRelayFloor } from './sponsor-policy.ts'
export { SPONSOR_LIMITS } from './sponsor-policy.ts'
export type { SponsorResult } from './sponsor-recovery.ts'

/** One object in the existing Board namespace, shared by every tenant and both transports. */
export const SPONSOR_OBJECT_NAME = '__hosted_sponsor_v1__'
export const sponsorToolNames = new Set(['sponsor_status', 'sponsor_prepare', 'sponsor_confirm', 'sponsor_revoke', 'sponsor_submit', 'sponsor_operation'])

export interface SponsorCall {
  readonly to: string
  readonly data: string
  readonly value?: string
  readonly chainId?: number
}
export interface SponsorDeps {
  readonly sql: Sql
  readonly now: () => number
  readonly ctx: sdk.Ctx
  readonly relay?: { readonly account: LocalAccount; readonly rpcUrl: string }
  readonly fail: (code: 'unauthenticated' | 'forbidden' | 'not-found' | 'invalid' | 'conflict' | 'chain', message: string) => Error
}
interface Grant {
  delegator: string; delegation_json: string; delegation_hash: string; signature: string | null; status: string; expires_at: number
}
interface Target { address: Address; abi: Abi; methods: readonly string[] }
type NormalCall = { target: Address; callData: Hex; value: bigint; floor: bigint }
export type SponsorStatus = { status: 'none' | 'live' | 'expired' | 'used' | 'revoked'; typedData: string | null; callsUsed: number }
const eq = (a: string | null | undefined, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase()
const uint = (n: bigint) => encodeAbiParameters([{ type: 'uint256' }], [n])
const caveat = (enforcer: Address, terms: Hex): Caveat => ({ enforcer, terms: terms.toLowerCase() as Hex, args: '0x' })
const functions = (t: Target) => t.abi.filter((f): f is AbiFunction => f.type === 'function' && t.methods.includes(f.name))

/** Serialized across awaits, including status/prepare/revoke, so concurrent calls cannot change a grant mid-send. */
export class SponsorDesk {
  readonly #d: SponsorDeps
  #queue: Promise<unknown> = Promise.resolve()
  constructor(deps: SponsorDeps) {
    this.#d = deps
    migrateGrantSchema(deps.sql)
    deps.sql.run(`CREATE TABLE IF NOT EXISTS sponsor_operations (
      id TEXT PRIMARY KEY, wallet TEXT NOT NULL, delegation_hash TEXT NOT NULL, status TEXT NOT NULL,
      raw_tx TEXT NOT NULL, tx_hash TEXT NOT NULL UNIQUE, relay TEXT NOT NULL, nonce INTEGER NOT NULL,
      cost TEXT, reserved_cost TEXT NOT NULL, charged_day INTEGER, calls INTEGER NOT NULL, baseline_calls INTEGER NOT NULL,
      created_at INTEGER NOT NULL, action_key TEXT NOT NULL, payload_hash TEXT NOT NULL, UNIQUE(wallet,action_key)
    )`)
    deps.sql.run('CREATE INDEX IF NOT EXISTS sponsor_operations_time ON sponsor_operations(created_at)')
  }
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(fn)
    this.#queue = result.catch(() => undefined)
    return result
  }
  #grantSerial<T>(fn: () => Promise<T>): Promise<T> {
    return this.#serial(() => withRelayNonce(this.#ctx().deployment.relay, fn))
  }
  #ctx(): sdk.Ctx {
    const ctx = this.#d.ctx
    if (ctx.stack.kind !== 'hireling-v1' || ctx.deployment.hireling === null) throw this.#d.fail('conflict', 'sponsorship requires a deployed Hireling v1 stack')
    return ctx
  }
  #relay() {
    const relay = this.#d.relay
    if (relay === undefined || !eq(relay.account.address, this.#ctx().deployment.relay)) throw this.#refuse('unavailable', 'the configured sponsorship relay is unavailable')
    return relay
  }
  #wallet(text: string): Address {
    if (typeof text !== 'string' || !isAddress(text)) throw this.#d.fail('invalid', 'wallet must be an address')
    return getAddress(text)
  }
  #refuse(reason: 'policy' | 'simulation' | 'cap' | 'floor' | 'rate' | 'unavailable' | 'pending', message: string): Error {
    return Object.assign(this.#d.fail(reason === 'policy' ? 'forbidden' : reason === 'simulation' ? 'chain' : 'conflict', message), { reason })
  }
  #row(wallet: string): Grant | undefined { return this.#d.sql.all<Grant>("SELECT * FROM grants WHERE delegator = ? AND kind='operator' ORDER BY expires_at DESC, rowid DESC LIMIT 1", wallet.toLowerCase())[0] }
  #targets(): Target[] {
    const c = this.#ctx()
    return [
      { address: c.stack.holding, abi: sdk.hirelingHoldingAbi, methods: ['activate', 'cancel', 'cancelSelection', 'claimTopUpRefund', 'settle', 'withdraw'] },
      { address: c.stack.evaluator, abi: sdk.hirelingEvaluatorAbi, methods: ['accept', 'reject', 'dispute', 'completeAfterSilence', 'rejectAfterDeliveryDeadline', 'rejectAfterWindow', 'refundAfterArbitrationTimeout', 'retryDeferred'] },
      { address: c.deployment.hireling!.vault, abi: sdk.stakeVaultAbi, methods: ['cancelUnstake', 'withdraw'] },
      { address: c.deployment.core, abi: sdk.coreAbi, methods: ['submit', 'submitClaim', 'claimRefund'] },
    ]
  }
  #delegation(wallet: Address, salt: bigint, expires: number): Delegation {
    const e = this.#ctx().deployment.delegation.enforcers
    const targets = this.#targets()
    const methods = [...new Set(targets.flatMap(t => functions(t).map(f => toFunctionSelector(f))))]
    return { delegator: wallet, delegate: this.#relay().account.address, authority: ROOT_AUTHORITY, salt, signature: '0x', caveats: [
      caveat(e.allowedTargets, concat(targets.map(t => t.address))),
      caveat(e.allowedMethods, concat(methods)),
      caveat(e.limitedCalls, uint(BigInt(SPONSOR_LIMITS.calls))),
      caveat(e.timestamp, encodePacked(['uint128', 'uint128'], [0n, BigInt(expires)])),
      caveat(e.valueLte, uint(0n)),
    ] }
  }
  #current(row: Grant): Delegation {
    const x = parseDelegation(row.delegation_json)
    if (delegationHash(this.#delegation(this.#wallet(row.delegator), x.salt, row.expires_at)) !== row.delegation_hash) throw this.#d.fail('conflict', 'sponsorship policy changed; revoke and prepare a new delegation')
    return { ...x, signature: row.signature as Hex }
  }
  async #status(wallet: Address): Promise<SponsorStatus> {
    const ctx = this.#ctx(), row = this.#row(wallet)
    if (row === undefined || row.status === 'prepared') return { status: 'none', typedData: null, callsUsed: 0 }
    // Unavailable chain state must error, never claim unused permission or an enabled delegation.
    const [used, disabled] = await Promise.all([callsMade(ctx, row.delegation_hash as Hex), isDisabled(ctx, row.delegation_hash as Hex)])
    const status = row.status === 'revoked' || disabled ? 'revoked' : this.#d.now() >= row.expires_at ? 'expired' : used >= BigInt(SPONSOR_LIMITS.calls) ? 'used' : 'live'
    return { status, typedData: delegationTypedData(ctx.deployment, parseDelegation(row.delegation_json)), callsUsed: Number(used) }
  }
  status(wallet: string) { return this.#serial(() => this.#status(this.#wallet(wallet))) }
  prepare(walletText: string) { return this.#grantSerial(async () => {
    const wallet = this.#wallet(walletText), ctx = this.#ctx()
    this.#relay()
    if ((await this.#status(wallet)).status === 'live') throw this.#d.fail('conflict', 'this wallet already has a live sponsorship delegation')
    const salt = BigInt(`0x${[...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('')}`)
    const expires = this.#d.now() + SPONSOR_LIMITS.validity
    const x = this.#delegation(wallet, salt, expires)
    this.#d.sql.run(`INSERT INTO grants (delegation_hash,kind,delegator,delegate,owner,delegation_json,signature,status,expires_at)
      VALUES (?,'operator',?,?,?,?,NULL,'prepared',?)`,
      delegationHash(x), wallet.toLowerCase(), x.delegate.toLowerCase(), wallet.toLowerCase(), delegationJson(x), expires)
    const current = await sdk.delegationOf(ctx.publicClient, wallet)
    return { sign: { typedData: delegationTypedData(ctx.deployment, x) }, upgrade: eq(current, ctx.deployment.delegation.delegator) ? null : { delegator: ctx.deployment.delegation.delegator } }
  }) }
  confirm(walletText: string, signature: string) { return this.#grantSerial(async () => {
    const wallet = this.#wallet(walletText), ctx = this.#ctx(), row = this.#row(wallet)
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw this.#d.fail('invalid', 'signature must be a 65-byte hex signature')
    if (row === undefined || row.status !== 'prepared' && row.status !== 'live') throw this.#d.fail('conflict', 'start with sponsor_prepare')
    if (row.expires_at <= this.#d.now()) throw this.#d.fail('conflict', 'prepare a new sponsorship delegation; this one expired')
    const x = this.#current(row)
    const signer = await recoverAddress({ hash: delegationDigest(ctx.deployment, x), signature: signature as Hex }).catch(() => null)
    if (!eq(signer, wallet)) throw this.#d.fail('forbidden', 'the signature is not the wallet’s over the prepared delegation')
    if (!eq(await sdk.delegationOf(ctx.publicClient, wallet), ctx.deployment.delegation.delegator)) throw this.#d.fail('conflict', 'upgrade the wallet to the DeleGator before confirming sponsorship')
    if (await isDisabled(ctx, row.delegation_hash as Hex)) throw this.#d.fail('conflict', 'this delegation is disabled on-chain')
    this.#d.sql.run("UPDATE grants SET signature=?, status='live' WHERE delegation_hash=?", signature, row.delegation_hash)
    return this.#status(wallet)
  }) }
  revoke(walletText: string) { return this.#grantSerial(async () => {
    const wallet = this.#wallet(walletText), ctx = this.#ctx(), row = this.#row(wallet)
    this.#d.sql.run("UPDATE grants SET status='revoked' WHERE delegator=? AND kind='operator'", wallet.toLowerCase())
    const transactions: sdk.TxRequest[] = []
    if (row !== undefined && row.signature !== null && !await isDisabled(ctx, row.delegation_hash as Hex)) transactions.push({
      description: 'Disable the sponsorship delegation', chainId: ctx.deployment.chainId,
      to: ctx.deployment.delegation.manager, data: disableCalldata(parseDelegation(row.delegation_json)), value: '0',
    })
    return { transactions }
  }) }
  #validate(calls: readonly SponsorCall[]): NormalCall[] {
    if (!Array.isArray(calls) || calls.length === 0 || calls.length > SPONSOR_LIMITS.batch) throw this.#d.fail('invalid', `provide 1-${SPONSOR_LIMITS.batch} sponsored calls`)
    return calls.map((call, i) => {
      if (call === null || typeof call !== 'object' || !isAddress(call.to) || typeof call.data !== 'string' || !/^0x[0-9a-fA-F]{8}(?:[0-9a-fA-F]{2})*$/.test(call.data) || call.data.length > 32770) throw this.#d.fail('invalid', `calls[${i}] has malformed target or calldata`)
      if ((call.value ?? '0') !== '0' || call.chainId !== undefined && call.chainId !== this.#ctx().deployment.chainId) throw this.#d.fail('invalid', `calls[${i}] must have zero value and use this chain`)
      const target = this.#targets().find(t => eq(call.to, t.address))
      if (target === undefined) throw this.#refuse('policy', `calls[${i}] targets a contract outside Hireling v1`)
      const fn = functions(target).find(f => eq(call.data.slice(0, 10), toFunctionSelector(f)))
      if (fn === undefined) throw this.#refuse('policy', `calls[${i}] uses a method outside the sponsorship policy`)
      try {
        const decoded = decodeFunctionData({ abi: [fn], data: call.data as Hex })
        if (!eq(encodeFunctionData({ abi: [fn], functionName: decoded.functionName, args: decoded.args }), call.data)) throw new Error('noncanonical calldata')
      } catch { throw this.#d.fail('invalid', `calls[${i}] is not valid calldata for ${fn.name}`) }
      const floor = eq(target.address, this.#ctx().stack.evaluator)
        ? fn.name === 'retryDeferred' ? sdk.V1_GAS.retryDeferred : fn.name === 'dispute' ? 300_000n : sdk.V1_GAS.evaluator
        : fn.name === 'settle' ? sdk.V1_GAS.settle : fn.name === 'claimTopUpRefund' ? sdk.V1_GAS.claimTopUpRefund : fn.name === 'cancel' ? sdk.V1_GAS.cancel : 500_000n
      return { target: target.address, callData: call.data.toLowerCase() as Hex, value: 0n, floor }
    })
  }
  #recovery() { return new SponsorRecovery(this.#d.sql, this.#ctx(), this.#d.now, this.#d.relay?.account) }
  #resume(op: Operation, broadcast = true) { return this.#recovery().resume(op, broadcast) }
  submit(walletText: string, calls: readonly SponsorCall[], key: string) { return this.#serial(async (): Promise<SponsorResult> => {
    const wallet = this.#wallet(walletText)
    const id = keccak256(stringToHex(JSON.stringify([wallet.toLowerCase(), key])))
    const prior = this.#d.sql.all<Operation>('SELECT * FROM sponsor_operations WHERE id=?', id)[0]
    // An existing key always names the original send. A fresh-key refusal means nothing was sent; a retry must
    // therefore reconcile that send before checking the current grant, policy, keys, caps or replacement calls.
    if (prior !== undefined) return withRelayNonce(getAddress(prior.relay), () => this.#resume(prior))
    const ctx = this.#ctx(), relay = this.#relay()
    return withRelayNonce(relay.account.address, async () => {
      const parsed = this.#validate(calls)
      if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(key)) throw this.#d.fail('invalid', 'key must be 1-128 letters, digits, underscores or hyphens; reuse it only for retries of one action')
      const payloadHash = keccak256(stringToHex(JSON.stringify(parsed.map(c => [c.target.toLowerCase(), c.callData, '0']))))
      const row = this.#row(wallet)
      if (row === undefined || row.signature === null) throw this.#d.fail('conflict', 'confirm a sponsorship delegation before submitting calls')
      // Both ledgers recover under the same queue before a fresh nonce, simulation or cap reservation.
      try { await new RelaySender(this.#d.sql, ctx, relay.account, relay.rpcUrl, this.#d.now).checkPendingLocked() }
      catch { throw this.#refuse('pending', 'an earlier relay transaction is still pending; retry shortly') }
      const current = await this.#status(wallet)
      if (current.status !== 'live' || row.status !== 'live') throw this.#d.fail('conflict', `sponsorship is ${current.status}`)
      if (current.callsUsed + parsed.length > SPONSOR_LIMITS.calls) throw this.#refuse('cap', 'the sponsorship call limit is exhausted')
      const signed = this.#current(row)
      const data = redeemCallsCalldata(signed, parsed)
      // ADR-0011 inner limits plus manager overhead are used only if estimation is unreliable.
      const floor = parsed.reduce((sum, c) => sum + c.floor, 100_000n)
      const gas = await sdk.transactionGas(ctx.publicClient, { account: relay.account, to: ctx.deployment.delegation.manager, data }, floor)
        .catch(() => { throw this.#refuse('simulation', 'the sponsored calls did not simulate successfully') })
      if (gas > SPONSOR_LIMITS.gas) throw this.#refuse('cap', 'the sponsored transaction exceeds the gas cap')
      const { maxFeePerGas, maxPriorityFeePerGas } = await sdk.transactionFees(ctx.publicClient)
      const cost = gas * maxFeePerGas
      const day = Math.floor(this.#d.now() / 86400) * 86400
      const daily = this.#d.sql.all<{ cost: string }>('SELECT cost FROM sponsor_operations WHERE charged_day=? AND cost IS NOT NULL UNION ALL SELECT cost FROM sponsor_replacements WHERE charged_day=? AND cost IS NOT NULL', day, day)
      // Charge only receipts. All unresolved sends were reconciled above; this send reserves its maximum cost.
      if (daily.reduce((sum, op) => sum + BigInt(op.cost!), cost) > SPONSOR_LIMITS.dailyWei) throw this.#refuse('cap', 'the relay’s daily sponsorship budget is exhausted')
      const recent = this.#d.sql.all<Operation>('SELECT * FROM sponsor_operations WHERE wallet=? AND created_at > ?', wallet.toLowerCase(), this.#d.now() - SPONSOR_LIMITS.walletWindow)
      if (recent.reduce((sum, op) => sum + op.calls, parsed.length) > SPONSOR_LIMITS.walletCalls) throw this.#refuse('rate', 'the wallet’s sponsorship rate limit is exhausted')
      if (await ctx.publicClient.getBalance({ address: relay.account.address }) < sponsorRelayFloor(ctx.deployment.network) + cost) throw this.#refuse('floor', 'the sponsorship relay is below its balance floor')
      const nonce = await ctx.publicClient.getTransactionCount({ address: relay.account.address, blockTag: 'pending' })
      const raw = await relay.account.signTransaction({ type: 'eip1559', chainId: ctx.deployment.chainId, nonce,
        to: ctx.deployment.delegation.manager, data, value: 0n, gas, maxFeePerGas, maxPriorityFeePerGas })
      const hash = keccak256(raw)
      // A single synchronous reservation persists the operation and the exact signed bytes before any money moves.
      this.#d.sql.run("INSERT INTO sponsor_operations (id,wallet,delegation_hash,status,raw_tx,tx_hash,relay,nonce,reserved_cost,calls,baseline_calls,created_at,action_key,payload_hash) VALUES (?,?,?,'pending',?,?,?,?,?,?,?,?,?,?)",
        id, wallet.toLowerCase(), row.delegation_hash, raw, hash, relay.account.address, nonce, cost.toString(), parsed.length, current.callsUsed, this.#d.now(), key, payloadHash)
      return this.#resume(this.#d.sql.all<Operation>('SELECT * FROM sponsor_operations WHERE id=?', id)[0]!)
    })
  }) }

  operation(walletText: string, operationId: string) { return this.#serial(async () => {
    const wallet = this.#wallet(walletText)
    const row = this.#d.sql.all<Operation>('SELECT * FROM sponsor_operations WHERE id=? AND wallet=?', operationId, wallet.toLowerCase())[0]
    if (row === undefined) throw this.#d.fail('not-found', 'no sponsorship operation for this wallet')
    return withRelayNonce(getAddress(row.relay), () => this.#resume(row, false))
  }) }
}
