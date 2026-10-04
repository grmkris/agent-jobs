/**
 * Execution budget (ADR-0009): one delegation per hire from the creator's account to the activated worker, enforced
 * on-chain by the MetaMask Delegation Framework (`delegation.ts`).
 *
 * - The creator grants it once the worker has activated: its wallet points at the framework's DeleGator (EIP-7702)
 *   and signs the delegation the board prepared. The board holds no key over anyone's funds.
 * - The worker draws by sending `redeemDelegations` from its own wallet. The board prepares that transaction and
 *   refuses what the chain would refuse, but the enforcers are the limit: an advance's total, its token and its
 *   recipient (the worker), a call budget's one call and its value, and the expiry. Anyone holding the signed
 *   delegation (the worker) can redeem it without the board.
 * - The creator revokes by sending `disableDelegation`; the board stops preparing draws at once.
 * - Nothing is escrowed: drawn is drawn, the rest never left the creator's wallet.
 */
import * as sdk from '@agent-jobs/sdk'
import { type Address, type Hex, type TransactionReceipt, decodeEventLog, decodeFunctionData, erc20Abi, formatUnits, isHex, parseUnits, recoverAddress, toFunctionSelector } from 'viem'
import {
  advanceExecution,
  budgetDelegation,
  callsMade,
  delegationDigest,
  delegationHash,
  delegationJson,
  delegationManagerAbi,
  delegationTypedData,
  disableCalldata,
  drawn,
  isDisabled,
  parseDelegation,
  redeemCalldata,
} from '@agent-jobs/sdk'
import type { BudgetDelegationRow, BudgetDrawRow, Sql, TaskRow } from './store.ts'
import { type AdvanceBudget, type CallBudget, type ExecutionBudget, type OfferTerms, callFunction } from './terms.ts'

/** What the budget needs from the board: one task's terms, its chain view and its chain context. */
export interface BudgetTaskState {
  readonly task: TaskRow
  readonly terms: OfferTerms
  readonly status: string
  readonly provider: Address | null
  readonly ctx: sdk.Ctx
}

export interface BudgetDeps {
  readonly sql: Sql
  readonly now: () => number
  readonly taskState: (taskId: string) => Promise<BudgetTaskState>
  readonly fail: (code: 'unauthenticated' | 'forbidden' | 'not-found' | 'invalid' | 'conflict' | 'chain', message: string) => Error
}

/** An unsigned transaction for the caller's wallet, as every board step returns it. */
interface BudgetTx {
  readonly description: string
  readonly chainId: number
  readonly to: Address
  readonly data: Hex
  readonly value: '0'
}

/** The chain's native token symbol (a call budget's cap is in it). */
export function nativeSymbol(ctx: sdk.Ctx): string {
  return ctx.publicClient.chain?.nativeCurrency.symbol ?? (ctx.deployment.chainId === 10143 || ctx.deployment.chainId === 143 ? 'MON' : 'ETH')
}

/** Chain statuses after which nothing may be drawn: the job is settled or can no longer be delivered. */
const OVER = new Set(['completed', 'rejected', 'cancelled', 'expired', 'lapsed'])

const eq = (a: string | null | undefined, b: string | null | undefined) =>
  a !== null && a !== undefined && b !== null && b !== undefined && a.toLowerCase() === b.toLowerCase()

function randomId(bytes = 8): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export class BudgetDesk {
  readonly #deps: BudgetDeps

  constructor(deps: BudgetDeps) {
    this.#deps = deps
  }

  /** Records the budget an offer carries, when the task is created: promised until the creator grants it. */
  promise(taskId: string, creator: Address, budget: ExecutionBudget): void {
    this.#deps.sql.run(
      "INSERT INTO budget_delegations (task_id, creator, kind, status, created_at) VALUES (?, ?, ?, 'promised', ?)",
      taskId, creator, budget.kind, this.#deps.now(),
    )
  }

  /** promised: in the terms, not granted yet; live: the worker can draw; revoked / ended. Null without a budget. */
  grantStatus(taskId: string): string | null {
    return this.#deps.sql.all<BudgetDelegationRow>('SELECT status FROM budget_delegations WHERE task_id = ?', taskId)[0]?.status ?? null
  }

  #row(taskId: string): BudgetDelegationRow {
    const [row] = this.#deps.sql.all<BudgetDelegationRow>('SELECT * FROM budget_delegations WHERE task_id = ?', taskId)
    if (row === undefined) throw this.#deps.fail('not-found', `task ${taskId} has no execution budget`)
    return row
  }

  #budget(st: BudgetTaskState): ExecutionBudget {
    const b = st.terms.executionBudget
    if (b === undefined) throw this.#deps.fail('not-found', `task ${st.task.id} has no execution budget`)
    return b
  }

  #creatorOnly(st: BudgetTaskState, me: Address, what: string): void {
    if (!eq(st.terms.creator, me)) throw this.#deps.fail('forbidden', `only the creator ${what} the execution budget`)
  }

  /** Ends a budget whose job settled, whose time ran out or whose delegation was disabled on-chain. */
  async #endIfOver(row: BudgetDelegationRow, st: BudgetTaskState, b: ExecutionBudget): Promise<BudgetDelegationRow> {
    if (row.status === 'ended' || row.status === 'revoked') return row
    const disabled = row.status === 'live' && row.delegation_hash !== null && (await isDisabled(st.ctx, row.delegation_hash as Hex))
    const reason = OVER.has(st.status) ? `job ${st.status}` : this.#deps.now() >= b.expiresAt ? 'expired' : disabled ? 'disabled on-chain by the creator' : null
    if (reason === null) return row
    const status = disabled ? 'revoked' : 'ended'
    this.#deps.sql.run('UPDATE budget_delegations SET status = ?, ended_at = ?, ended_reason = ? WHERE task_id = ?', status, this.#deps.now(), reason, row.task_id)
    return { ...row, status, ended_at: this.#deps.now(), ended_reason: reason }
  }

  #tx(st: BudgetTaskState, description: string, data: Hex): BudgetTx {
    return { description, chainId: st.ctx.deployment.chainId, to: st.ctx.deployment.delegation.manager, data, value: '0' }
  }

  // ---------------------------------------------------------------------------------------------
  // Creator: grant, revoke
  // ---------------------------------------------------------------------------------------------

  /**
   * The delegation for the creator to sign, once the worker has activated: it names that worker, so granting before
   * activation would let a selected worker draw without posting its bond. `upgrade` is set when the creator's wallet
   * does not point at the DeleGator yet: that one transaction to itself comes first (Explore sends it).
   */
  async grantPrepare(me: Address, input: { taskId: string }) {
    const st = await this.#deps.taskState(input.taskId)
    this.#creatorOnly(st, me, 'grants')
    const b = this.#budget(st)
    const row = await this.#endIfOver(this.#row(input.taskId), st, b)
    if (row.status !== 'promised') throw this.#deps.fail('conflict', `this budget is ${row.status}${row.ended_reason === null ? '' : ` (${row.ended_reason})`}`)
    if (st.status !== 'active' || st.provider === null) {
      throw this.#deps.fail('conflict', `grant the budget once the worker has activated (the job is ${st.status})`)
    }
    const x = budgetDelegation(st.ctx.deployment, b, st.terms.creator, st.provider, st.task.terms_hash as Hex, b.expiresAt)
    const hash = delegationHash(x)
    this.#deps.sql.run(
      'UPDATE budget_delegations SET worker = ?, delegation_json = ?, delegation_hash = ? WHERE task_id = ?',
      st.provider, delegationJson(x), hash, input.taskId,
    )
    const delegator = st.ctx.deployment.delegation.delegator
    const current = await sdk.delegationOf(st.ctx.publicClient, st.terms.creator)
    return {
      taskId: input.taskId,
      delegationHash: hash,
      sign: { description: `Grant the execution budget to ${st.provider}`, typedData: delegationTypedData(st.ctx.deployment, x) },
      upgrade: eq(current, delegator)
        ? null
        : { delegator, why: 'Your wallet must point at the DeleGator (EIP-7702) before the worker can draw: one transaction to yourself, with an authorization for this address.' },
      next: 'Send the upgrade first if asked, then sign `sign.typedData` and pass the signature to budget_grant_confirm.',
    }
  }

  /** Records the creator's signature over the prepared delegation; the worker can draw from now on. */
  async grantConfirm(me: Address, input: { taskId: string; signature: string }) {
    const st = await this.#deps.taskState(input.taskId)
    this.#creatorOnly(st, me, 'grants')
    const b = this.#budget(st)
    const row = await this.#endIfOver(this.#row(input.taskId), st, b)
    if (row.status !== 'promised') throw this.#deps.fail('conflict', `this budget is ${row.status}`)
    if (row.delegation_json === null) throw this.#deps.fail('conflict', 'start with budget_grant_prepare')
    if (!isHex(input.signature)) throw this.#deps.fail('invalid', 'signature must be hex')
    const x = parseDelegation(row.delegation_json)
    const signer = await recoverAddress({ hash: delegationDigest(st.ctx.deployment, x), signature: input.signature }).catch(() => null)
    if (!eq(signer, st.terms.creator)) throw this.#deps.fail('invalid', 'the signature is not the creator’s over the prepared delegation')
    const current = await sdk.delegationOf(st.ctx.publicClient, st.terms.creator)
    if (!eq(current, st.ctx.deployment.delegation.delegator)) {
      throw this.#deps.fail('conflict', `your wallet does not point at the DeleGator (${st.ctx.deployment.delegation.delegator}) yet: send the upgrade from budget_grant_prepare first`)
    }
    if (await isDisabled(st.ctx, row.delegation_hash as Hex)) throw this.#deps.fail('conflict', 'this delegation was disabled on-chain')
    this.#deps.sql.run(
      "UPDATE budget_delegations SET status = 'live', signature = ?, live_at = ? WHERE task_id = ? AND status = 'promised'",
      input.signature, this.#deps.now(), input.taskId,
    )
    return this.getBudget(me, { taskId: input.taskId })
  }

  /**
   * The creator withdraws the budget: the board stops preparing draws at once, and `transactions` disables the
   * delegation on-chain (from the creator's wallet). Until that is mined the worker can still redeem it directly.
   */
  async revoke(me: Address, input: { taskId: string }) {
    const st = await this.#deps.taskState(input.taskId)
    this.#creatorOnly(st, me, 'revokes')
    const row = this.#row(input.taskId)
    if (row.status === 'promised' || row.status === 'live') {
      this.#deps.sql.run("UPDATE budget_delegations SET status = 'revoked', ended_at = ?, ended_reason = 'revoked by the creator' WHERE task_id = ?", this.#deps.now(), input.taskId)
    }
    const transactions =
      row.delegation_json !== null && !(await isDisabled(st.ctx, row.delegation_hash as Hex))
        ? [this.#tx(st, 'Disable the execution-budget delegation', disableCalldata(parseDelegation(row.delegation_json)))]
        : []
    return {
      ...(await this.getBudget(me, input)),
      transactions,
      next: transactions.length === 0 ? 'Nothing was ever signed for the worker, so nothing is left to disable.' : 'Send it from your wallet: until it is mined the worker can still redeem the delegation.',
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Everyone involved: read; worker: draw
  // ---------------------------------------------------------------------------------------------

  async getBudget(me: Address, input: { taskId: string }) {
    const st = await this.#deps.taskState(input.taskId)
    if (![st.terms.creator, st.terms.approver, st.provider].some((p) => eq(p, me))) {
      throw this.#deps.fail('forbidden', 'only the creator, the approver and the worker see the budget')
    }
    const b = this.#budget(st)
    const row = await this.#endIfOver(this.#row(input.taskId), st, b)
    const hash = row.delegation_hash as Hex | null
    const draws = this.#deps.sql.all<BudgetDrawRow>('SELECT * FROM budget_draws WHERE task_id = ? ORDER BY created_at, rowid', input.taskId)
    const [symbol, decimals] =
      b.kind === 'call'
        ? [nativeSymbol(st.ctx), 18]
        : await Promise.all([
            st.ctx.publicClient.readContract({ address: b.token, abi: sdk.factoryTokenAbi, functionName: 'symbol' }),
            st.ctx.publicClient.readContract({ address: b.token, abi: sdk.factoryTokenAbi, functionName: 'decimals' }),
          ])
    const fmt = (x: bigint) => formatUnits(x, decimals)
    let used: bigint
    let calls: { made: number; allowed: 1 } | undefined
    if (b.kind === 'advance') {
      used = hash === null ? 0n : await drawn(st.ctx, hash)
    } else {
      calls = { made: hash === null ? 0 : Number(await callsMade(st.ctx, hash)), allowed: 1 }
      used = draws.filter((d) => d.status === 'confirmed' && d.amount !== null).reduce((s, d) => s + BigInt(d.amount as string), 0n)
    }
    const signed = row.signature !== null && (eq(me, st.terms.creator) || eq(me, row.worker))
    // The chain's view, whatever the board's status: a signed delegation stays redeemable until it expires or the
    // creator disables it, even after the board ended the budget because the job settled.
    const redeemable = row.signature !== null && this.#deps.now() < b.expiresAt && !(await isDisabled(st.ctx, hash as Hex))
    return {
      taskId: input.taskId,
      ...(b.kind === 'call' ? { kind: 'call' as const, target: b.target, function: b.function } : { kind: 'advance' as const, token: b.token }),
      symbol,
      cap: fmt(b.cap),
      /** An advance: what the enforcer has counted on-chain. A call: the value of the calls the board saw. */
      drawn: fmt(used),
      remaining: fmt(b.cap > used ? b.cap - used : 0n),
      ...(calls === undefined ? {} : { calls }),
      expiresAt: b.expiresAt,
      status: row.status,
      endedReason: row.ended_reason,
      enforcement: 'on-chain delegation (MetaMask Delegation Framework, ERC-7710)',
      redeemable,
      worker: row.worker,
      draws: draws.map((d) => ({
        drawId: d.id,
        amount: d.amount === null ? null : fmt(BigInt(d.amount)),
        ...(d.call_data === null ? {} : { selector: d.call_data.slice(0, 10) }),
        note: d.note,
        status: d.status,
        txHash: d.tx_hash,
        at: d.created_at,
      })),
      /** The signed delegation: redeem it at `manager` with `redeemDelegations`, with or without the board. */
      delegation: signed && row.delegation_json !== null ? { manager: st.ctx.deployment.delegation.manager, delegation: { ...JSON.parse(row.delegation_json), signature: row.signature } } : null,
    }
  }

  /** The checks every draw shares: the caller is the activated worker, the grant is live, the job active, the core not paused. */
  async #drawable(me: Address, st: BudgetTaskState) {
    const b = this.#budget(st)
    if (!eq(st.provider, me)) throw this.#deps.fail('forbidden', 'only the job’s activated worker draws its execution budget')
    const row = await this.#endIfOver(this.#row(st.task.id), st, b)
    if (row.status !== 'live') {
      throw this.#deps.fail('conflict', row.status === 'promised' ? 'the creator has not granted this budget yet' : `this budget is ${row.status}${row.ended_reason === null ? '' : ` (${row.ended_reason})`}`)
    }
    if (st.status !== 'active') throw this.#deps.fail('conflict', `drawing is only while the job is active (it is ${st.status})`)
    const paused = await st.ctx.publicClient.readContract({ address: st.ctx.deployment.core, abi: sdk.coreAbi, functionName: 'paused' })
    if (paused) throw this.#deps.fail('conflict', 'the core is paused; nothing moves until it is unpaused')
    const signed = { ...parseDelegation(row.delegation_json as string), signature: row.signature as Hex }
    return { b, row, signed }
  }

  #prepareDraw(taskId: string, worker: Address, amount: bigint, callData: Hex | null, redeemData: Hex, note: string): string {
    const id = randomId()
    const now = this.#deps.now()
    this.#deps.sql.run(
      "INSERT INTO budget_draws (id, task_id, worker, amount, call_data, redeem_data, note, status, tx_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', NULL, ?, ?)",
      id, taskId, worker, amount.toString(), callData, redeemData.toLowerCase(), note, now, now,
    )
    return id
  }

  /**
   * An advance draw: `amount` of the budget token from the creator's wallet to the worker's. Returns the
   * `redeemDelegations` transaction for the worker to send and report; refused when the enforcer's count says it
   * would not fit.
   */
  async spend(me: Address, input: { taskId: string; amount: string; note?: string }) {
    const st = await this.#deps.taskState(input.taskId)
    const { b, row, signed } = await this.#drawable(me, st)
    if (b.kind !== 'advance') throw this.#deps.fail('invalid', 'this is a call budget: use spend_budget_call')
    const advance: AdvanceBudget = b
    const decimals = await st.ctx.publicClient.readContract({ address: advance.token, abi: sdk.factoryTokenAbi, functionName: 'decimals' })
    let amount: bigint
    try {
      amount = parseUnits(input.amount, decimals)
    } catch {
      throw this.#deps.fail('invalid', 'amount must be a decimal number')
    }
    if (amount <= 0n) throw this.#deps.fail('invalid', 'the amount must be positive')
    const used = await drawn(st.ctx, row.delegation_hash as Hex)
    if (used + amount > advance.cap) {
      throw this.#deps.fail('conflict', `over the budget: ${formatUnits(advance.cap - used, decimals)} left of ${formatUnits(advance.cap, decimals)}`)
    }
    const data = redeemCalldata(signed, advanceExecution(advance.token, me, amount))
    const drawId = this.#prepareDraw(input.taskId, me, amount, null, data, input.note ?? '')
    return {
      drawId,
      transactions: [this.#tx(st, `Draw ${input.amount} from the execution budget`, data)],
      next: 'Send it from your wallet, then report_transaction({taskId, txHash}). The enforcer caps the total on-chain.',
    }
  }

  /**
   * A call budget's one call: `data` for the allowed function, sent from the creator's account with `value` (native,
   * decimal). Returns the `redeemDelegations` transaction for the worker to send and report.
   */
  async spendCall(me: Address, input: { taskId: string; data: string; value?: string; note?: string }) {
    const st = await this.#deps.taskState(input.taskId)
    const { b, row, signed } = await this.#drawable(me, st)
    if (b.kind !== 'call') throw this.#deps.fail('invalid', 'this is an advance: use spend_budget')
    const call: CallBudget = b
    const selector = toFunctionSelector(callFunction(call))
    if (!isHex(input.data) || input.data.length < 10 || input.data.slice(0, 10).toLowerCase() !== selector) {
      throw this.#deps.fail('invalid', `data must be calldata for ${call.function} (selector ${selector})`)
    }
    let value: bigint
    try {
      value = parseUnits(input.value ?? '0', 18)
    } catch {
      throw this.#deps.fail('invalid', 'value must be a decimal amount of the native token')
    }
    if (value < 0n) throw this.#deps.fail('invalid', 'value must not be negative')
    if (value > call.cap) throw this.#deps.fail('conflict', `the call may send at most ${formatUnits(call.cap, 18)} ${nativeSymbol(st.ctx)}`)
    if ((await callsMade(st.ctx, row.delegation_hash as Hex)) >= 1n) throw this.#deps.fail('conflict', 'the one allowed call was already made')
    const data = redeemCalldata(signed, { target: call.target, value, callData: input.data })
    const drawId = this.#prepareDraw(input.taskId, me, value, input.data.toLowerCase() as Hex, data, input.note ?? '')
    return {
      drawId,
      transactions: [this.#tx(st, `Call ${callFunction(call).name} from the creator's account`, data)],
      next: 'Send it from your wallet, then report_transaction({taskId, txHash}); read the receipt for what the call made.',
    }
  }

  /**
   * Mirrors a reported transaction that redeemed this task's delegation. A transaction whose input is a prepared
   * draw's calldata is that draw (the oldest, when two were prepared alike): confirmed, or failed when it reverted.
   * A redemption the board did not prepare (sent directly, or inside a batch) is recorded as one.
   */
  async observe(st: Pick<BudgetTaskState, 'task' | 'terms' | 'ctx'>, receipt: TransactionReceipt): Promise<void> {
    const b = st.terms.executionBudget
    if (b === undefined) return
    const [row] = this.#deps.sql.all<BudgetDelegationRow>('SELECT * FROM budget_delegations WHERE task_id = ?', st.task.id)
    if (row === undefined || row.delegation_hash === null || row.worker === null) return
    if (this.#deps.sql.all<BudgetDrawRow>('SELECT id FROM budget_draws WHERE task_id = ? AND tx_hash = ?', st.task.id, receipt.transactionHash).length > 0) return
    const ok = receipt.status === 'success'
    if (ok && !this.#redeemed(st, receipt)) return
    const tx = await st.ctx.publicClient.getTransaction({ hash: receipt.transactionHash })
    const [prepared] = this.#deps.sql.all<BudgetDrawRow>(
      "SELECT * FROM budget_draws WHERE task_id = ? AND status = 'prepared' AND redeem_data = ? ORDER BY created_at, rowid LIMIT 1",
      st.task.id, tx.input.toLowerCase(),
    )
    const now = this.#deps.now()
    if (!ok) {
      if (prepared !== undefined && eq(tx.from, row.worker)) {
        this.#deps.sql.run("UPDATE budget_draws SET status = 'failed', tx_hash = ?, updated_at = ? WHERE id = ?", receipt.transactionHash, now, prepared.id)
      }
      return
    }
    const amount = b.kind === 'advance' ? this.#transferred(receipt, b.token, st.terms.creator, row.worker) : prepared?.amount ?? this.#callValue(st, tx)
    if (prepared !== undefined) {
      this.#deps.sql.run("UPDATE budget_draws SET status = 'confirmed', tx_hash = ?, amount = ?, updated_at = ? WHERE id = ?", receipt.transactionHash, amount, now, prepared.id)
    } else {
      this.#deps.sql.run(
        "INSERT INTO budget_draws (id, task_id, worker, amount, call_data, redeem_data, note, status, tx_hash, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, 'redeemed without the board', 'confirmed', ?, ?, ?)",
        randomId(), st.task.id, row.worker, amount, receipt.transactionHash, now, now,
      )
    }
  }

  /** The receipt carries the manager's `RedeemedDelegation` for this task's delegation (salt = termsHash, the creator). */
  #redeemed(st: Pick<BudgetTaskState, 'task' | 'terms' | 'ctx'>, receipt: TransactionReceipt): boolean {
    const manager = st.ctx.deployment.delegation.manager
    return receipt.logs.some((l) => {
      if (!eq(l.address, manager)) return false
      try {
        const event = decodeEventLog({ abi: delegationManagerAbi, data: l.data, topics: l.topics })
        return event.eventName === 'RedeemedDelegation' && event.args.delegation.salt === BigInt(st.task.terms_hash) && eq(event.args.delegation.delegator, st.terms.creator)
      } catch {
        return false
      }
    })
  }

  /** What an advance redemption moved: the budget token's transfers from the creator to the worker in that receipt. */
  #transferred(receipt: TransactionReceipt, token: Address, creator: Address, worker: string): string {
    let total = 0n
    for (const l of receipt.logs) {
      if (!eq(l.address, token)) continue
      try {
        const e = decodeEventLog({ abi: erc20Abi, data: l.data, topics: l.topics })
        if (e.eventName === 'Transfer' && eq(e.args.from, creator) && eq(e.args.to, worker)) total += e.args.value
      } catch {
        // another event
      }
    }
    return total.toString()
  }

  /** A call redemption's value, when the worker sent it straight to the manager (null inside a batch). */
  #callValue(st: Pick<BudgetTaskState, 'ctx'>, tx: { to: Address | null; input: Hex }): string | null {
    if (tx.to === null || !eq(tx.to, st.ctx.deployment.delegation.manager)) return null
    const { args } = decodeFunctionData({ abi: delegationManagerAbi, data: tx.input })
    const execution = (args as unknown as [Hex[], Hex[], Hex[]])[2][0]
    return execution === undefined ? null : BigInt(`0x${execution.slice(42, 106)}`).toString()
  }
}
