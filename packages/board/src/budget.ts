/**
 * Execution budget (ADR-0005): the worker spends from the creator's Privy embedded wallet through the board's signer.
 *
 * - Privy enforces, per transaction, what the creator's policy allows: this chain, the budget token's `transfer`, no
 *   value, at most the cap, before the expiry. The policy is person-owned, so the board cannot widen it. It is never
 *   edited: a change is a fresh policy that the creator's browser attaches the signer under (remove, then add).
 * - The board enforces what Privy cannot: the cumulative cap (the `budget_spends` ledger), that the caller is the
 *   job's activated worker, that the job is active and the core not paused, and revocation (immediate).
 * - Nothing is escrowed: spent is spent, the rest never left the creator's wallet.
 *
 * At most one economic effect per spend (R114-07): the ledger row is written before Privy is called, with the row id
 * as Privy's idempotency key, and reconciled from the chain (receipt) afterwards.
 */
import * as sdk from '@agent-jobs/sdk'
import { type Address, type Hex, encodeFunctionData, erc20Abi, formatUnits, getAddress, isAddress, parseUnits, zeroAddress } from 'viem'
import { budgetPolicyBody, budgetRuleName, type BudgetRuleInput } from './budget-policy.ts'
import { PrivyApiError, type PrivyApp, privyFetch, signedPrivyFetch, verifyAccessToken } from './privy.ts'
import type { BudgetGrantRow, BudgetSpendRow, BudgetWalletRow, Sql, TaskRow } from './store.ts'
import type { OfferTerms } from './terms.ts'

export interface BudgetConfig {
  readonly app: PrivyApp
  /** The board signer's base64 PKCS#8 P-256 key; its public half is `signerQuorumId` at Privy. */
  readonly signerKey: string
  readonly signerQuorumId: string
  /** Injected in tests; Privy's API otherwise. */
  readonly fetch?: typeof fetch
}

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

/** Chain statuses after which nothing may be spent: the job is settled or can no longer be delivered. */
const OVER = new Set(['completed', 'rejected', 'cancelled', 'expired', 'lapsed'])

const eq = (a: string | null | undefined, b: string | null | undefined) =>
  a !== null && a !== undefined && b !== null && b !== undefined && a.toLowerCase() === b.toLowerCase()

function randomId(bytes = 8): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

interface PrivyWallet {
  id: string
  address: string
  additional_signers?: Array<{ signer_id: string; override_policy_ids?: string[] }>
}

interface PrivyPolicy {
  id: string
  rules: Array<{ name: string; conditions: Array<{ field: string; value: string }> }>
}

interface PrivyUser {
  id: string
  linked_accounts: Array<{ type: string; address?: string; chain_type?: string; wallet_client?: string; wallet_client_type?: string; id?: string | null }>
}

export class BudgetDesk {
  readonly #deps: BudgetDeps
  readonly #config: BudgetConfig | undefined

  constructor(deps: BudgetDeps, config: BudgetConfig | undefined) {
    this.#deps = deps
    this.#config = config
  }

  #cfg(): BudgetConfig {
    if (this.#config === undefined) throw this.#deps.fail('conflict', 'execution budgets are unavailable on this board (no Privy signer configured)')
    return this.#config
  }

  #fetch(): typeof fetch {
    return this.#config?.fetch ?? fetch
  }

  #grant(taskId: string): BudgetGrantRow {
    const [g] = this.#deps.sql.all<BudgetGrantRow>('SELECT * FROM budget_grants WHERE task_id = ?', taskId)
    if (g === undefined) throw this.#deps.fail('not-found', `task ${taskId} has no execution budget`)
    return g
  }

  #wallet(address: string): BudgetWalletRow | undefined {
    return this.#deps.sql.all<BudgetWalletRow>('SELECT * FROM budget_wallets WHERE lower(address) = lower(?)', address)[0]
  }

  /**
   * Grants whose rules the creator's policy should hold: the live, unexpired ones, plus `granting` (the one being
   * granted now). A merely promised budget is never authorised by granting another.
   */
  #activeGrants(creator: string, chainId: number, granting?: string): BudgetRuleInput[] {
    return this.#deps.sql
      .all<BudgetGrantRow>(
        "SELECT * FROM budget_grants WHERE lower(creator) = lower(?) AND (status = 'live' OR (status = 'promised' AND task_id = ?)) AND expires_at > ?",
        creator,
        granting ?? '',
        this.#deps.now(),
      )
      .map((g) => ({ taskId: g.task_id, chainId, token: getAddress(g.token), cap: BigInt(g.cap), expiresAt: g.expires_at }))
  }

  /** Ends a grant whose job settled or whose time ran out; the board stops signing for it at once. */
  #endIfOver(g: BudgetGrantRow, st: BudgetTaskState): BudgetGrantRow {
    if (g.status === 'ended' || g.status === 'revoked') return g
    const reason = OVER.has(st.status) ? `job ${st.status}` : this.#deps.now() >= g.expires_at ? 'expired' : null
    if (reason === null) return g
    this.#deps.sql.run("UPDATE budget_grants SET status = 'ended', ended_at = ?, ended_reason = ? WHERE task_id = ?", this.#deps.now(), reason, g.task_id)
    return { ...g, status: 'ended', ended_at: this.#deps.now(), ended_reason: reason }
  }

  #ledger(taskId: string): { spent: bigint; reserved: bigint } {
    const rows = this.#deps.sql.all<BudgetSpendRow>("SELECT * FROM budget_spends WHERE task_id = ? AND status != 'failed'", taskId)
    let spent = 0n
    let reserved = 0n
    for (const r of rows) {
      if (r.status === 'confirmed') spent += BigInt(r.amount)
      else reserved += BigInt(r.amount)
    }
    return { spent, reserved }
  }

  async #privyWallet(walletId: string): Promise<PrivyWallet> {
    return privyFetch<PrivyWallet>(this.#cfg().app, { method: 'GET', path: `/wallets/${walletId}` }, this.#fetch())
  }

  /** The policy id the board's signer is attached under on this wallet, or null when it is not a signer. */
  #attachedPolicy(w: PrivyWallet): string | null | undefined {
    const s = (w.additional_signers ?? []).find((x) => x.signer_id === this.#cfg().signerQuorumId)
    return s === undefined ? undefined : (s.override_policy_ids?.[0] ?? null)
  }



  // ---------------------------------------------------------------------------------------------
  // Creator: grant, revoke
  // ---------------------------------------------------------------------------------------------

  /** A fresh person-owned policy holding exactly these grants; never edited afterwards. */
  async #freshPolicy(me: Address, did: string, grants: BudgetRuleInput[]): Promise<string> {
    const body = budgetPolicyBody(me, grants, did)
    const policy = await privyFetch<{ id: string }>(
      this.#cfg().app,
      { method: 'POST', path: '/policies', body, idempotencyKey: `aj-policy-${me.toLowerCase()}-${sdk.hashText(JSON.stringify(body)).slice(2, 18)}` },
      this.#fetch(),
    )
    this.#deps.sql.run('UPDATE budget_wallets SET policy_id = ?, updated_at = ? WHERE address = ?', policy.id, this.#deps.now(), me.toLowerCase())
    return policy.id
  }

  /**
   * Step 1 of a grant, from the creator's browser with a Privy access token. Finds the creator's embedded wallet
   * (it must be the signed-in wallet) and answers with the browser step still needed:
   * - `add-signer`: the board's signer is not on the wallet; a fresh person-owned policy holding the live grants and
   *   this one was created, and the browser adds the signer under it (`useSigners().addSigners`);
   * - `replace-signer`: the signer is on the wallet under a policy without this grant; the same fresh policy, and the
   *   browser removes the signer, then adds it under the new policy (Privy has one policy per signer);
   * - `confirm`: the policy already holds this grant.
   * Then `budget_grant_confirm`, which checks all of it at Privy.
   */
  async grantPrepare(me: Address, input: { taskId: string; privyAccessToken: string }) {
    const cfg = this.#cfg()
    const st = await this.#deps.taskState(input.taskId)
    if (!eq(st.terms.creator, me)) throw this.#deps.fail('forbidden', 'only the creator grants the execution budget')
    const g = this.#endIfOver(this.#grant(input.taskId), st)
    if (g.status === 'ended' || g.status === 'revoked') throw this.#deps.fail('conflict', `this budget is ${g.status}${g.ended_reason === null ? '' : ` (${g.ended_reason})`}`)
    let did: string
    try {
      did = await verifyAccessToken(cfg.app.appId, input.privyAccessToken, this.#deps.now(), this.#fetch())
    } catch (e) {
      throw this.#deps.fail('unauthenticated', `the Privy access token was refused: ${(e as Error).message}`)
    }
    const user = await privyFetch<PrivyUser>(cfg.app, { method: 'GET', path: `/users/${encodeURIComponent(did)}` }, this.#fetch())
    const embedded = user.linked_accounts.find(
      (a) =>
        a.type === 'wallet' &&
        a.chain_type === 'ethereum' &&
        (a.wallet_client === 'privy' || a.wallet_client_type === 'privy') &&
        typeof a.id === 'string' &&
        eq(a.address, me),
    )
    if (embedded === undefined || typeof embedded.id !== 'string') {
      throw this.#deps.fail('forbidden', 'an execution budget is granted from the Privy email/Google wallet that created the task; this signed-in wallet is not one')
    }
    const walletId = embedded.id
    this.#deps.sql.run(
      `INSERT INTO budget_wallets (address, privy_user_id, wallet_id, policy_id, updated_at) VALUES (?, ?, ?, NULL, ?)
       ON CONFLICT (address) DO UPDATE SET privy_user_id = excluded.privy_user_id, wallet_id = excluded.wallet_id, updated_at = excluded.updated_at`,
      me.toLowerCase(), did, walletId, this.#deps.now(),
    )
    const attached = this.#attachedPolicy(await this.#privyWallet(walletId))
    if (typeof attached === 'string') {
      const policy = await privyFetch<PrivyPolicy>(cfg.app, { method: 'GET', path: `/policies/${attached}` }, this.#fetch())
      if (policy.rules.some((r) => r.name === budgetRuleName(input.taskId))) {
        this.#deps.sql.run('UPDATE budget_wallets SET policy_id = ?, updated_at = ? WHERE address = ?', attached, this.#deps.now(), me.toLowerCase())
        return { step: 'confirm' as const, address: me, walletId, policyId: attached, next: 'budget_grant_confirm({taskId}).' }
      }
    }
    const policyId = await this.#freshPolicy(me, did, this.#activeGrants(me, st.ctx.deployment.chainId, input.taskId))
    return {
      step: attached === undefined ? ('add-signer' as const) : ('replace-signer' as const),
      address: me,
      walletId,
      signerId: cfg.signerQuorumId,
      policyId,
      next:
        attached === undefined
          ? 'In the browser: addSigners({address, signers: [{signerId, policyIds: [policyId]}]}), then budget_grant_confirm({taskId}).'
          : 'In the browser: removeSigners({address}), then addSigners({address, signers: [{signerId, policyIds: [policyId]}]}), then budget_grant_confirm({taskId}).',
    }
  }

  /** Step 2 of a grant: checks at Privy that the board's signer is on the wallet under a policy holding this grant. */
  async grantConfirm(me: Address, input: { taskId: string }) {
    const cfg = this.#cfg()
    const st = await this.#deps.taskState(input.taskId)
    if (!eq(st.terms.creator, me)) throw this.#deps.fail('forbidden', 'only the creator grants the execution budget')
    const g = this.#endIfOver(this.#grant(input.taskId), st)
    if (g.status === 'ended' || g.status === 'revoked') throw this.#deps.fail('conflict', `this budget is ${g.status}`)
    const w = this.#wallet(me)
    if (w === undefined) throw this.#deps.fail('conflict', 'start with budget_grant_prepare')
    const attached = this.#attachedPolicy(await this.#privyWallet(w.wallet_id))
    if (attached === undefined || attached === null) {
      throw this.#deps.fail('conflict', "the board's signer is not on your wallet yet: addSigners in the browser, then confirm again")
    }
    const policy = await privyFetch<PrivyPolicy>(cfg.app, { method: 'GET', path: `/policies/${attached}` }, this.#fetch())
    if (!policy.rules.some((r) => r.name === budgetRuleName(input.taskId))) {
      throw this.#deps.fail('conflict', 'the signer on your wallet is under a policy without this budget: replace it (budget_grant_prepare)')
    }
    if (g.status === 'promised') {
      this.#deps.sql.run("UPDATE budget_grants SET status = 'live', live_at = ? WHERE task_id = ? AND status = 'promised'", this.#deps.now(), input.taskId)
    }
    this.#deps.sql.run('UPDATE budget_wallets SET policy_id = ?, updated_at = ? WHERE address = ?', attached, this.#deps.now(), me.toLowerCase())
    return this.getBudget(me, { taskId: input.taskId })
  }

  /**
   * The creator withdraws the budget. The board stops signing for it at once; the answer's `cleanup` says how to take
   * the rule off the wallet too (remove the signer when nothing else is live, else re-attach it under a smaller policy).
   */
  async revoke(me: Address, input: { taskId: string }) {
    const st = await this.#deps.taskState(input.taskId)
    if (!eq(st.terms.creator, me)) throw this.#deps.fail('forbidden', 'only the creator revokes the execution budget')
    const g = this.#grant(input.taskId)
    if (g.status === 'promised' || g.status === 'live') {
      this.#deps.sql.run("UPDATE budget_grants SET status = 'revoked', ended_at = ?, ended_reason = 'revoked by the creator' WHERE task_id = ?", this.#deps.now(), input.taskId)
    }
    return { ...(await this.getBudget(me, input)), next: 'The board no longer signs for this budget. Follow `cleanup` to take it off your wallet too.' }
  }

  /** What the creator should do on the wallet once grants end: nothing, remove the signer, or re-attach it under a smaller policy. */
  async #cleanup(me: Address, chainId: number) {
    const w = this.#wallet(me)
    if (w === undefined || this.#config === undefined) return null
    const attached = this.#attachedPolicy(await this.#privyWallet(w.wallet_id))
    if (typeof attached !== 'string') return null
    const active = this.#activeGrants(me, chainId)
    if (active.length === 0) return { removeSigners: true as const, address: me, why: 'no budget of yours is active: remove the board’s signer from your wallet' }
    const policy = await privyFetch<PrivyPolicy>(this.#cfg().app, { method: 'GET', path: `/policies/${attached}` }, this.#fetch())
    const keep = new Set(active.map((a) => budgetRuleName(a.taskId)))
    if (policy.rules.every((r) => keep.has(r.name))) return null
    const policyId = await this.#freshPolicy(me, w.privy_user_id, active)
    return {
      replaceSigner: { address: me, signerId: this.#cfg().signerQuorumId, policyId },
      why: 'your wallet’s policy still allows ended budgets: removeSigners, then addSigners under this smaller policy',
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Everyone involved: read; worker: spend
  // ---------------------------------------------------------------------------------------------

  async getBudget(me: Address, input: { taskId: string }) {
    const st = await this.#deps.taskState(input.taskId)
    const parties = [st.terms.creator, st.terms.approver, st.provider]
    if (!parties.some((p) => eq(p, me))) throw this.#deps.fail('forbidden', 'only the creator, the approver and the worker see the budget')
    const b = st.terms.executionBudget
    if (b === undefined) throw this.#deps.fail('not-found', `task ${input.taskId} has no execution budget`)
    const g = this.#endIfOver(this.#grant(input.taskId), st)
    await this.#reconcile(st, g)
    const [symbol, decimals] = await Promise.all([
      st.ctx.publicClient.readContract({ address: b.token, abi: sdk.factoryTokenAbi, functionName: 'symbol' }),
      st.ctx.publicClient.readContract({ address: b.token, abi: sdk.factoryTokenAbi, functionName: 'decimals' }),
    ])
    const { spent, reserved } = this.#ledger(input.taskId)
    const fmt = (x: bigint) => formatUnits(x, decimals)
    const spends = this.#deps.sql.all<BudgetSpendRow>('SELECT * FROM budget_spends WHERE task_id = ? ORDER BY created_at', input.taskId)
    const isCreator = eq(st.terms.creator, me)
    return {
      taskId: input.taskId,
      token: b.token,
      symbol,
      cap: fmt(b.cap),
      spent: fmt(spent),
      reserved: fmt(reserved),
      remaining: fmt(b.cap - spent - reserved > 0n ? b.cap - spent - reserved : 0n),
      expiresAt: b.expiresAt,
      status: g.status,
      endedReason: g.ended_reason,
      spends: spends.map((r) => ({ spendId: r.id, to: r.to_addr, amount: fmt(BigInt(r.amount)), note: r.note, status: r.status, txHash: r.tx_hash, at: r.created_at })),
      cleanup: isCreator && (g.status === 'ended' || g.status === 'revoked') ? await this.#cleanup(me, st.ctx.deployment.chainId) : null,
    }
  }

  /** Settles the ledger against the chain: receipts for sent spends; a spend whose Privy answer was lost is asked again under the same key. */
  async #reconcile(st: BudgetTaskState, g: BudgetGrantRow): Promise<void> {
    const rows = this.#deps.sql.all<BudgetSpendRow>("SELECT * FROM budget_spends WHERE task_id = ? AND status IN ('reserved', 'sent')", g.task_id)
    for (const r of rows) {
      if (r.status === 'sent' && r.tx_hash !== null) {
        const receipt = await st.ctx.publicClient.getTransactionReceipt({ hash: r.tx_hash as Hex }).catch(() => null)
        if (receipt === null) continue
        this.#deps.sql.run('UPDATE budget_spends SET status = ?, updated_at = ? WHERE id = ?', receipt.status === 'success' ? 'confirmed' : 'failed', this.#deps.now(), r.id)
      } else if (r.status === 'reserved' && g.status === 'live' && this.#deps.now() - r.updated_at >= 30) {
        // The answer was lost after Privy was called: the same idempotency key returns the original send, or sends it
        // now (the amount is already reserved against the cap). A grant no longer live keeps the reservation.
        await this.#send(st, r).catch(() => undefined)
      }
    }
  }

  async #send(st: BudgetTaskState, row: BudgetSpendRow): Promise<Hex> {
    const cfg = this.#cfg()
    const w = this.#wallet(st.terms.creator)
    if (w === undefined) throw this.#deps.fail('conflict', 'the creator has not granted this budget')
    const token = (st.terms.executionBudget as { token: Address }).token
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [row.to_addr as Address, BigInt(row.amount)] })
    try {
      const res = await signedPrivyFetch<{ data: { hash: Hex } }>(
        cfg.app,
        cfg.signerKey,
        {
          method: 'POST',
          path: `/wallets/${w.wallet_id}/rpc`,
          body: { method: 'eth_sendTransaction', caip2: `eip155:${st.ctx.deployment.chainId}`, params: { transaction: { to: token, data, value: '0x0' } } },
          idempotencyKey: `aj-spend-${row.id}`,
        },
        this.#fetch(),
      )
      this.#deps.sql.run("UPDATE budget_spends SET status = 'sent', tx_hash = ?, detail = NULL, updated_at = ? WHERE id = ?", res.data.hash, this.#deps.now(), row.id)
      return res.data.hash
    } catch (e) {
      if (e instanceof PrivyApiError && e.status >= 400 && e.status < 500) {
        // Privy refused before anything was sent (policy, missing signer, gas): the reservation is released.
        this.#deps.sql.run("UPDATE budget_spends SET status = 'failed', detail = ?, updated_at = ? WHERE id = ?", e.body.slice(0, 500), this.#deps.now(), row.id)
        throw this.#deps.fail('conflict', `Privy refused the spend (nothing was sent): ${e.body.slice(0, 200)}`)
      }
      this.#deps.sql.run('UPDATE budget_spends SET detail = ?, updated_at = ? WHERE id = ?', `outcome unknown: ${(e as Error).message.slice(0, 300)}`, this.#deps.now(), row.id)
      throw this.#deps.fail('chain', 'the spend’s outcome is unknown; it stays reserved and get_budget reconciles it (never re-send it yourself)')
    }
  }

  /**
   * The worker spends from the budget: an ERC-20 transfer of the budget token to `to` (anyone), paid from the
   * creator's wallet. Refused unless the caller is the job's activated worker, the job is active (before submission),
   * the core is not paused, the grant is live and unexpired, and the ledger has room for the amount.
   */
  async spend(me: Address, input: { taskId: string; to: string; amount: string; note?: string }) {
    this.#cfg()
    const st = await this.#deps.taskState(input.taskId)
    const b = st.terms.executionBudget
    if (b === undefined) throw this.#deps.fail('not-found', `task ${input.taskId} has no execution budget`)
    if (!eq(st.provider, me)) throw this.#deps.fail('forbidden', 'only the job’s activated worker spends its execution budget')
    const g = this.#endIfOver(this.#grant(input.taskId), st)
    if (g.status !== 'live') {
      throw this.#deps.fail('conflict', g.status === 'promised' ? 'the creator has not granted this budget yet' : `this budget is ${g.status}${g.ended_reason === null ? '' : ` (${g.ended_reason})`}`)
    }
    if (st.status !== 'active') throw this.#deps.fail('conflict', `spending is only while the job is active (it is ${st.status})`)
    const now = this.#deps.now()
    if (now >= Math.min(b.expiresAt, st.terms.deliveryDeadline)) throw this.#deps.fail('conflict', 'the budget has expired')
    const paused = await st.ctx.publicClient.readContract({ address: st.ctx.deployment.core, abi: sdk.coreAbi, functionName: 'paused' })
    if (paused) throw this.#deps.fail('conflict', 'the core is paused; nothing moves until it is unpaused')
    if (!isAddress(input.to) || eq(input.to, zeroAddress)) throw this.#deps.fail('invalid', '`to` must be a non-zero address')
    const decimals = await st.ctx.publicClient.readContract({ address: b.token, abi: sdk.factoryTokenAbi, functionName: 'decimals' })
    let amount: bigint
    try {
      amount = parseUnits(input.amount, decimals)
    } catch {
      throw this.#deps.fail('invalid', 'amount must be a decimal number')
    }
    if (amount <= 0n) throw this.#deps.fail('invalid', 'the amount must be positive')
    // Checked and reserved with no await in between: two concurrent spends cannot both fit.
    const { spent, reserved } = this.#ledger(input.taskId)
    if (spent + reserved + amount > b.cap) {
      throw this.#deps.fail('conflict', `over the budget: ${formatUnits(b.cap - spent - reserved, decimals)} left of ${formatUnits(b.cap, decimals)}`)
    }
    const row: BudgetSpendRow = {
      id: randomId(),
      task_id: input.taskId,
      worker: me,
      to_addr: getAddress(input.to),
      amount: amount.toString(),
      note: input.note ?? '',
      status: 'reserved',
      tx_hash: null,
      detail: null,
      created_at: now,
      updated_at: now,
    }
    this.#deps.sql.run(
      "INSERT INTO budget_spends (id, task_id, worker, to_addr, amount, note, status, tx_hash, detail, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'reserved', NULL, NULL, ?, ?)",
      row.id, row.task_id, row.worker, row.to_addr, row.amount, row.note, now, now,
    )
    const hash = await this.#send(st, row)
    return { spendId: row.id, txHash: hash, status: 'sent', next: 'get_budget shows it confirmed once the transfer is mined.' }
  }

  /** The grant's state for the task view: whether a worker can rely on it yet. */
  grantStatus(taskId: string): string | null {
    return this.#deps.sql.all<BudgetGrantRow>('SELECT status FROM budget_grants WHERE task_id = ?', taskId)[0]?.status ?? null
  }
}
