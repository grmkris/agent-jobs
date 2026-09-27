/**
 * The hosted board (spec §5): one service behind both the REST API and the MCP tools. It coordinates; it never holds
 * keys or moves money. Every money-moving step comes back as an unsigned transaction or EIP-712 message for the
 * caller's own wallet (cast, MetaMask agent wallet, Privy, a browser), and every chain fact is read from the chain,
 * never taken from a client's claim (spec §3: a board receipt never overrides chain state).
 *
 * At most one economic effect per operation (R114-07): an operation record is written before a money-moving
 * transaction is handed out and reconciled from the chain (receipt, or the listing itself) afterwards; the
 * contracts refuse the duplicates a retry could cause (reused `termsHash`, used selection nonce, spent
 * authorisation nonce).
 */
import * as sdk from '@agent-jobs/sdk'
import {
  type Address,
  type Hex,
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  isAddress,
  maxUint256,
  parseUnits,
  zeroAddress,
} from 'viem'
import { createSiweMessage, parseSiweMessage } from 'viem/siwe'
import {
  type ApplicationRow,
  type OperationRow,
  type SelectionRow,
  type Sql,
  type TaskRow,
  migrate,
} from './store.ts'
import { type OfferMode, type OfferTerms, canonicalJson, listingMatches, parseTerms, termsHash, validateOffer } from './terms.ts'

export class BoardError extends Error {
  constructor(
    readonly code: 'unauthenticated' | 'forbidden' | 'not-found' | 'invalid' | 'conflict' | 'chain',
    message: string,
  ) {
    super(message)
  }
}

export interface BoardConfig {
  readonly network: sdk.Network
  /** One chain context per deployed stack ("main", and on testnet "demo"). */
  readonly contexts: Partial<Record<sdk.StackName, sdk.Ctx>>
  /** SIWE domain and URI: the host and origin the API is served from. */
  readonly domain: string
  readonly uri: string
  /** Where manifests are publicly readable: `${manifestBaseUrl}/${termsHash}.json`. */
  readonly manifestBaseUrl: string
  readonly now?: () => number
}

/** An unsigned transaction for the caller's wallet: `cast send <to> <data>`, or `eth_sendTransaction`. */
export interface TxRequest {
  readonly description: string
  readonly chainId: number
  readonly to: Address
  readonly data: Hex
  readonly value: '0'
}

/** An EIP-712 message for the caller's wallet: `cast wallet sign --data '<json>'`, or `eth_signTypedData_v4`. */
export interface SignRequest {
  readonly description: string
  readonly typedData: string
}

export interface Caller {
  readonly address?: Address
}

const SESSION_SECONDS = 24 * 3600
const NONCE_SECONDS = 10 * 60

function randomId(bytes = 16): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function randomUint(bytes: number): bigint {
  return crypto.getRandomValues(new Uint8Array(bytes)).reduce((acc, b) => (acc << 8n) | BigInt(b), 0n)
}

const eq = (a: string | null | undefined, b: string | null | undefined) =>
  a !== null && a !== undefined && b !== null && b !== undefined && a.toLowerCase() === b.toLowerCase()

/** The EIP-712 JSON wallets sign: `eth_signTypedData_v4` shape, bigints as decimal strings. */
function typedDataJson(domain: Record<string, unknown>, types: Record<string, unknown>, primaryType: string, message: unknown): string {
  const domainFields = [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ]
  return JSON.stringify(
    { types: { EIP712Domain: domainFields, ...types }, primaryType, domain, message },
    (_, v) => (typeof v === 'bigint' ? v.toString() : v),
  )
}

export class Board {
  readonly #sql: Sql
  readonly #config: BoardConfig

  constructor(sql: Sql, config: BoardConfig) {
    this.#sql = sql
    this.#config = config
    migrate(sql)
  }

  #now(): number {
    return this.#config.now?.() ?? Math.floor(Date.now() / 1000)
  }

  #ctx(stack: string): sdk.Ctx {
    const ctx = this.#config.contexts[stack as sdk.StackName]
    if (ctx === undefined) throw new BoardError('invalid', `stack "${stack}" is not deployed on ${this.#config.network}`)
    return ctx
  }

  #tx(ctx: sdk.Ctx, description: string, to: Address, data: Hex): TxRequest {
    return { description, chainId: ctx.deployment.chainId, to, data, value: '0' }
  }

  #requireCaller(caller: Caller): Address {
    if (caller.address === undefined) {
      throw new BoardError('unauthenticated', 'Sign in first: auth_challenge, sign the message with your wallet, auth_login.')
    }
    return caller.address
  }

  #task(taskId: string): TaskRow {
    const [row] = this.#sql.all<TaskRow>('SELECT * FROM tasks WHERE id = ?', taskId)
    if (row === undefined) throw new BoardError('not-found', `no task ${taskId}`)
    return row
  }

  #operation(taskId: string, kind: string, actor: Address, detail?: unknown): string {
    const id = randomId()
    const now = this.#now()
    this.#sql.run(
      'INSERT INTO operations (id, task_id, kind, actor, status, tx_hash, detail, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)',
      id,
      taskId,
      kind,
      actor,
      'prepared',
      detail === undefined ? null : JSON.stringify(detail),
      now,
      now,
    )
    return id
  }

  // -----------------------------------------------------------------------------------------------
  // Sign-in with Ethereum
  // -----------------------------------------------------------------------------------------------

  /** A SIWE message for `address` to sign; valid for ten minutes, once. */
  authChallenge(input: { address: string }): { message: string } {
    if (!isAddress(input.address)) throw new BoardError('invalid', 'address must be a 0x address')
    const address = getAddress(input.address)
    const nonce = randomId(12)
    const now = this.#now()
    this.#sql.run('INSERT INTO siwe_nonces (nonce, address, expires_at) VALUES (?, ?, ?)', nonce, address, now + NONCE_SECONDS)
    const message = createSiweMessage({
      address,
      chainId: this.#ctx('main').deployment.chainId,
      domain: this.#config.domain,
      uri: this.#config.uri,
      version: '1',
      nonce,
      issuedAt: new Date(now * 1000),
      expirationTime: new Date((now + NONCE_SECONDS) * 1000),
      statement: 'Sign in to the agent-jobs board. This signature moves no funds.',
    })
    return { message }
  }

  /** Verifies a signed challenge (EOA or ERC-1271 wallet) and opens a 24 h session. */
  async authLogin(input: { message: string; signature: string }): Promise<{ session: string; address: Address; expiresAt: number }> {
    const fields = parseSiweMessage(input.message)
    const now = this.#now()
    if (fields.address === undefined || fields.nonce === undefined) throw new BoardError('invalid', 'not a SIWE message')
    if (fields.domain !== this.#config.domain) throw new BoardError('forbidden', 'SIWE domain mismatch')
    const [nonce] = this.#sql.all<{ address: string; expires_at: number; used: number }>(
      'SELECT address, expires_at, used FROM siwe_nonces WHERE nonce = ?',
      fields.nonce,
    )
    if (nonce === undefined || nonce.used !== 0 || nonce.expires_at < now || !eq(nonce.address, fields.address)) {
      throw new BoardError('forbidden', 'unknown, used or expired sign-in nonce; request a new auth_challenge')
    }
    const valid = await this.#ctx('main').publicClient.verifyMessage({
      address: fields.address,
      message: input.message,
      signature: input.signature as Hex,
    })
    if (!valid) throw new BoardError('forbidden', 'signature does not match the address')
    this.#sql.run('UPDATE siwe_nonces SET used = 1 WHERE nonce = ?', fields.nonce)
    const session = randomId(32)
    const expiresAt = now + SESSION_SECONDS
    this.#sql.run('INSERT INTO sessions (id, address, expires_at) VALUES (?, ?, ?)', session, fields.address, expiresAt)
    return { session, address: fields.address, expiresAt }
  }

  /** The wallet behind a session, if it is live. */
  sessionAddress(session: string | undefined): Address | undefined {
    if (session === undefined || session === '') return undefined
    const [row] = this.#sql.all<{ address: string; expires_at: number }>(
      'SELECT address, expires_at FROM sessions WHERE id = ?',
      session,
    )
    if (row === undefined || row.expires_at < this.#now()) return undefined
    return getAddress(row.address)
  }

  /** Binds an MCP session to a signed-in board session, so an agent that signed in through a tool stays signed in. */
  bindMcpSession(mcpSession: string, session: string): void {
    this.#sql.run(
      'INSERT INTO mcp_sessions (id, session) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET session = excluded.session',
      mcpSession,
      session,
    )
  }

  /** The caller behind a bearer session or, failing that, a bound MCP session. */
  resolveCaller(auth: { bearer?: string | undefined; mcpSession?: string | undefined }): Caller {
    const direct = this.sessionAddress(auth.bearer)
    if (direct !== undefined) return { address: direct }
    if (auth.mcpSession === undefined) return {}
    const [row] = this.#sql.all<{ session: string }>('SELECT session FROM mcp_sessions WHERE id = ?', auth.mcpSession)
    const bound = this.sessionAddress(row?.session)
    return bound === undefined ? {} : { address: bound }
  }

  // -----------------------------------------------------------------------------------------------
  // Publisher
  // -----------------------------------------------------------------------------------------------

  /**
   * Freezes a new offer and hands back what the creator's wallet must send: approvals and `publish`. The offer is
   * the content-addressed manifest (`manifest` is for the caller to store at `${termsHash}.json`); nothing is
   * escrowed until the creator's `publish` confirms.
   */
  async createTask(
    caller: Caller,
    input: {
      title: string
      brief: string
      acceptanceCriteria: string[]
      /** A reward token symbol from the deployment (`mUSD`, `mEUR`, `USDC`) or its address. */
      token: string
      /** Decimal amounts in the token's and FACTORY's own units ("25" = 25 mEUR). */
      reward: string
      creatorBond: string
      workerBond: string
      /** Unix seconds. */
      deliveryDeadline: number
      mode: OfferMode
      selectionDeadline?: number
      approver?: string
      /** "main" (real windows) or, on testnet, "demo" (minute windows). */
      stack?: sdk.StackName
    },
  ) {
    const creator = this.#requireCaller(caller)
    const stack = input.stack ?? 'main'
    const ctx = this.#ctx(stack)
    const token = await this.#resolveToken(ctx, input.token)
    const decimals = await ctx.publicClient.readContract({ address: token, abi: sdk.factoryTokenAbi, functionName: 'decimals' })
    const [review, dispute, arbitration, block] = await Promise.all([
      ctx.publicClient.readContract({ address: ctx.stack.evaluator, abi: sdk.jobsEvaluatorAbi, functionName: 'reviewWindow' }),
      ctx.publicClient.readContract({ address: ctx.stack.evaluator, abi: sdk.jobsEvaluatorAbi, functionName: 'disputeWindow' }),
      ctx.publicClient.readContract({ address: ctx.stack.evaluator, abi: sdk.jobsEvaluatorAbi, functionName: 'arbitrationWindow' }),
      ctx.publicClient.getBlockNumber(),
    ])
    const windows = { reviewSeconds: review, disputeSeconds: dispute, arbitrationSeconds: arbitration }
    const taskId = randomId(8)
    const terms: OfferTerms = {
      v: 2,
      deployment: {
        chainId: ctx.deployment.chainId,
        core: ctx.deployment.core,
        holding: ctx.stack.holding,
        evaluator: ctx.stack.evaluator,
        identity: ctx.deployment.identity,
      },
      taskId,
      projectId: null,
      policyVersion: null,
      mode: input.mode,
      title: input.title,
      brief: input.brief,
      acceptanceCriteria: input.acceptanceCriteria,
      token,
      reward: parseUnits(input.reward, decimals),
      creatorBond: parseUnits(input.creatorBond, 18),
      workerBond: parseUnits(input.workerBond, 18),
      deliveryDeadline: input.deliveryDeadline,
      selectionDeadline: input.selectionDeadline ?? null,
      creator,
      approver: input.approver === undefined ? creator : getAddress(input.approver),
      windows,
      eligibility: null,
      evidencePolicy: null,
      quote: null,
      salt: `0x${randomId(32)}`,
    }
    try {
      validateOffer(terms, windows, this.#now())
    } catch (e) {
      throw new BoardError('invalid', (e as Error).message)
    }
    const hash = termsHash(terms)
    const manifest = canonicalJson(terms)
    this.#sql.run(
      'INSERT INTO tasks (id, creator, stack, terms_json, terms_hash, job_id, publish_tx, from_block, created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)',
      taskId,
      creator,
      stack,
      manifest,
      hash,
      Number(block),
      this.#now(),
    )
    this.#operation(taskId, 'publish', creator, { termsHash: hash })

    const expiredAt =
      terms.deliveryDeadline +
      Number(await ctx.publicClient.readContract({ address: ctx.stack.evaluator, abi: sdk.jobsEvaluatorAbi, functionName: 'settlementWindow' }))
    const transactions: TxRequest[] = []
    transactions.push(
      ...(await this.#approvals(ctx, creator, [
        [token, terms.reward, 'reward token'],
        [ctx.deployment.factory, terms.creatorBond, 'FACTORY (creator bond)'],
      ])),
    )
    transactions.push(
      this.#tx(
        ctx,
        'publish: escrows the reward and the creator bond and lists the offer',
        ctx.stack.holding,
        encodeFunctionData({
          abi: sdk.jobHoldingAbi,
          functionName: 'publish',
          args: [
            {
              approver: terms.approver,
              manifestHash: hash,
              policyHash: hash,
              token,
              reward: terms.reward,
              creatorBond: terms.creatorBond,
              workerBond: terms.workerBond,
              deliveryDeadline: terms.deliveryDeadline,
              expiredAt,
              mode: terms.mode === 'hire' ? 0 : 1,
              selectionDeadline: terms.selectionDeadline ?? 0,
            },
          ],
        }),
      ),
    )
    return {
      taskId,
      termsHash: hash,
      manifestUrl: `${this.#config.manifestBaseUrl}/${hash}.json`,
      manifest,
      transactions,
      next: 'Send the transactions in order from the creator wallet, then report_transaction with the publish tx hash.',
    }
  }

  async #resolveToken(ctx: sdk.Ctx, token: string): Promise<Address> {
    if (isAddress(token)) {
      const t = getAddress(token)
      if (!ctx.deployment.rewardTokens.some((r) => eq(r, t))) throw new BoardError('invalid', `${t} is not an allowlisted reward token`)
      return t
    }
    for (const t of ctx.deployment.rewardTokens) {
      const symbol = await ctx.publicClient.readContract({ address: t, abi: sdk.factoryTokenAbi, functionName: 'symbol' })
      if (symbol.toLowerCase() === token.toLowerCase()) return t
    }
    throw new BoardError('invalid', `unknown reward token ${token}`)
  }

  async #approvals(ctx: sdk.Ctx, owner: Address, needs: Array<[Address, bigint, string]>): Promise<TxRequest[]> {
    const out: TxRequest[] = []
    for (const [token, amount, label] of needs) {
      if (amount === 0n) continue
      const allowance = await ctx.publicClient.readContract({
        address: token,
        abi: sdk.factoryTokenAbi,
        functionName: 'allowance',
        args: [owner, ctx.stack.holding],
      })
      if (allowance >= amount) continue
      out.push(
        this.#tx(
          ctx,
          `approve ${label} for JobHolding`,
          token,
          encodeFunctionData({ abi: sdk.factoryTokenAbi, functionName: 'approve', args: [ctx.stack.holding, maxUint256] }),
        ),
      )
    }
    return out
  }

  /**
   * Reconciles a task from the chain after the caller sent a transaction: a publish is recorded only once its
   * receipt shows a `Published` event for exactly this offer's `termsHash`. Any other transaction only triggers a
   * fresh read; nothing is taken from the caller's word.
   */
  async reportTransaction(caller: Caller, input: { taskId: string; txHash: string }) {
    const task = this.#task(input.taskId)
    const ctx = this.#ctx(task.stack)
    const receipt = await ctx.publicClient.getTransactionReceipt({ hash: input.txHash as Hex }).catch(() => undefined)
    if (receipt === undefined) throw new BoardError('chain', `no receipt yet for ${input.txHash}; retry shortly`)
    if (task.job_id === null) {
      for (const log of receipt.logs) {
        if (!eq(log.address, ctx.stack.holding)) continue
        try {
          const event = decodeEventLog({ abi: sdk.jobHoldingAbi, data: log.data, topics: log.topics })
          if (event.eventName === 'Published' && eq(event.args.policyHash, task.terms_hash)) {
            this.#sql.run('UPDATE tasks SET job_id = ?, publish_tx = ? WHERE id = ?', event.args.jobId.toString(), input.txHash, task.id)
            this.#sql.run(
              "UPDATE operations SET status = 'confirmed', tx_hash = ?, updated_at = ? WHERE task_id = ? AND kind = 'publish'",
              input.txHash,
              this.#now(),
              task.id,
            )
          }
        } catch {
          // another event
        }
      }
    }
    return this.getTask(caller, { taskId: input.taskId })
  }

  listApplications(caller: Caller, input: { taskId: string }) {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    if (!eq(task.creator, me)) throw new BoardError('forbidden', 'only the creator sees applications')
    return this.#sql.all<ApplicationRow>('SELECT * FROM applications WHERE task_id = ? ORDER BY created_at', task.id)
  }

  /** The Selection the creator signs to pick one applicant. Nothing is on-chain until the worker activates. */
  async selectWorker(caller: Caller, input: { taskId: string; applicationId: string; activateBy?: number }) {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    if (!eq(task.creator, me)) throw new BoardError('forbidden', 'only the creator selects')
    const terms = parseTerms(task.terms_json)
    if (terms.mode !== 'hire') throw new BoardError('invalid', 'contests are awarded, not selected')
    if (task.job_id === null) throw new BoardError('conflict', 'publish the offer first')
    const [app] = this.#sql.all<ApplicationRow>('SELECT * FROM applications WHERE id = ? AND task_id = ?', input.applicationId, task.id)
    if (app === undefined) throw new BoardError('not-found', 'no such application')
    const activateBy = input.activateBy ?? Math.min(this.#now() + 24 * 3600, terms.deliveryDeadline - 60)
    if (activateBy >= terms.deliveryDeadline) throw new BoardError('invalid', 'activateBy must precede the delivery deadline')
    const ctx = this.#ctx(task.stack)
    const nonce = randomUint(16)
    this.#sql.run(
      'INSERT INTO selections (task_id, nonce, application_id, worker, agent_id, activate_by, signature, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)',
      task.id,
      nonce.toString(),
      app.id,
      app.worker,
      app.agent_id,
      activateBy,
      this.#now(),
    )
    const selection: sdk.Selection = {
      jobId: BigInt(task.job_id),
      worker: getAddress(app.worker),
      agentId: BigInt(app.agent_id),
      termsHash: task.terms_hash as Hex,
      activateBy,
      nonce,
    }
    return {
      nonce: nonce.toString(),
      sign: {
        description: 'Selection: sign with the creator wallet, then submit_selection with the signature',
        typedData: typedDataJson(sdk.holdingDomain(ctx.deployment.chainId, ctx.stack.holding), sdk.selectionTypes, 'Selection', selection),
      } satisfies SignRequest,
    }
  }

  /** Stores the creator's signed Selection after checking it recovers to the creator. */
  async submitSelection(caller: Caller, input: { taskId: string; nonce: string; signature: string }) {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    if (!eq(task.creator, me)) throw new BoardError('forbidden', 'only the creator selects')
    const [sel] = this.#sql.all<SelectionRow>('SELECT * FROM selections WHERE task_id = ? AND nonce = ?', task.id, input.nonce)
    if (sel === undefined) throw new BoardError('not-found', 'no such pending selection')
    const ctx = this.#ctx(task.stack)
    const valid = await ctx.publicClient.verifyTypedData({
      address: getAddress(task.creator),
      domain: sdk.holdingDomain(ctx.deployment.chainId, ctx.stack.holding),
      types: sdk.selectionTypes,
      primaryType: 'Selection',
      message: { ...this.#selection(task, sel) },
      signature: input.signature as Hex,
    })
    if (!valid) throw new BoardError('forbidden', 'the signature is not the creator’s over this selection')
    this.#sql.run('UPDATE selections SET signature = ? WHERE task_id = ? AND nonce = ?', input.signature, task.id, input.nonce)
    return { ok: true, worker: sel.worker, activateBy: sel.activate_by }
  }

  #selection(task: TaskRow, sel: SelectionRow): sdk.Selection {
    return {
      jobId: BigInt(task.job_id ?? '0'),
      worker: getAddress(sel.worker),
      agentId: BigInt(sel.agent_id),
      termsHash: task.terms_hash as Hex,
      activateBy: sel.activate_by,
      nonce: BigInt(sel.nonce),
    }
  }

  async approveWork(caller: Caller, input: { taskId: string }) {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    const terms = parseTerms(task.terms_json)
    if (!eq(terms.approver, me)) throw new BoardError('forbidden', 'only the approver accepts')
    const ctx = this.#ctx(task.stack)
    this.#operation(task.id, 'accept', me)
    return {
      transactions: [
        this.#tx(ctx, 'accept: pays the reward from escrow, returns both bonds', ctx.stack.evaluator,
          encodeFunctionData({ abi: sdk.jobsEvaluatorAbi, functionName: 'accept', args: [this.#jobId(task)] })),
      ],
    }
  }

  async rejectWork(caller: Caller, input: { taskId: string; violation: sdk.ViolationName; reason: string }) {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    const terms = parseTerms(task.terms_json)
    if (!eq(terms.approver, me)) throw new BoardError('forbidden', 'only the approver rejects')
    if (!(input.violation in sdk.Violation)) throw new BoardError('invalid', 'violation is None, Quality or Falsified')
    const reasonHash = sdk.hashText(input.reason)
    this.#sql.run('INSERT OR IGNORE INTO reasons (hash, task_id, text, created_at) VALUES (?, ?, ?, ?)', reasonHash, task.id, input.reason, this.#now())
    const ctx = this.#ctx(task.stack)
    this.#operation(task.id, 'reject', me, { violation: input.violation, reasonHash })
    return {
      reasonHash,
      transactions: [
        this.#tx(ctx, `reject (${input.violation}): nothing moves; the worker may dispute`, ctx.stack.evaluator,
          encodeFunctionData({ abi: sdk.jobsEvaluatorAbi, functionName: 'reject', args: [this.#jobId(task), sdk.Violation[input.violation], reasonHash] })),
      ],
    }
  }

  #jobId(task: TaskRow): bigint {
    if (task.job_id === null) throw new BoardError('conflict', 'the offer is not published yet')
    return BigInt(task.job_id)
  }

  // -----------------------------------------------------------------------------------------------
  // Worker
  // -----------------------------------------------------------------------------------------------

  /** Applies with a registered ERC-8004 agent whose agent wallet is the signed-in wallet. */
  async apply(caller: Caller, input: { taskId: string; agentId: string; note?: string }) {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    if (task.job_id === null) throw new BoardError('conflict', 'this offer is not funded on-chain yet')
    const ctx = this.#ctx(task.stack)
    const agentWallet = await sdk.agentWallet(ctx, BigInt(input.agentId)).catch(() => zeroAddress)
    if (!eq(agentWallet, me)) {
      throw new BoardError('forbidden', `agent ${input.agentId}'s registered wallet is ${agentWallet}, not ${me}`)
    }
    const id = randomId(8)
    this.#sql.run(
      'INSERT INTO applications (id, task_id, worker, agent_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (task_id, worker) DO UPDATE SET agent_id = excluded.agent_id, note = excluded.note',
      id,
      task.id,
      me,
      input.agentId,
      input.note ?? '',
      this.#now(),
    )
    const [row] = this.#sql.all<ApplicationRow>('SELECT * FROM applications WHERE task_id = ? AND worker = ?', task.id, me)
    return { applicationId: row?.id ?? id, next: 'Wait for the creator to select you; then prepare_activation.' }
  }

  /**
   * For a selected worker: the creator's signed Selection plus the budget authorisation to sign, and any FACTORY
   * approval the worker bond needs. Activation is the worker's own transaction (R114-01).
   */
  async prepareActivation(caller: Caller, input: { taskId: string }) {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    const sel = this.#liveSelectionFor(task, me)
    const ctx = this.#ctx(task.stack)
    const terms = parseTerms(task.terms_json)
    const budgetNonce = randomUint(9)
    const budgetDeadline = this.#now() + 3600
    this.#sql.run(
      'INSERT INTO activation_preps (task_id, worker, nonce, budget_nonce, budget_deadline) VALUES (?, ?, ?, ?, ?) ON CONFLICT (task_id, worker) DO UPDATE SET nonce = excluded.nonce, budget_nonce = excluded.budget_nonce, budget_deadline = excluded.budget_deadline',
      task.id,
      me,
      sel.nonce,
      budgetNonce.toString(),
      budgetDeadline,
    )
    return {
      selection: this.#selection(task, sel),
      activateBy: sel.activate_by,
      transactions: await this.#approvals(ctx, me, [[ctx.deployment.factory, terms.workerBond, 'FACTORY (worker bond)']]),
      sign: {
        description: 'SetBudgetAuthorization for exactly the listed reward: sign with your wallet, then build_activation with the signature',
        typedData: typedDataJson(sdk.coreDomain(ctx.deployment.chainId, ctx.deployment.core), sdk.setBudgetTypes, 'SetBudgetAuthorization', {
          signer: me,
          jobId: this.#jobId(task),
          token: terms.token,
          amount: terms.reward,
          optParamsHash: sdk.EMPTY_HASH,
          nonce: budgetNonce,
          deadline: BigInt(budgetDeadline),
        }),
      } satisfies SignRequest,
      next: 'Send any approval, sign the typed data, then build_activation({ taskId, budgetSignature }).',
    }
  }

  #liveSelectionFor(task: TaskRow, worker: Address): SelectionRow {
    const rows = this.#sql.all<SelectionRow>(
      'SELECT * FROM selections WHERE task_id = ? AND signature IS NOT NULL AND activate_by >= ? ORDER BY created_at DESC',
      task.id,
      this.#now(),
    )
    const sel = rows.find((r) => eq(r.worker, worker))
    if (sel === undefined) throw new BoardError('not-found', 'you have no live signed selection for this task')
    return sel
  }

  /** The `activate` transaction, from the worker's signed budget authorisation. */
  async buildActivation(caller: Caller, input: { taskId: string; budgetSignature: string }) {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    const sel = this.#liveSelectionFor(task, me)
    const [prep] = this.#sql.all<{ nonce: string; budget_nonce: string; budget_deadline: number }>(
      'SELECT nonce, budget_nonce, budget_deadline FROM activation_preps WHERE task_id = ? AND worker = ?',
      task.id,
      me,
    )
    if (prep === undefined || prep.nonce !== sel.nonce) throw new BoardError('conflict', 'call prepare_activation first')
    const ctx = this.#ctx(task.stack)
    this.#operation(task.id, 'activate', me, { selectionNonce: sel.nonce })
    return {
      transactions: [
        this.#tx(ctx, 'activate: your final confirmation; sets you as provider, posts your bond, funds the job', ctx.stack.holding,
          encodeFunctionData({
            abi: sdk.jobHoldingAbi,
            functionName: 'activate',
            args: [
              this.#selection(task, sel),
              sel.signature as Hex,
              { signer: me, nonce: BigInt(prep.budget_nonce), deadline: BigInt(prep.budget_deadline), sig: input.budgetSignature as Hex },
            ],
          })),
      ],
      next: 'Send it from your wallet, then report_transaction.',
    }
  }

  /** Records the deliverable (public fork, branch, full SHA) and returns the final `submit` transaction. */
  async submitWork(caller: Caller, input: { taskId: string; repo: string; branch: string; sha: string }) {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    const ctx = this.#ctx(task.stack)
    const job = await sdk.getJob(ctx, this.#jobId(task))
    if (!eq(job.provider, me)) throw new BoardError('forbidden', 'only the activated worker submits')
    if (!/^[0-9a-f]{40}$/.test(input.sha)) throw new BoardError('invalid', 'sha must be a full 40-character commit SHA')
    const deliverable = { repo: input.repo, branch: input.branch, sha: input.sha }
    const deliverableHash = sdk.hashText(canonicalJson(deliverable))
    this.#sql.run(
      'INSERT OR IGNORE INTO deliverables (task_id, worker, deliverable_hash, repo, branch, sha, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      task.id, me, deliverableHash, input.repo, input.branch, input.sha, this.#now(),
    )
    this.#operation(task.id, 'submit', me, { deliverableHash })
    return {
      deliverableHash,
      transactions: [
        this.#tx(ctx, 'submit: your one final submission of this deliverable', ctx.deployment.core,
          encodeFunctionData({ abi: sdk.coreAbi, functionName: 'submit', args: [this.#jobId(task), deliverableHash, '0x'] })),
      ],
    }
  }

  async disputeRejection(caller: Caller, input: { taskId: string }) {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    const ctx = this.#ctx(task.stack)
    this.#operation(task.id, 'dispute', me)
    return {
      transactions: [
        this.#tx(ctx, 'dispute: freezes acceptance; only a ruling or the arbitration timeout settles', ctx.stack.evaluator,
          encodeFunctionData({ abi: sdk.jobsEvaluatorAbi, functionName: 'dispute', args: [this.#jobId(task)] })),
      ],
    }
  }

  // -----------------------------------------------------------------------------------------------
  // Anyone
  // -----------------------------------------------------------------------------------------------

  /** Whatever permissionless step the chain allows now (timeouts, settlement), as transactions anyone may send. */
  async settlementActions(_caller: Caller, input: { taskId: string }) {
    const task = this.#task(input.taskId)
    const ctx = this.#ctx(task.stack)
    const view = await this.#chainView(task)
    const jobId = this.#jobId(task)
    const call = (fn: 'completeAfterSilence' | 'rejectAfterWindow' | 'refundAfterArbitrationTimeout' | 'rejectAfterDeliveryDeadline', what: string) =>
      this.#tx(ctx, what, ctx.stack.evaluator, encodeFunctionData({ abi: sdk.jobsEvaluatorAbi, functionName: fn, args: [jobId] }))
    const txs: TxRequest[] = []
    const now = this.#now()
    const s = view.status
    if (s === 'submitted' && view.reviewEndsAt !== null && now > view.reviewEndsAt && view.timely) {
      txs.push(call('completeAfterSilence', 'silence is acceptance: pays the worker'))
    }
    if (s === 'rejected-pending' && view.disputeEndsAt !== null && now > view.disputeEndsAt) {
      txs.push(call('rejectAfterWindow', 'the undisputed rejection becomes final'))
    }
    if (s === 'disputed' && view.arbitrationEndsAt !== null && now > view.arbitrationEndsAt) {
      txs.push(call('refundAfterArbitrationTimeout', 'arbitrator inactive: refund, both bonds back'))
    }
    if ((s === 'active' || (s === 'submitted' && !view.timely)) && now > view.deliveryDeadline) {
      txs.push(call('rejectAfterDeliveryDeadline', 'missed delivery: refund, the worker bond burns'))
    }
    if (['rejected', 'expired', 'cancelled'].includes(s) || (view.coreStatus === 'Expired')) {
      txs.push(this.#tx(ctx, 'settle: pays out what is still in Holding', ctx.stack.holding,
        encodeFunctionData({ abi: sdk.jobHoldingAbi, functionName: 'settle', args: [jobId] })))
    }
    return { status: s, transactions: txs }
  }

  async listTasks(caller: Caller, input: { limit?: number }) {
    const rows = this.#sql.all<TaskRow>('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?', Math.min(input.limit ?? 20, 50))
    const out = []
    for (const row of rows) out.push(await this.#summary(row, caller))
    return out
  }

  async getTask(caller: Caller, input: { taskId: string }) {
    const task = this.#task(input.taskId)
    const summary = await this.#summary(task, caller)
    const me = caller.address
    const mine =
      me === undefined
        ? undefined
        : {
            application: this.#sql.all<ApplicationRow>('SELECT * FROM applications WHERE task_id = ? AND worker = ?', task.id, me)[0] ?? null,
            selected: this.#sql.all<SelectionRow>('SELECT * FROM selections WHERE task_id = ? AND worker = ? AND signature IS NOT NULL', task.id, me).length > 0,
          }
    const operations = this.#sql.all<OperationRow>('SELECT kind, status, tx_hash, updated_at FROM operations WHERE task_id = ? ORDER BY created_at', task.id)
    /** Candidate-level records the worker declared; the on-chain `JobSubmitted` deliverable is the one that counts. */
    const deliverables = this.#sql.all<{ worker: string; deliverable_hash: string; repo: string; branch: string; sha: string }>(
      'SELECT worker, deliverable_hash, repo, branch, sha FROM deliverables WHERE task_id = ? ORDER BY created_at',
      task.id,
    )
    return { ...summary, terms: JSON.parse(task.terms_json) as unknown, mine, deliverables, operations }
  }

  async #summary(task: TaskRow, caller: Caller) {
    const terms = parseTerms(task.terms_json)
    const view = await this.#chainView(task)
    return {
      taskId: task.id,
      title: terms.title,
      mode: terms.mode,
      stack: task.stack,
      token: terms.token,
      reward: terms.reward.toString(),
      creatorBond: terms.creatorBond.toString(),
      workerBond: terms.workerBond.toString(),
      creator: terms.creator,
      approver: terms.approver,
      deliveryDeadline: terms.deliveryDeadline,
      selectionDeadline: terms.selectionDeadline,
      termsHash: task.terms_hash,
      manifestUrl: `${this.#config.manifestBaseUrl}/${task.terms_hash}.json`,
      jobId: task.job_id,
      chain: view,
      you: caller.address === undefined ? null : this.#roles(terms, view, caller.address),
    }
  }

  #roles(terms: OfferTerms, view: ChainView, me: Address): string[] {
    const roles: string[] = []
    if (eq(terms.creator, me)) roles.push('creator')
    if (eq(terms.approver, me)) roles.push('approver')
    if (eq(view.provider, me)) roles.push('worker')
    return roles
  }

  /** The task's chain facts, read now. The board's own records never override these. */
  async #chainView(task: TaskRow): Promise<ChainView> {
    const terms = parseTerms(task.terms_json)
    const base: ChainView = {
      status: 'awaiting-publish',
      coreStatus: null,
      listingMatchesOffer: null,
      provider: null,
      submittedAt: null,
      timely: false,
      deliveryDeadline: terms.deliveryDeadline,
      reviewEndsAt: null,
      disputeEndsAt: null,
      arbitrationEndsAt: null,
      violation: null,
    }
    if (task.job_id === null) return base
    const ctx = this.#ctx(task.stack)
    const jobId = BigInt(task.job_id)
    const [job, listing, rejectedAt, disputedAt, violation] = await Promise.all([
      sdk.getJob(ctx, jobId),
      sdk.getListing(ctx, jobId),
      ctx.publicClient.readContract({ address: ctx.stack.evaluator, abi: sdk.jobsEvaluatorAbi, functionName: 'rejectedAt', args: [jobId] }),
      ctx.publicClient.readContract({ address: ctx.stack.evaluator, abi: sdk.jobsEvaluatorAbi, functionName: 'disputedAt', args: [jobId] }),
      ctx.publicClient.readContract({ address: ctx.stack.evaluator, abi: sdk.jobsEvaluatorAbi, functionName: 'violationOf', args: [jobId] }),
    ])
    const matches = listingMatches(terms, task.terms_hash as Hex, {
      creator: listing.creator,
      approver: listing.approver,
      token: listing.token,
      reward: listing.reward,
      creatorBond: listing.creatorBond,
      workerBond: listing.workerBond,
      deliveryDeadline: listing.deliveryDeadline,
      selectionDeadline: listing.selectionDeadline,
      mode: listing.mode,
      policyHash: listing.policyHash,
    })
    const submittedAt = job.submittedAt === 0 ? null : job.submittedAt
    const timely = submittedAt !== null && submittedAt <= terms.deliveryDeadline
    const now = this.#now()
    let status: TaskStatus
    switch (job.statusName) {
      case 'Open':
        status =
          terms.mode === 'contest'
            ? now > (terms.selectionDeadline ?? 0) ? 'selection-closed' : 'open'
            : now > terms.deliveryDeadline ? 'lapsed' : 'open'
        break
      case 'Funded':
        status = 'active'
        break
      case 'Submitted':
        status = disputedAt !== 0 ? 'disputed' : rejectedAt !== 0 ? 'rejected-pending' : 'submitted'
        break
      case 'Completed':
        status = 'completed'
        break
      case 'Rejected':
        status = job.provider === zeroAddress ? 'cancelled' : 'rejected'
        break
      default:
        status = 'expired'
    }
    return {
      status,
      coreStatus: job.statusName,
      listingMatchesOffer: matches,
      provider: job.provider === zeroAddress ? null : job.provider,
      submittedAt,
      timely,
      deliveryDeadline: terms.deliveryDeadline,
      reviewEndsAt: submittedAt === null ? null : submittedAt + terms.windows.reviewSeconds,
      disputeEndsAt: rejectedAt === 0 ? null : rejectedAt + terms.windows.disputeSeconds,
      arbitrationEndsAt: disputedAt === 0 ? null : disputedAt + terms.windows.arbitrationSeconds,
      violation: rejectedAt === 0 ? null : (['None', 'Quality', 'Falsified'][violation] ?? null),
    }
  }
}

export type TaskStatus =
  | 'awaiting-publish'
  | 'open'
  | 'lapsed'
  | 'selection-closed'
  | 'active'
  | 'submitted'
  | 'rejected-pending'
  | 'disputed'
  | 'completed'
  | 'rejected'
  | 'cancelled'
  | 'expired'

export interface ChainView {
  status: TaskStatus
  coreStatus: sdk.JobStatusName | null
  listingMatchesOffer: boolean | null
  provider: Address | null
  submittedAt: number | null
  timely: boolean
  deliveryDeadline: number
  reviewEndsAt: number | null
  disputeEndsAt: number | null
  arbitrationEndsAt: number | null
  violation: string | null
}
