/**
 * The hosted board (spec §5): one service behind both the REST API and the MCP tools. It coordinates. Every
 * money-moving step of the protocol comes back as an unsigned transaction or EIP-712 message for the caller's own
 * wallet (cast, MetaMask agent wallet, Privy, a browser), and every chain fact is read from the chain, never taken from
 * a client's claim (spec §3: a board receipt never overrides chain state). The one exception is the execution budget
 * (ADR-0005, `budget.ts`): a creator may add the board's signer to their Privy wallet, bounded by their own policy.
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
  bytesToHex,
  encodeFunctionData,
  fromRlp,
  formatUnits,
  getAddress,
  isAddress,
  isHex,
  pad,
  parseUnits,
  toHex,
  zeroAddress,
} from 'viem'
import { createSiweMessage, parseSiweMessage } from 'viem/siwe'
import { recoverAuthorizationAddress } from 'viem/utils'
import { BudgetDesk, nativeSymbol } from './budget.ts'
import { type DisputeBundle, type ViolationName, bundleHash, rulingRefusal } from './arbitration.ts'
import { type GitHubApp, checkRuns, installationToken, repoSlug } from './github.ts'
import type { ModelEndpoint } from './model.ts'
import { screenOffer } from './screening.ts'
import { typedDataJson } from './typed-data.ts'
import {
  type ApplicationRow,
  type CandidateRow,
  type OperationRow,
  type QuoteRequestRow,
  type QuoteRow,
  type RulingRow,
  type SelectionRow,
  type Sql,
  type TaskRow,
  migrate,
  type PoolRow,
} from './store.ts'
import { type CallBudget, type ExecutionBudget, type OfferMode, type OfferTerms, callFunction, canonicalJson, listingMatches, parseTerms, termsHash, validateOffer } from './terms.ts'
import {
  type Deliverable,
  type DeliverableCheck,
  type DeliverableSpec,
  DELIVERABLE_KINDS,
  DeliverableError,
  checkDeliverable,
  deliverableHash as hashDeliverable,
  legacyColumns,
  parseDeliverable,
  specOf,
  validateSpec,
} from './deliverable.ts'

/** A signed authorization as `cast wallet sign-auth` prints it: RLP of [chainId, address, nonce, yParity, r, s]. */
function authorizationFromRlp(rlp: string): Record<string, unknown> {
  let items: unknown
  try {
    items = fromRlp(rlp as Hex, 'hex')
  } catch {
    throw new BoardError('invalid', 'authorization must be the signed authorization (an object, or the RLP hex `cast wallet sign-auth` prints)')
  }
  if (!Array.isArray(items) || items.length !== 6 || !items.every((x) => typeof x === 'string')) {
    throw new BoardError('invalid', 'the RLP authorization must be [chainId, address, nonce, yParity, r, s]')
  }
  const [chainId, address, nonce, yParity, r, sig] = items as [Hex, Hex, Hex, Hex, Hex, Hex]
  return { chainId: rlpInt(chainId), address, nonce: rlpInt(nonce), yParity: rlpInt(yParity), r: pad(r, { size: 32 }), s: pad(sig, { size: 32 }) }
}

/** RLP writes zero as empty bytes. */
const rlpInt = (x: Hex) => (x === '0x' ? '0' : x)

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
  /** Used for the one-time submission check of a deliverable (ADR-0006); defaults to the global fetch. */
  readonly fetch?: typeof fetch
  /**
   * The attester (spec §5): a registered verifier key that signs evidence about GitHub check runs, the relay that
   * sends `attachEvidence` (it holds no authority: the evaluator checks the attester's signature), and the GitHub
   * App it reads with. Absent: evidence is unavailable and says so.
   */
  /** Jev's model endpoint (advisory screening at publish); absent → "unscreened". */
  readonly screening?: ModelEndpoint
  /**
   * The relay that sends signed rulings (`ruleWithSignature`). It holds no authority: the evaluator checks the
   * arbitrator's signature. Absent: `submit_ruling` returns the transaction for anyone to send.
   */
  readonly relay?: { readonly account: import('viem').LocalAccount; readonly rpcUrl: string }
  readonly evidence?: {
    readonly attester: import('viem').LocalAccount
    readonly relay: import('viem').LocalAccount
    readonly rpcUrl: string
    readonly github?: GitHubApp
  }
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

/**
 * An execution budget as a caller asks for it (decimal cap). An advance names the ERC-20 `token` the worker draws; a
 * call budget names the contract `target` and the one allowed `function`, and caps the call's native value.
 */
export interface BudgetInput {
  kind: 'advance' | 'call'
  token?: string
  target?: string
  function?: string
  cap: string
  expiresAt?: number
}

/** The spec as frozen into terms: kinds de-duplicated in canonical order, an empty target dropped. */
function normalSpec(spec: DeliverableSpec): DeliverableSpec {
  const problem = validateSpec(spec)
  if (problem !== undefined) throw new BoardError('invalid', `deliverable: ${problem}`)
  const target = spec.target?.trim()
  return {
    accepts: DELIVERABLE_KINDS.filter((k) => (spec.accepts as readonly string[]).includes(k)),
    ...(target === undefined || target === '' ? {} : { target }),
  }
}

/** A recorded deliverable as read back: its descriptor (legacy rows are git) and the submission check, if any. */
function deliverableView<R extends { repo: string; branch: string; sha: string; kind: string | null; descriptor_json: string | null; check_json: string | null }>(r: R) {
  const { kind: _kind, descriptor_json, check_json, ...rest } = r
  const descriptor: Deliverable = descriptor_json === null ? { kind: 'git', url: r.repo, ref: r.branch, sha: r.sha } : (JSON.parse(descriptor_json) as Deliverable)
  return { ...rest, descriptor, check: check_json === null ? null : (JSON.parse(check_json) as DeliverableCheck) }
}

export class Board {
  readonly #sql: Sql
  readonly #config: BoardConfig

  readonly #budget: BudgetDesk

  constructor(sql: Sql, config: BoardConfig) {
    this.#sql = sql
    this.#config = config
    migrate(sql)
    this.#budget = new BudgetDesk({
      sql,
      now: () => this.#now(),
      fail: (code, message) => new BoardError(code, message),
      taskState: async (taskId) => {
        const task = this.#task(taskId)
        const view = await this.#chainView(task)
        return { task, terms: parseTerms(task.terms_json), status: view.status, provider: view.provider, ctx: this.#taskCtx(task) }
      },
    })
  }

  // -----------------------------------------------------------------------------------------------
  // Execution budget (ADR-0009)
  // -----------------------------------------------------------------------------------------------

  budgetGrantPrepare(caller: Caller, input: { taskId: string }) {
    return this.#budget.grantPrepare(this.#requireCaller(caller), input)
  }

  budgetGrantConfirm(caller: Caller, input: { taskId: string; signature: string }) {
    return this.#budget.grantConfirm(this.#requireCaller(caller), input)
  }

  getBudget(caller: Caller, input: { taskId: string }) {
    return this.#budget.getBudget(this.#requireCaller(caller), input)
  }

  spendBudget(caller: Caller, input: { taskId: string; amount: string; note?: string }) {
    return this.#budget.spend(this.#requireCaller(caller), input)
  }

  spendBudgetCall(caller: Caller, input: { taskId: string; data: string; value?: string; note?: string }) {
    return this.#budget.spendCall(this.#requireCaller(caller), input)
  }

  revokeBudget(caller: Caller, input: { taskId: string }) {
    return this.#budget.revoke(this.#requireCaller(caller), input)
  }

  /**
   * The descriptor a worker submits (ADR-0006): `deliverable`, or the legacy `{repo, branch, sha}` as git. Refused
   * when the offer does not accept its kind.
   */
  #acceptedDeliverable(terms: OfferTerms, input: { deliverable?: unknown; repo?: string; branch?: string; sha?: string }): Deliverable {
    let d: Deliverable
    try {
      d = parseDeliverable(input.deliverable ?? { kind: 'git', url: input.repo, ref: input.branch, sha: input.sha })
    } catch (e) {
      if (e instanceof DeliverableError) throw new BoardError('invalid', e.message)
      throw e
    }
    const spec = specOf(terms)
    if (!spec.accepts.includes(d.kind)) {
      throw new BoardError('invalid', `this offer accepts ${spec.accepts.join(', ')} deliverables, not ${d.kind}${spec.target === undefined ? '' : ` (target: ${spec.target})`}`)
    }
    return d
  }

  /** The one-time, advisory submission check; the board keeps the result, never the work. */
  #checkDeliverable(d: Deliverable): Promise<DeliverableCheck> {
    const contexts = Object.values(this.#config.contexts).filter((c): c is sdk.Ctx => c !== undefined)
    return checkDeliverable(d, {
      fetch: this.#config.fetch ?? ((...a) => fetch(...a)),
      now: () => this.#now(),
      chain: (chainId) => contexts.find((c) => c.deployment.chainId === chainId)?.publicClient,
    })
  }

  #now(): number {
    return this.#config.now?.() ?? Math.floor(Date.now() / 1000)
  }

  #ctx(stack: string): sdk.Ctx {
    const ctx = this.#config.contexts[stack as sdk.StackName]
    if (ctx === undefined) throw new BoardError('invalid', `stack "${stack}" is not deployed on ${this.#config.network}`)
    return ctx
  }

  /**
   * The chain context of a task's own pair: the Holding its frozen terms name. After a stacks-only redeploy a task
   * published on an earlier pair stays there (its listing, bonds and windows live on it), so its stack name alone
   * would point at the wrong contracts.
   */
  #taskCtx(task: TaskRow): sdk.Ctx {
    const holding = parseTerms(task.terms_json).deployment.holding
    const current = Object.values(this.#config.contexts).find((c) => c !== undefined && eq(c.stack.holding, holding))
    if (current !== undefined) return current
    const any = Object.values(this.#config.contexts).find((c) => c !== undefined)
    const legacy = sdk.stackByHolding(sdk.deployment(this.#config.network), holding)
    if (any !== undefined && legacy !== undefined) return { ...any, stack: legacy[1] }
    return this.#ctx(task.stack)
  }

  readonly #pausedCache = new Map<string, { at: number; paused: boolean }>()

  /** The core's pause flag, read at most every 15 s. While paused every core call reverts, so the board hands out none. */
  async paused(stack: sdk.StackName = 'main'): Promise<boolean> {
    const hit = this.#pausedCache.get(stack)
    if (hit !== undefined && this.#now() - hit.at < 15) return hit.paused
    const ctx = this.#ctx(stack)
    const paused = await ctx.publicClient.readContract({ address: ctx.deployment.core, abi: sdk.coreAbi, functionName: 'paused' })
    this.#pausedCache.set(stack, { at: this.#now(), paused })
    return paused
  }

  async #requireUnpaused(stack: string): Promise<void> {
    if (await this.paused(stack as sdk.StackName)) {
      throw new BoardError('conflict', 'the core contract is paused by its admin; nothing can move until it is unpaused (README, Trust)')
    }
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
      /** GitHub check names evidence must cover; they become the offer's evidence policy. */
      requiredChecks?: string[]
      /**
       * Hire only (ADR-0005): the worker may spend up to `cap` (decimal, in the token's units) of `token` from the
       * creator's Privy wallet until `expiresAt` (default: the delivery deadline). Bound into the terms hash.
       */
      executionBudget?: BudgetInput
      /** The deliverable forms accepted (ADR-0006); omitted means git only. Bound into the terms hash. */
      deliverable?: DeliverableSpec
    },
    /** Set only by `pickQuote`: the offer carries the request and the picked quote. */
    quote: { requestHash: Hex; quoteHash: Hex } | null = null,
  ) {
    const creator = this.#requireCaller(caller)
    const stack = input.stack ?? 'main'
    const ctx = this.#ctx(stack)
    await this.#requireUnpaused(stack)
    const token = await this.#resolveToken(ctx, input.token)
    const decimals = await ctx.publicClient.readContract({ address: token, abi: sdk.factoryTokenAbi, functionName: 'decimals' })
    const [review, dispute, arbitration, block] = await Promise.all([
      ctx.publicClient.readContract({ address: ctx.stack.evaluator, abi: sdk.jobsEvaluatorAbi, functionName: 'reviewWindow' }),
      ctx.publicClient.readContract({ address: ctx.stack.evaluator, abi: sdk.jobsEvaluatorAbi, functionName: 'disputeWindow' }),
      ctx.publicClient.readContract({ address: ctx.stack.evaluator, abi: sdk.jobsEvaluatorAbi, functionName: 'arbitrationWindow' }),
      ctx.publicClient.getBlockNumber(),
    ])
    const windows = { reviewSeconds: review, disputeSeconds: dispute, arbitrationSeconds: arbitration }
    const executionBudget = input.executionBudget === undefined ? undefined : await this.#executionBudget(ctx, input.executionBudget, input.deliveryDeadline)
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
      evidencePolicy:
        input.requiredChecks === undefined || input.requiredChecks.length === 0
          ? null
          : { checks: input.requiredChecks, trustedProducer: 'github-actions', workflowPath: '.github/workflows' },
      quote,
      ...(executionBudget === undefined ? {} : { executionBudget }),
      ...(input.deliverable === undefined ? {} : { deliverable: normalSpec(input.deliverable) }),
      salt: `0x${randomId(32)}`,
    }
    try {
      validateOffer(terms, windows, this.#now())
    } catch (e) {
      throw new BoardError('invalid', (e as Error).message)
    }
    const hash = termsHash(terms)
    const manifest = canonicalJson(terms)
    const symbol = await ctx.publicClient.readContract({ address: token, abi: sdk.factoryTokenAbi, functionName: 'symbol' })
    // "mEUR"/"mUSD" read as millions to a model; say what the unit is.
    const unit = this.#config.network === 'monad-testnet' ? ` (${symbol} is a testnet mock token worth about 1 ${symbol.replace(/^m/, '')} of play money; "m" means mock, not million)` : ''
    const screening = await screenOffer(this.#config.screening, terms, `${input.reward} ${symbol}${unit}`, this.#now())
    this.#sql.run(
      'INSERT INTO tasks (id, creator, stack, terms_json, terms_hash, job_id, publish_tx, from_block, created_at, screening_json) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)',
      taskId,
      creator,
      stack,
      manifest,
      hash,
      Number(block),
      this.#now(),
      JSON.stringify(screening),
    )
    this.#operation(taskId, 'publish', creator, { termsHash: hash })
    if (executionBudget !== undefined) this.#budget.promise(taskId, creator, executionBudget)

    const transactions = await this.#publishTransactions(ctx, creator, terms, hash as Hex)
    return {
      taskId,
      termsHash: hash,
      screening,
      manifestUrl: `${this.#config.manifestBaseUrl}/${hash}.json`,
      manifest,
      transactions,
      next: 'Send the transactions in order from the creator wallet, then report_transaction with the publish tx hash.',
    }
  }

  /** The approvals and the `publish` of one frozen offer, exactly as agreed (terms hash = manifest hash). */
  async #publishTransactions(ctx: sdk.Ctx, creator: Address, terms: OfferTerms, hash: Hex): Promise<TxRequest[]> {
    const token = terms.token
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
    return transactions
  }

  /**
   * Creator: the publish transactions of an offer that is frozen but not on-chain (a publish that reverted, e.g. an
   * underfunded wallet after `pick_quote`, or a lost client). Safe to repeat: the contract lists a terms hash once.
   */
  async publishTransactions(caller: Caller, input: { taskId: string }) {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    await this.#requireUnpaused(task.stack)
    if (!eq(task.creator, me)) throw new BoardError('forbidden', 'only the creator publishes')
    if (task.job_id !== null || (await this.#recoverPublish(task)) !== null) throw new BoardError('conflict', `already published as job ${task.job_id}`)
    return { transactions: await this.#publishTransactions(this.#taskCtx(task), me, parseTerms(task.terms_json), task.terms_hash as Hex) }
  }

  /** A requested budget as terms: the cap in the token's (or the native) units, the expiry defaulting to the deadline. */
  async #executionBudget(ctx: sdk.Ctx, b: BudgetInput, deliveryDeadline: number): Promise<ExecutionBudget> {
    const expiresAt = b.expiresAt ?? deliveryDeadline
    if (b.kind === 'call') {
      if (b.target === undefined || !isAddress(b.target)) throw new BoardError('invalid', 'a call budget needs the contract address (`target`)')
      if (b.function === undefined) throw new BoardError('invalid', 'a call budget needs the allowed `function`, e.g. "function create((string,string) params) payable"')
      let cap: bigint
      try {
        cap = parseUnits(b.cap, 18)
      } catch {
        throw new BoardError('invalid', 'the call budget cap must be a decimal amount of the native token')
      }
      const call: CallBudget = { kind: 'call', target: getAddress(b.target), function: b.function.trim(), cap, expiresAt }
      try {
        callFunction(call)
      } catch {
        throw new BoardError('invalid', '`function` must be one function in human-readable ABI form')
      }
      return call
    }
    if (b.kind !== 'advance') throw new BoardError('invalid', "an execution budget is an 'advance' or a 'call'")
    if (b.token === undefined) throw new BoardError('invalid', 'an advance needs its `token`')
    const token = await this.#advanceToken(ctx, b.token)
    const decimals = await ctx.publicClient.readContract({ address: token, abi: sdk.factoryTokenAbi, functionName: 'decimals' })
    let cap: bigint
    try {
      cap = parseUnits(b.cap, decimals)
    } catch {
      throw new BoardError('invalid', 'the advance cap must be a decimal number')
    }
    return { kind: 'advance', token, cap, expiresAt }
  }

  /** Any ERC-20 by address (it must answer `decimals`), or a reward token by symbol. */
  async #advanceToken(ctx: sdk.Ctx, token: string): Promise<Address> {
    if (!isAddress(token)) return this.#resolveToken(ctx, token)
    const t = getAddress(token)
    await ctx.publicClient.readContract({ address: t, abi: sdk.factoryTokenAbi, functionName: 'decimals' }).catch(() => {
      throw new BoardError('invalid', `${t} is not an ERC-20 on ${ctx.deployment.network}`)
    })
    return t
  }

  /** A base-unit amount as people read it: the token's symbol and a decimal amount. */
  async #displayAmount<T extends { token: Address; amount: string }>(ctx: sdk.Ctx, x: T): Promise<T & { symbol: string }> {
    const [symbol, decimals] = await Promise.all([
      ctx.publicClient.readContract({ address: x.token, abi: sdk.factoryTokenAbi, functionName: 'symbol' }),
      ctx.publicClient.readContract({ address: x.token, abi: sdk.factoryTokenAbi, functionName: 'decimals' }),
    ])
    return { ...x, symbol, amount: formatUnits(BigInt(x.amount), decimals) }
  }

  /**
   * A reward token by symbol (one of the known tokens) or by address: any ERC-20 that answers `symbol` and `decimals`
   * (ADR-0010). A token the deployment does not list needs a stack whose Holding is safe with any ERC-20.
   */
  async #resolveToken(ctx: sdk.Ctx, token: string): Promise<Address> {
    if (!isAddress(token)) {
      for (const t of ctx.deployment.rewardTokens) {
        const symbol = await ctx.publicClient.readContract({ address: t, abi: sdk.factoryTokenAbi, functionName: 'symbol' })
        if (symbol.toLowerCase() === token.toLowerCase()) return t
      }
      throw new BoardError('invalid', `"${token}" is not a known token symbol; name the token by its address (any ERC-20)`)
    }
    const t = getAddress(token)
    if (ctx.deployment.rewardTokens.some((r) => eq(r, t))) return t
    const symbol = await Promise.all([
      ctx.publicClient.readContract({ address: t, abi: sdk.factoryTokenAbi, functionName: 'symbol' }),
      ctx.publicClient.readContract({ address: t, abi: sdk.factoryTokenAbi, functionName: 'decimals' }),
    ]).then(
      ([sym]) => sym,
      () => {
        throw new BoardError('invalid', `${t} is not an ERC-20 on ${ctx.deployment.network}: it must answer symbol() and decimals()`)
      },
    )
    if (!ctx.stack.openTokens) {
      const open = Object.entries(ctx.deployment.stacks).filter(([, st]) => st?.openTokens).map(([name]) => name)
      throw new BoardError(
        'invalid',
        `${symbol} (${t}) is not a known token, and this stack's Holding predates open tokens (ADR-0010): publish it on ${open.length === 0 ? 'a redeployed stack' : `the ${open.join(' or ')} stack`}`,
      )
    }
    return t
  }

  /** Approvals a step needs, each for exactly its amount; the spender is JobHolding unless a need names another. */
  async #approvals(ctx: sdk.Ctx, owner: Address, needs: Array<[Address, bigint, string, spender?: [Address, string]]>): Promise<TxRequest[]> {
    const out: TxRequest[] = []
    for (const [token, amount, label, to] of needs) {
      if (amount === 0n) continue
      const [spender, spenderLabel] = to ?? [ctx.stack.holding, 'JobHolding']
      const allowance = await ctx.publicClient.readContract({
        address: token,
        abi: sdk.factoryTokenAbi,
        functionName: 'allowance',
        args: [owner, spender],
      })
      if (allowance >= amount) continue
      out.push(
        this.#tx(
          ctx,
          `approve ${label} for ${spenderLabel}`,
          token,
          // Exactly the amount this step needs, never an unlimited allowance a mismatched listing could draw on.
          encodeFunctionData({ abi: sdk.factoryTokenAbi, functionName: 'approve', args: [spender, amount] }),
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
    const ctx = this.#taskCtx(task)
    const receipt = await ctx.publicClient.getTransactionReceipt({ hash: input.txHash as Hex }).catch(() => undefined)
    if (receipt === undefined) throw new BoardError('chain', `no receipt yet for ${input.txHash}; retry shortly`)
    // Any other confirmed transaction from a party of this task confirms that party's latest prepared operation.
    // Only a transaction to this deployment that emitted an event for this job (jobId is the first indexed topic of
    // every lifecycle event) confirms anything; an unrelated transaction from the same wallet does not.
    const jobTopic = task.job_id === null ? null : pad(toHex(BigInt(task.job_id)), { size: 32 }).toLowerCase()
    // By the emitting contract, not the receipt's `to`: an EIP-7702 batch is a call to the sender itself.
    const ours = [ctx.deployment.core, ctx.stack.holding, ctx.stack.evaluator]
    const touchesJob =
      jobTopic !== null && receipt.logs.some((l) => ours.some((a) => eq(l.address, a)) && l.topics[1]?.toLowerCase() === jobTopic)
    if (task.job_id !== null && receipt.status === 'success' && touchesJob) {
      const [op] = this.#sql.all<OperationRow>(
        "SELECT * FROM operations WHERE task_id = ? AND lower(actor) = lower(?) AND status = 'prepared' ORDER BY created_at DESC LIMIT 1",
        task.id,
        receipt.from,
      )
      const known = this.#sql.all<OperationRow>('SELECT * FROM operations WHERE task_id = ? AND tx_hash = ?', task.id, input.txHash)
      if (op !== undefined && known.length === 0) {
        this.#sql.run(
          "UPDATE operations SET status = 'confirmed', tx_hash = ?, updated_at = ? WHERE id = ?",
          input.txHash,
          this.#now(),
          op.id,
        )
      }
    }
    // The core's JobSubmitted is the one deliverable that counts; record it for the evidence labels.
    for (const log of receipt.logs) {
      if (!eq(log.address, ctx.deployment.core)) continue
      try {
        const event = decodeEventLog({ abi: sdk.coreAbi, data: log.data, topics: log.topics })
        if (event.eventName === 'JobSubmitted' && task.job_id !== null && event.args.jobId === BigInt(task.job_id)) {
          this.#sql.run(
            'INSERT OR REPLACE INTO onchain_submissions (task_id, deliverable_hash, tx_hash) VALUES (?, ?, ?)',
            task.id,
            event.args.deliverable,
            input.txHash,
          )
        }
      } catch {
        // another event
      }
    }
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
    // A redemption of this task's execution-budget delegation (to the manager, or inside the worker's own batch).
    await this.#budget.observe({ task, terms: parseTerms(task.terms_json), ctx }, receipt)
    return this.getTask(caller, { taskId: input.taskId })
  }

  listApplications(caller: Caller, input: { taskId: string }) {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    if (!this.#actsForCreator(task, me)) throw new BoardError('forbidden', 'only the creator (or the pool’s curator) sees applications')
    return this.#sql.all<ApplicationRow>('SELECT * FROM applications WHERE task_id = ? ORDER BY created_at', task.id)
  }

  /** The Selection the creator signs to pick one applicant. Nothing is on-chain until the worker activates. */
  async selectWorker(caller: Caller, input: { taskId: string; applicationId: string; activateBy?: number }) {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    if (!this.#actsForCreator(task, me)) throw new BoardError('forbidden', 'only the creator (or the pool’s curator) selects')
    const terms = parseTerms(task.terms_json)
    if (terms.mode !== 'hire') throw new BoardError('invalid', 'contests are awarded, not selected')
    if (task.job_id === null) throw new BoardError('conflict', 'publish the offer first')
    const [app] = this.#sql.all<ApplicationRow>('SELECT * FROM applications WHERE id = ? AND task_id = ?', input.applicationId, task.id)
    if (app === undefined) throw new BoardError('not-found', 'no such application')
    const activateBy = input.activateBy ?? Math.min(this.#now() + 24 * 3600, terms.deliveryDeadline - 60)
    if (activateBy >= terms.deliveryDeadline) throw new BoardError('invalid', 'activateBy must precede the delivery deadline')
    const ctx = this.#taskCtx(task)
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
    if (!this.#actsForCreator(task, me)) throw new BoardError('forbidden', 'only the creator (or the pool’s curator) selects')
    const [sel] = this.#sql.all<SelectionRow>('SELECT * FROM selections WHERE task_id = ? AND nonce = ?', task.id, input.nonce)
    if (sel === undefined) throw new BoardError('not-found', 'no such pending selection')
    const ctx = this.#taskCtx(task)
    const valid = await ctx.publicClient.verifyTypedData({
      address: getAddress(task.creator),
      domain: sdk.holdingDomain(ctx.deployment.chainId, ctx.stack.holding),
      types: sdk.selectionTypes,
      primaryType: 'Selection',
      message: { ...this.#selection(task, sel) },
      signature: input.signature as Hex,
    })
    if (!valid) throw new BoardError('forbidden', 'the signature is not the creator’s over this selection (a pool accepts its curator’s, ERC-1271)')
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

  /**
   * Creator: withdraw an open hire nobody has activated. Holding's `cancel` ends it on-chain; `settle` in the same
   * list returns the reward and the creator bond (both permissionless-effect, one wallet run). A contest cannot be
   * cancelled: entrants work against the locked prize.
   */
  async cancelTask(caller: Caller, input: { taskId: string }) {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    await this.#requireUnpaused(task.stack)
    const terms = parseTerms(task.terms_json)
    if (!this.#actsForCreator(task, me)) throw new BoardError('forbidden', 'only the creator (or the pool’s curator) cancels')
    if (terms.mode !== 'hire') throw new BoardError('invalid', 'a published contest cannot be cancelled; it ends by award or expiry')
    const view = await this.#chainView(task)
    if (view.status !== 'open' && view.status !== 'lapsed') throw new BoardError('conflict', `only an open hire nobody activated can be cancelled (it is ${view.status})`)
    const ctx = this.#taskCtx(task)
    const jobId = this.#jobId(task)
    this.#operation(task.id, 'cancel', me)
    const pool = task.pool_id === null ? null : this.#poolRow(task.pool_id)
    return {
      transactions: [
        pool === null
          ? this.#tx(ctx, 'cancel: ends the listing before anyone activated it', ctx.stack.holding,
              encodeFunctionData({ abi: sdk.jobHoldingAbi, functionName: 'cancel', args: [jobId] }))
          : this.#tx(ctx, 'cancel: the curator ends the pool’s listing before anyone activated it (forwarded by the pool)', getAddress(pool.pool),
              encodeFunctionData({ abi: sdk.jobPoolAbi, functionName: 'cancel', args: [] })),
        this.#tx(ctx, pool === null ? 'settle: returns the reward and your bond' : 'settle: returns the reward to the pool; pledgers then call pool_refund', ctx.stack.holding,
          encodeFunctionData({ abi: sdk.jobHoldingAbi, functionName: 'settle', args: [jobId] })),
      ],
    }
  }

  // -----------------------------------------------------------------------------------------------
  // Pools (ADR-0007): a JobPool is the creator; its curator acts where the creator would
  // -----------------------------------------------------------------------------------------------

  /** The creator, or the curator of the pool that is the creator. */
  #actsForCreator(task: TaskRow, me: Address): boolean {
    if (eq(task.creator, me)) return true
    if (task.pool_id === null || task.pool_id === undefined) return false
    return eq(this.#poolRow(task.pool_id).curator, me)
  }

  #poolRow(poolId: string): PoolRow {
    const [row] = this.#sql.all<PoolRow>('SELECT * FROM pools WHERE id = ?', poolId)
    if (row === undefined) throw new BoardError('not-found', 'no such pool')
    return row
  }

  /**
   * Curator (or anyone): freeze an offer whose creator is a pool that does not exist yet, at the address the factory
   * will give it. The caller becomes the curator unless one is named: approver of the offer, signer of its
   * selections, the one who cancels. Returns the transactions that clone the pool (the FACTORY publish hold moves
   * in with it). Pledgers then `pledge`; anyone launches once the goal is reached.
   */
  async createPool(
    caller: Caller,
    input: Omit<Parameters<Board['createTask']>[1], 'reward' | 'creatorBond' | 'approver' | 'executionBudget'> & {
      /** The goal, in the token's units: the offer's reward. */
      goal: string
      /** Unix seconds; pledging closes here and a full pool may still launch for a day after. */
      pledgeDeadline: number
      curator?: string
    },
  ) {
    const me = this.#requireCaller(caller)
    const stack = input.stack ?? 'main'
    const ctx = this.#ctx(stack)
    const factory = ctx.deployment.poolFactory
    if (factory === null) throw new BoardError('invalid', `no JobPoolFactory on ${ctx.deployment.network}`)
    const curator = getAddress(input.curator ?? me)
    const now = this.#now()
    if (input.pledgeDeadline <= now + 60) throw new BoardError('invalid', 'the pledge deadline must be in the future')
    if (input.deliveryDeadline <= input.pledgeDeadline + 86_400) {
      throw new BoardError('invalid', 'the delivery deadline must lie at least a day past the pledge deadline (the launch grace)')
    }
    if (input.mode === 'contest' && (input.selectionDeadline ?? 0) <= input.pledgeDeadline + 86_400) {
      throw new BoardError('invalid', 'a pooled contest’s selection deadline must lie past the launch grace (pledge deadline + 1 day)')
    }
    const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
    const pool = await sdk.predictPool(ctx, me, salt)
    const { goal, pledgeDeadline, curator: _c, ...offer } = input
    const created = await this.createTask({ address: pool }, { ...offer, stack, reward: goal, creatorBond: '0', approver: curator })
    const task = this.#task(created.taskId)
    const terms = parseTerms(task.terms_json)
    this.#sql.run(
      'INSERT INTO pools (id, task_id, factory, salt, pool, curator, token, goal, pledge_deadline, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      task.id, task.id, factory, salt, pool, curator, terms.token, terms.reward.toString(), pledgeDeadline, now,
    )
    this.#sql.run('UPDATE tasks SET pool_id = ? WHERE id = ?', task.id, task.id)
    this.#operation(task.id, 'create-pool', me, { pool, curator, salt })
    const params = await sdk.poolParams(ctx, {
      salt,
      curator,
      goal: terms.reward,
      pledgeDeadline,
      publish: {
        mode: terms.mode,
        token: terms.token,
        workerBond: terms.workerBond,
        manifestHash: task.terms_hash as Hex,
        termsHash: task.terms_hash as Hex,
        deliveryDeadline: terms.deliveryDeadline,
        ...(typeof terms.selectionDeadline === 'number' ? { selectionDeadline: terms.selectionDeadline } : {}),
      },
    })
    const hold = await ctx.publicClient.readContract({ address: ctx.stack.holding, abi: sdk.jobHoldingAbi, functionName: 'minHoldToPublish' })
    const transactions: TxRequest[] = [
      ...(await this.#approvals(ctx, me, [[ctx.deployment.factory, hold, 'FACTORY (the publish hold, held by the pool and returned after)', [factory, 'the pool factory']]])),
      this.#tx(ctx, 'create pool: clones the pool at its predicted address and moves the hold in', factory,
        encodeFunctionData({ abi: sdk.jobPoolFactoryAbi, functionName: 'create', args: [salt, params] })),
    ]
    return {
      poolId: task.id,
      taskId: task.id,
      termsHash: task.terms_hash,
      pool,
      curator,
      goal: terms.reward.toString(),
      token: terms.token,
      pledgeDeadline,
      manifestUrl: created.manifestUrl,
      transactions,
      next: 'Send the transactions from your wallet. Pledgers call pledge; once the goal is reached anyone calls launch_pool and reports its hash with report_transaction.',
    }
  }

  /** Anyone: the approval and the pledge of `amount` (decimal, in the token's units); the pool caps it to the goal. */
  async pledge(caller: Caller, input: { poolId: string; amount: string }) {
    const me = this.#requireCaller(caller)
    const row = this.#poolRow(input.poolId)
    const task = this.#task(row.task_id)
    const ctx = this.#taskCtx(task)
    const token = getAddress(row.token)
    const decimals = await ctx.publicClient.readContract({ address: token, abi: sdk.factoryTokenAbi, functionName: 'decimals' })
    const amount = parseUnits(input.amount, decimals)
    if (amount <= 0n) throw new BoardError('invalid', 'amount must be positive')
    const pool = getAddress(row.pool)
    return {
      transactions: [
        ...(await this.#approvals(ctx, me, [[token, amount, 'reward token (the pledge)', [pool, 'the pool']]])),
        this.#tx(ctx, 'pledge: puts the amount into the pool (capped to what the goal still needs)', pool,
          encodeFunctionData({ abi: sdk.jobPoolAbi, functionName: 'pledge', args: [amount] })),
      ],
    }
  }

  /** Anyone, once the goal is reached: the launch transaction. Report its hash with report_transaction. */
  launchPool(caller: Caller, input: { poolId: string }) {
    this.#requireCaller(caller)
    const row = this.#poolRow(input.poolId)
    const task = this.#task(row.task_id)
    const ctx = this.#taskCtx(task)
    return {
      taskId: task.id,
      transactions: [
        this.#tx(ctx, 'launch: the pool publishes the offer as its creator, the curator as approver', getAddress(row.pool),
          encodeFunctionData({ abi: sdk.jobPoolAbi, functionName: 'launch', args: [] })),
      ],
    }
  }

  /** A pledger: the refund transaction (whatever came back to the pool, pro rata), plus the hold reclaim. */
  poolRefund(caller: Caller, input: { poolId: string }) {
    this.#requireCaller(caller)
    const row = this.#poolRow(input.poolId)
    const task = this.#task(row.task_id)
    const ctx = this.#taskCtx(task)
    const pool = getAddress(row.pool)
    return {
      transactions: [
        this.#tx(ctx, 'refund: your share of what came back to the pool (settles the listing first if needed)', pool,
          encodeFunctionData({ abi: sdk.jobPoolAbi, functionName: 'refund', args: [] })),
      ],
      reclaimHold: this.#tx(ctx, 'reclaim hold: returns the FACTORY publish hold to the pool’s creator (anyone, once the pool is over)', pool,
        encodeFunctionData({ abi: sdk.jobPoolAbi, functionName: 'reclaimHold', args: [] })),
    }
  }

  async #poolView(row: PoolRow) {
    const task = this.#task(row.task_id)
    const ctx = this.#taskCtx(task)
    const pool = getAddress(row.pool)
    const code = await ctx.publicClient.getCode({ address: pool })
    const terms = parseTerms(task.terms_json)
    const base = {
      poolId: row.id,
      taskId: row.task_id,
      title: terms.title,
      mode: terms.mode,
      stack: task.stack,
      pool,
      curator: row.curator,
      token: row.token,
      goal: row.goal,
      pledgeDeadline: row.pledge_deadline,
      jobId: task.job_id,
    }
    if (code === undefined || code === '0x') return { ...base, phase: 'pending' as const, totalPledged: '0', paidOut: '0', refundable: false }
    const s = await sdk.getPool(ctx, pool)
    return {
      ...base,
      phase: s.phase,
      totalPledged: s.totalPledged.toString(),
      paidOut: s.paidOut.toString(),
      refundable: s.refundable,
      launchedAt: s.launchedAt,
      cancelledAt: s.cancelledAt,
      jobId: task.job_id ?? (s.jobId === 0n ? null : s.jobId.toString()),
    }
  }

  async listPools(caller: Caller, input: { limit?: number }) {
    void caller
    const rows = this.#sql.all<PoolRow>('SELECT * FROM pools ORDER BY created_at DESC LIMIT ?', Math.min(input.limit ?? 50, 200))
    return { pools: await Promise.all(rows.map((r) => this.#poolView(r))) }
  }

  async getPool(caller: Caller, input: { poolId: string }) {
    void caller
    return this.#poolView(this.#poolRow(input.poolId))
  }

  /** What a wallet pledged, from the chain. */
  async pledgedBy(caller: Caller, input: { poolId: string; address?: string }) {
    const who = input.address === undefined ? this.#requireCaller(caller) : getAddress(input.address)
    const row = this.#poolRow(input.poolId)
    const ctx = this.#taskCtx(this.#task(row.task_id))
    const code = await ctx.publicClient.getCode({ address: getAddress(row.pool) })
    if (code === undefined || code === '0x') return { address: who, pledged: '0' }
    return { address: who, pledged: (await sdk.pledgedBy(ctx, getAddress(row.pool), who)).toString() }
  }

  async approveWork(caller: Caller, input: { taskId: string }) {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    await this.#requireUnpaused(task.stack)
    const terms = parseTerms(task.terms_json)
    if (!eq(terms.approver, me)) throw new BoardError('forbidden', 'only the approver accepts')
    const ctx = this.#taskCtx(task)
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
    await this.#requireUnpaused(task.stack)
    const terms = parseTerms(task.terms_json)
    if (!eq(terms.approver, me)) throw new BoardError('forbidden', 'only the approver rejects')
    if (!(input.violation in sdk.Violation)) throw new BoardError('invalid', 'violation is None, Quality or Falsified')
    const reasonHash = sdk.hashText(input.reason)
    this.#sql.run('INSERT OR IGNORE INTO reasons (hash, task_id, text, created_at) VALUES (?, ?, ?, ?)', reasonHash, task.id, input.reason, this.#now())
    const ctx = this.#taskCtx(task)
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
  // Quotes (quote-to-hire, ADR-0004)
  // -----------------------------------------------------------------------------------------------

  /**
   * A quote request: "Accepting quotes — reward not escrowed". It names the work, the accepted reward tokens, both
   * bonds and the deadlines; bidders answer with one token and an exact amount. Nothing moves until a pick.
   */
  async requestQuotes(
    caller: Caller,
    input: {
      title: string
      brief: string
      acceptanceCriteria: string[]
      tokens: string[]
      creatorBond: string
      workerBond: string
      deliveryDeadline: number
      quoteDeadline: number
      stack?: sdk.StackName
      approver?: string
      requiredChecks?: string[]
      /** The deliverable forms accepted (ADR-0006); the picked hire inherits them. */
      deliverable?: DeliverableSpec
    },
  ) {
    const creator = this.#requireCaller(caller)
    const stack = input.stack ?? 'main'
    const ctx = this.#ctx(stack)
    if (input.tokens.length === 0) throw new BoardError('invalid', 'name at least one accepted token')
    const tokens = await Promise.all(input.tokens.map((t) => this.#resolveToken(ctx, t)))
    const now = this.#now()
    if (input.quoteDeadline <= now || input.quoteDeadline >= input.deliveryDeadline) {
      throw new BoardError('invalid', 'the quote deadline must be in the future and before the delivery deadline')
    }
    const request = {
      v: 1,
      chainId: ctx.deployment.chainId,
      stack,
      creator,
      approver: input.approver === undefined ? creator : getAddress(input.approver),
      title: input.title,
      brief: input.brief,
      acceptanceCriteria: input.acceptanceCriteria,
      tokens,
      creatorBond: input.creatorBond,
      workerBond: input.workerBond,
      deliveryDeadline: input.deliveryDeadline,
      quoteDeadline: input.quoteDeadline,
      requiredChecks: input.requiredChecks ?? [],
      ...(input.deliverable === undefined ? {} : { deliverable: normalSpec(input.deliverable) }),
      salt: `0x${randomId(32)}`,
    }
    const requestJson = canonicalJson(request)
    const requestHash = sdk.hashText(requestJson)
    const id = randomId(8)
    this.#sql.run(
      'INSERT INTO quote_requests (id, creator, stack, request_json, request_hash, quote_deadline, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)',
      id, creator, stack, requestJson, requestHash, input.quoteDeadline, now,
    )
    return { requestId: id, requestHash, status: 'Accepting quotes — reward not escrowed', next: 'Wait for quotes; list_quotes, then pick_quote.' }
  }

  #quoteRequest(requestId: string): QuoteRequestRow {
    const [row] = this.#sql.all<QuoteRequestRow>('SELECT * FROM quote_requests WHERE id = ?', requestId)
    if (row === undefined) throw new BoardError('not-found', `no quote request ${requestId}`)
    return row
  }

  /** Open requests anyone can read (the work, accepted tokens, bonds, deadlines); quotes themselves stay private. */
  listQuoteRequests(_caller: Caller) {
    return this.#sql
      .all<QuoteRequestRow>('SELECT * FROM quote_requests WHERE task_id IS NULL AND quote_deadline > ? ORDER BY created_at DESC LIMIT 50', this.#now())
      .map((r) => ({ requestId: r.id, requestHash: r.request_hash, status: 'Accepting quotes — reward not escrowed', ...(JSON.parse(r.request_json) as object) }))
  }

  /** A bidder's quote: one accepted token and an exact amount. A later quote from the same bidder replaces it. */
  async submitQuote(
    caller: Caller,
    input: {
      requestId: string
      agentId: string
      token: string
      amount: string
      note?: string
      /** Optional (ADR-0005): what the work is expected to cost to run, in any ERC-20; not part of the price. */
      expectedCosts?: { token: string; amount: string; note?: string }
    },
  ) {
    const me = this.#requireCaller(caller)
    const req = this.#quoteRequest(input.requestId)
    if (req.task_id !== null) throw new BoardError('conflict', 'a quote was already picked')
    if (this.#now() >= req.quote_deadline) throw new BoardError('conflict', 'the quote deadline has passed')
    const ctx = this.#ctx(req.stack)
    const request = JSON.parse(req.request_json) as { tokens: Address[] }
    const token = await this.#resolveToken(ctx, input.token)
    if (!request.tokens.some((t) => eq(t, token))) throw new BoardError('invalid', 'that token is not accepted by this request')
    const agentWallet = await sdk.agentWallet(ctx, BigInt(input.agentId)).catch(() => zeroAddress)
    if (!eq(agentWallet, me)) throw new BoardError('forbidden', `agent ${input.agentId}'s registered wallet is ${agentWallet}, not ${me}`)
    const decimals = await ctx.publicClient.readContract({ address: token, abi: sdk.factoryTokenAbi, functionName: 'decimals' })
    let amount: bigint
    try {
      amount = parseUnits(input.amount, decimals)
    } catch {
      throw new BoardError('invalid', 'amount must be a decimal number')
    }
    if (amount <= 0n) throw new BoardError('invalid', 'the amount must be positive')
    let expectedCosts: { token: Address; amount: string; note: string } | undefined
    if (input.expectedCosts !== undefined) {
      const costToken = await this.#resolveToken(ctx, input.expectedCosts.token)
      const costDecimals = await ctx.publicClient.readContract({ address: costToken, abi: sdk.factoryTokenAbi, functionName: 'decimals' })
      let cost: bigint
      try {
        cost = parseUnits(input.expectedCosts.amount, costDecimals)
      } catch {
        throw new BoardError('invalid', 'expected costs must be a decimal number')
      }
      if (cost <= 0n) throw new BoardError('invalid', 'expected costs must be positive (omit them for none)')
      expectedCosts = { token: costToken, amount: cost.toString(), note: input.expectedCosts.note ?? '' }
    }
    // Declared costs enter the hash only when present, so a quote without them hashes as before.
    const quote = {
      requestHash: req.request_hash,
      worker: me,
      agentId: input.agentId,
      token,
      amount: amount.toString(),
      note: input.note ?? '',
      ...(expectedCosts === undefined ? {} : { expectedCosts }),
    }
    const quoteHash = sdk.hashText(canonicalJson(quote))
    const id = randomId(8)
    const costsJson = expectedCosts === undefined ? null : JSON.stringify(expectedCosts)
    this.#sql.run(
      `INSERT INTO quotes (id, request_id, worker, agent_id, token, amount, note, quote_hash, created_at, expected_costs_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (request_id, worker) DO UPDATE SET agent_id = excluded.agent_id, token = excluded.token, amount = excluded.amount, note = excluded.note, quote_hash = excluded.quote_hash, created_at = excluded.created_at, expected_costs_json = excluded.expected_costs_json`,
      id, req.id, me, input.agentId, token, amount.toString(), quote.note, quoteHash, this.#now(), costsJson,
    )
    const [row] = this.#sql.all<QuoteRow>('SELECT * FROM quotes WHERE request_id = ? AND worker = ?', req.id, me)
    return { quoteId: row?.id ?? id, quoteHash, next: 'If the publisher picks your quote, the offer is published and you are selected; then prepare_activation.' }
  }

  /** The publisher sees every quote on its request; a bidder sees only its own. */
  async listQuotes(caller: Caller, input: { requestId: string }) {
    const me = this.#requireCaller(caller)
    const req = this.#quoteRequest(input.requestId)
    const all = eq(req.creator, me)
    const ctx = this.#ctx(req.stack)
    const out = []
    for (const q of this.#sql.all<QuoteRow>('SELECT * FROM quotes WHERE request_id = ? ORDER BY created_at', req.id)) {
      if (!all && !eq(q.worker, me)) continue
      const [symbol, decimals] = await Promise.all([
        ctx.publicClient.readContract({ address: q.token as Address, abi: sdk.factoryTokenAbi, functionName: 'symbol' }),
        ctx.publicClient.readContract({ address: q.token as Address, abi: sdk.factoryTokenAbi, functionName: 'decimals' }),
      ])
      out.push({
        quoteId: q.id,
        worker: q.worker,
        agentId: q.agent_id,
        token: q.token,
        symbol,
        amount: formatUnits(BigInt(q.amount), decimals),
        note: q.note,
        expectedCosts: q.expected_costs_json === null ? null : await this.#displayAmount(ctx, JSON.parse(q.expected_costs_json) as { token: Address; amount: string; note: string }),
        quoteHash: q.quote_hash,
      })
    }
    return { requestId: req.id, requestHash: req.request_hash, picked: req.task_id, quotes: out }
  }

  /**
   * The publisher picks a quote (no automatic lowest bid): the ordinary escrow-backed offer is frozen with the quote's
   * token and amount and both hashes, and the bidder's application is recorded. Then: send the publish transactions,
   * report_transaction, select_worker with the returned applicationId, submit_selection.
   */
  async pickQuote(
    caller: Caller,
    input: {
      requestId: string
      quoteId: string
      /**
       * The execution budget the creator approves (ADR-0005), possibly less than the worker declared. The token
       * defaults to the declared costs' token, else the reward token; the expiry to the delivery deadline.
       */
      executionBudget?: BudgetInput
    },
  ) {
    const me = this.#requireCaller(caller)
    const req = this.#quoteRequest(input.requestId)
    if (!eq(req.creator, me)) throw new BoardError('forbidden', 'only the requester picks a quote')
    if (req.task_id !== null) throw new BoardError('conflict', `already picked: task ${req.task_id}`)
    const [q] = this.#sql.all<QuoteRow>('SELECT * FROM quotes WHERE id = ? AND request_id = ?', input.quoteId, req.id)
    if (q === undefined) throw new BoardError('not-found', 'no such quote')
    const ctx = this.#ctx(req.stack)
    const r = JSON.parse(req.request_json) as {
      title: string; brief: string; acceptanceCriteria: string[]; creatorBond: string; workerBond: string
      deliveryDeadline: number; approver: Address; requiredChecks: string[]; deliverable?: DeliverableSpec
    }
    const decimals = await ctx.publicClient.readContract({ address: q.token as Address, abi: sdk.factoryTokenAbi, functionName: 'decimals' })
    const created = await this.createTask(
      caller,
      {
        title: r.title,
        brief: r.brief,
        acceptanceCriteria: r.acceptanceCriteria,
        token: q.token,
        reward: formatUnits(BigInt(q.amount), decimals),
        creatorBond: r.creatorBond,
        workerBond: r.workerBond,
        deliveryDeadline: r.deliveryDeadline,
        mode: 'hire',
        stack: req.stack as sdk.StackName,
        approver: r.approver,
        ...(r.requiredChecks.length === 0 ? {} : { requiredChecks: r.requiredChecks }),
        ...(r.deliverable === undefined ? {} : { deliverable: r.deliverable }),
        ...(input.executionBudget === undefined
          ? {}
          : {
              executionBudget:
                input.executionBudget.kind === 'call'
                  ? input.executionBudget
                  : {
                      ...input.executionBudget,
                      token: input.executionBudget.token ?? (q.expected_costs_json === null ? q.token : (JSON.parse(q.expected_costs_json) as { token: string }).token),
                    },
            }),
      },
      { requestHash: req.request_hash as Hex, quoteHash: q.quote_hash as Hex },
    )
    this.#sql.run('UPDATE quote_requests SET task_id = ? WHERE id = ?', created.taskId, req.id)
    const applicationId = randomId(8)
    this.#sql.run(
      'INSERT INTO applications (id, task_id, worker, agent_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      applicationId, created.taskId, q.worker, q.agent_id, `picked quote ${q.id}`, this.#now(),
    )
    return { ...created, applicationId, next: 'Send the transactions, report_transaction with the publish hash, then select_worker({taskId, applicationId}).' }
  }

  // -----------------------------------------------------------------------------------------------
  // Worker
  // -----------------------------------------------------------------------------------------------

  /**
   * Refuses to prepare a worker's commitment against a listing that differs from the frozen offer: the contract keys
   * a listing by `policyHash` only, so a creator could publish the board's terms hash with, e.g., a larger worker
   * bond. The worker signs and approves exactly the offer's amounts, never the listing's.
   */
  async #requireListingMatches(task: TaskRow) {
    const view = await this.#chainView(task)
    if (view.listingMatchesOffer !== true) {
      throw new BoardError('conflict', 'the on-chain listing does not match the published offer (reward, bonds, deadlines or approver); do not take this job')
    }
    return view
  }

  /** Applies with a registered ERC-8004 agent whose agent wallet is the signed-in wallet. */
  async apply(caller: Caller, input: { taskId: string; agentId: string; note?: string }) {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    if (task.job_id === null && (await this.#recoverPublish(task)) === null) throw new BoardError('conflict', 'this offer is not funded on-chain yet')
    await this.#requireListingMatches(task)
    const ctx = this.#taskCtx(task)
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
    await this.#requireUnpaused(task.stack)
    const sel = this.#liveSelectionFor(task, me)
    await this.#requireListingMatches(task)
    const ctx = this.#taskCtx(task)
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
      next: 'Sign the typed data, then build_activation({ taskId, budgetSignature }): it returns any approval still missing and activate, which a batching wallet sends as one transaction. Or send the approval now, then sign and build.',
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
    await this.#requireUnpaused(task.stack)
    const sel = this.#liveSelectionFor(task, me)
    await this.#requireListingMatches(task)
    const [prep] = this.#sql.all<{ nonce: string; budget_nonce: string; budget_deadline: number }>(
      'SELECT nonce, budget_nonce, budget_deadline FROM activation_preps WHERE task_id = ? AND worker = ?',
      task.id,
      me,
    )
    if (prep === undefined || prep.nonce !== sel.nonce) throw new BoardError('conflict', 'call prepare_activation first')
    const ctx = this.#taskCtx(task)
    const terms = parseTerms(task.terms_json)
    this.#operation(task.id, 'activate', me, { selectionNonce: sel.nonce })
    return {
      transactions: [
        // Any approval not sent yet: a wallet that batches (EIP-7702) signs first and sends approve + activate as
        // one transaction; one that already sent prepare_activation's approval gets none here.
        ...(await this.#approvals(ctx, me, [[ctx.deployment.factory, terms.workerBond, 'FACTORY (worker bond)']])),
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
      next: 'Send them in order (or as one batch) from your wallet, then report_transaction for each hash.',
    }
  }

  /** Records the deliverable (public fork, branch, full SHA) and returns the final `submit` transaction. */
  async submitWork(caller: Caller, input: { taskId: string; deliverable?: unknown; repo?: string; branch?: string; sha?: string }) {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    await this.#requireUnpaused(task.stack)
    const ctx = this.#taskCtx(task)
    const job = await sdk.getJob(ctx, this.#jobId(task))
    if (!eq(job.provider, me)) throw new BoardError('forbidden', 'only the activated worker submits')
    const deliverable = this.#acceptedDeliverable(parseTerms(task.terms_json), input)
    const deliverableHash = hashDeliverable(deliverable)
    const check = await this.#checkDeliverable(deliverable)
    const cols = legacyColumns(deliverable)
    this.#sql.run(
      `INSERT INTO deliverables (task_id, worker, deliverable_hash, repo, branch, sha, kind, descriptor_json, check_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (task_id, deliverable_hash) DO UPDATE SET check_json = excluded.check_json`,
      task.id, me, deliverableHash, cols.repo, cols.branch, cols.sha, deliverable.kind, canonicalJson(deliverable), JSON.stringify(check), this.#now(),
    )
    this.#operation(task.id, 'submit', me, { deliverableHash })
    return {
      deliverableHash,
      deliverable,
      check,
      transactions: [
        this.#tx(ctx, 'submit: your one final submission of this deliverable', ctx.deployment.core,
          encodeFunctionData({ abi: sdk.coreAbi, functionName: 'submit', args: [this.#jobId(task), deliverableHash, '0x'] })),
      ],
    }
  }

  /** The worker disputes; an optional statement goes into the dispute bundle the arbitrator reads. */
  async disputeRejection(caller: Caller, input: { taskId: string; statement?: string }) {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    await this.#requireUnpaused(task.stack)
    const ctx = this.#taskCtx(task)
    if (input.statement !== undefined && input.statement.trim() !== '') {
      // Stored under the worker's role only for the job's provider: the bundle's roles are what the arbiter weighs.
      const view = await this.#chainView(task)
      if (!eq(view.provider ?? zeroAddress, me)) throw new BoardError('forbidden', 'only the worker disputes and adds a worker statement')
      this.#statement(task, me, 'worker', input.statement)
    }
    this.#operation(task.id, 'dispute', me)
    return {
      transactions: [
        this.#tx(ctx, 'dispute: freezes acceptance; only a ruling or the arbitration timeout settles', ctx.stack.evaluator,
          encodeFunctionData({ abi: sdk.jobsEvaluatorAbi, functionName: 'dispute', args: [this.#jobId(task)] })),
      ],
    }
  }

  /** A party's statement for the arbitrator (creator, approver or worker), while a rejection is pending or disputed. */
  async addStatement(caller: Caller, input: { taskId: string; text: string }) {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    const view = await this.#chainView(task)
    if (view.status !== 'rejected-pending' && view.status !== 'disputed') throw new BoardError('conflict', `nothing to argue: the task is ${view.status}`)
    const roles = this.#roles(parseTerms(task.terms_json), view, me)
    if (roles.length === 0) throw new BoardError('forbidden', 'only the creator, approver or worker adds statements')
    this.#statement(task, me, roles.join('+'), input.text)
    return { ok: true }
  }

  #statement(task: TaskRow, author: Address, role: string, text: string) {
    if (text.length > 4000) throw new BoardError('invalid', 'a statement is at most 4000 characters')
    this.#sql.run('INSERT INTO statements (id, task_id, author, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?)', randomId(8), task.id, author, role, text, this.#now())
  }

  // -----------------------------------------------------------------------------------------------
  // Contest: finished entries and the approver's atomic award
  // -----------------------------------------------------------------------------------------------

  /**
   * An entrant's finished candidate: the board records it and returns the two core authorisations to sign once
   * (budget = the prize, submit = exactly this deliverable), valid until the selection deadline. After
   * `submit_entry` the entrant is done: an award pays it with the entrant offline.
   */
  async prepareEntry(caller: Caller, input: { taskId: string; agentId: string; deliverable?: unknown; repo?: string; branch?: string; sha?: string }) {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    const terms = parseTerms(task.terms_json)
    if (terms.mode !== 'contest') throw new BoardError('invalid', 'this task is a hire; apply instead')
    const view = await this.#requireListingMatches(task)
    if (view.status !== 'open') throw new BoardError('conflict', `the contest is ${view.status}`)
    const ctx = this.#taskCtx(task)
    const agentWallet = await sdk.agentWallet(ctx, BigInt(input.agentId)).catch(() => zeroAddress)
    if (!eq(agentWallet, me)) throw new BoardError('forbidden', `agent ${input.agentId}'s registered wallet is ${agentWallet}, not ${me}`)
    const deliverable = this.#acceptedDeliverable(terms, input)
    const deliverableHash = hashDeliverable(deliverable)
    const check = await this.#checkDeliverable(deliverable)
    const cols = legacyColumns(deliverable)
    const deadline = terms.selectionDeadline ?? 0
    const id = randomId(8)
    const budgetNonce = randomUint(9)
    const submitNonce = randomUint(9)
    this.#sql.run(
      `INSERT INTO candidates (id, task_id, worker, agent_id, deliverable_hash, repo, branch, sha, kind, descriptor_json, check_json, deadline, budget_nonce, submit_nonce, budget_sig, submit_sig, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
       ON CONFLICT (task_id, worker, deliverable_hash) DO UPDATE SET agent_id = excluded.agent_id, check_json = excluded.check_json, budget_nonce = excluded.budget_nonce, submit_nonce = excluded.submit_nonce, budget_sig = NULL, submit_sig = NULL`,
      id, task.id, me, input.agentId, deliverableHash, cols.repo, cols.branch, cols.sha, deliverable.kind, canonicalJson(deliverable), JSON.stringify(check), deadline,
      budgetNonce.toString(), submitNonce.toString(), this.#now(),
    )
    const [row] = this.#sql.all<CandidateRow>('SELECT * FROM candidates WHERE task_id = ? AND worker = ? AND deliverable_hash = ?', task.id, me, deliverableHash)
    const candidate = row as CandidateRow
    const core = sdk.coreDomain(ctx.deployment.chainId, ctx.deployment.core)
    return {
      candidateId: candidate.id,
      deliverableHash,
      deliverable,
      check,
      sign: [
        {
          description: 'SetBudgetAuthorization for exactly the prize (used only if you are awarded)',
          typedData: typedDataJson(core, sdk.setBudgetTypes, 'SetBudgetAuthorization', {
            signer: me, jobId: this.#jobId(task), token: terms.token, amount: terms.reward,
            optParamsHash: sdk.EMPTY_HASH, nonce: BigInt(candidate.budget_nonce), deadline: BigInt(deadline),
          }),
        },
        {
          description: 'SubmitAuthorization for exactly this deliverable (used only if you are awarded)',
          typedData: typedDataJson(core, sdk.submitTypes, 'SubmitAuthorization', {
            signer: me, jobId: this.#jobId(task), deliverable: deliverableHash,
            optParamsHash: sdk.EMPTY_HASH, nonce: BigInt(candidate.submit_nonce), deadline: BigInt(deadline),
          }),
        },
      ] satisfies SignRequest[],
      next: 'Sign both, then submit_entry({taskId, candidateId, budgetSignature, submitSignature}). Nothing else is needed from you.',
    }
  }

  /** Stores an entry's two signed authorisations after checking both recover to the entrant. */
  async submitEntry(caller: Caller, input: { taskId: string; candidateId: string; budgetSignature: string; submitSignature: string }) {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    const c = this.#candidate(task.id, input.candidateId)
    if (!eq(c.worker, me)) throw new BoardError('forbidden', 'not your candidate')
    const ctx = this.#taskCtx(task)
    const terms = parseTerms(task.terms_json)
    const domain = sdk.coreDomain(ctx.deployment.chainId, ctx.deployment.core)
    const budgetOk = await ctx.publicClient.verifyTypedData({
      address: me, domain, types: sdk.setBudgetTypes, primaryType: 'SetBudgetAuthorization',
      message: { signer: me, jobId: this.#jobId(task), token: terms.token, amount: terms.reward, optParamsHash: sdk.EMPTY_HASH, nonce: BigInt(c.budget_nonce), deadline: BigInt(c.deadline) },
      signature: input.budgetSignature as Hex,
    })
    const submitOk = await ctx.publicClient.verifyTypedData({
      address: me, domain, types: sdk.submitTypes, primaryType: 'SubmitAuthorization',
      message: { signer: me, jobId: this.#jobId(task), deliverable: c.deliverable_hash as Hex, optParamsHash: sdk.EMPTY_HASH, nonce: BigInt(c.submit_nonce), deadline: BigInt(c.deadline) },
      signature: input.submitSignature as Hex,
    })
    if (!budgetOk || !submitOk) throw new BoardError('forbidden', 'a signature does not match your entry')
    this.#sql.run('UPDATE candidates SET budget_sig = ?, submit_sig = ? WHERE id = ?', input.budgetSignature, input.submitSignature, c.id)
    return { ok: true, candidateId: c.id, deliverableHash: c.deliverable_hash }
  }

  #candidate(taskId: string, candidateId: string): CandidateRow {
    const [c] = this.#sql.all<CandidateRow>('SELECT * FROM candidates WHERE id = ? AND task_id = ?', candidateId, taskId)
    if (c === undefined) throw new BoardError('not-found', 'no such candidate')
    return c
  }

  /** The approver and creator see every complete entry; an entrant sees its own. */
  listCandidates(caller: Caller, input: { taskId: string }) {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    const terms = parseTerms(task.terms_json)
    const all = eq(terms.approver, me) || eq(terms.creator, me)
    const rows = this.#sql.all<CandidateRow>(
      'SELECT * FROM candidates WHERE task_id = ? AND budget_sig IS NOT NULL AND submit_sig IS NOT NULL ORDER BY created_at',
      task.id,
    )
    return rows
      .filter((r) => all || eq(r.worker, me))
      .map((r) => {
        const v = deliverableView(r)
        return { candidateId: r.id, worker: r.worker, agentId: r.agent_id, repo: r.repo, branch: r.branch, sha: r.sha, deliverableHash: r.deliverable_hash, descriptor: v.descriptor, check: v.check }
      })
  }

  /** The approver's award: pays the chosen entry in one transaction; any failure leaves the contest open. */
  async awardCandidate(caller: Caller, input: { taskId: string; candidateId: string }) {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    await this.#requireUnpaused(task.stack)
    const terms = parseTerms(task.terms_json)
    if (!eq(terms.approver, me)) throw new BoardError('forbidden', 'only the approver awards')
    const c = this.#candidate(task.id, input.candidateId)
    if (c.budget_sig === null || c.submit_sig === null) throw new BoardError('conflict', 'the entry is not complete')
    const ctx = this.#taskCtx(task)
    this.#operation(task.id, 'award', me, { candidateId: c.id })
    const auth = (nonce: string, sig: string) => ({ signer: getAddress(c.worker), nonce: BigInt(nonce), deadline: BigInt(c.deadline), sig: sig as Hex })
    return {
      transactions: [
        this.#tx(ctx, 'award: pays this entry and closes the contest in one transaction', ctx.stack.holding,
          encodeFunctionData({
            abi: sdk.jobHoldingAbi,
            functionName: 'award',
            args: [this.#jobId(task), {
              worker: getAddress(c.worker),
              agentId: BigInt(c.agent_id),
              deliverable: c.deliverable_hash as Hex,
              budgetAuth: auth(c.budget_nonce, c.budget_sig),
              submitAuth: auth(c.submit_nonce, c.submit_sig),
            }],
          })),
      ],
      next: 'Send it, then report_transaction.',
    }
  }

  // -----------------------------------------------------------------------------------------------
  // Evidence (the attester)
  // -----------------------------------------------------------------------------------------------

  /**
   * The attester reads the GitHub check runs of a deliverable's exact SHA (a contest candidate, or a hire's
   * recorded deliverable), signs an `EvidenceAttestation` bound to this offer's policy and that deliverable, and the
   * relay attaches it on-chain. Evidence is advisory: it moves no money and gates nothing.
   */
  async requestEvidence(caller: Caller, input: { taskId: string; candidateId?: string }) {
    const me = this.#requireCaller(caller)
    const cfg = this.#config.evidence
    if (cfg === undefined) throw new BoardError('invalid', 'the attester is not configured on this board (unavailable)')
    const task = this.#task(input.taskId)
    await this.#requireUnpaused(task.stack)
    const terms = parseTerms(task.terms_json)
    const ctx = this.#taskCtx(task)
    const target =
      input.candidateId !== undefined
        ? this.#candidate(task.id, input.candidateId)
        : this.#sql.all<{ repo: string; sha: string; deliverable_hash: string }>(
            'SELECT repo, sha, deliverable_hash FROM deliverables WHERE task_id = ? ORDER BY created_at DESC LIMIT 1',
            task.id,
          )[0]
    if (target === undefined) throw new BoardError('not-found', 'no deliverable to attest')
    // The relay pays for each attestation: only the parties (or the candidate's own entrant) may ask for one.
    const entrant = 'worker' in target && eq(target.worker as string, me)
    if (!entrant && this.#roles(terms, await this.#chainView(task), me).length === 0) {
      throw new BoardError('forbidden', 'only the creator, approver, worker or the entrant asks for evidence')
    }
    const [already] = this.#sql.all<{ conclusion: number; tx_hash: string }>(
      'SELECT conclusion, tx_hash FROM evidence WHERE task_id = ? AND submission_hash = ? AND tested_sha = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1',
      task.id, target.deliverable_hash, target.sha, this.#now() - 6 * 24 * 3600,
    )
    if (already !== undefined) return { conclusion: already.conclusion === sdk.EvidenceConclusion.Success ? 'success' : 'failure', txHash: already.tx_hash, reused: true }
    const slug = repoSlug(target.repo)
    if (slug === undefined) throw new BoardError('invalid', 'only public GitHub repositories are attested')
    const token = cfg.github === undefined ? undefined : await installationToken(cfg.github, this.#now())
    const runs = await checkRuns(token, slug, target.sha)
    const required = terms.evidencePolicy?.checks ?? []
    const relevant = required.length === 0 ? runs : runs.filter((r) => required.includes(r.name))
    if (relevant.length === 0) throw new BoardError('conflict', `no ${required.length === 0 ? '' : 'required '}check runs on ${target.sha} yet`)
    if (relevant.some((r) => r.status !== 'completed')) throw new BoardError('conflict', 'checks are still running; ask again when they finish')
    const missing = required.filter((name) => !relevant.some((r) => r.name === name))
    const success = missing.length === 0 && relevant.every((r) => r.conclusion === 'success')
    const checks = relevant.map((r) => ({ name: r.name, conclusion: r.conclusion, app: r.app, sha: r.head_sha }))
    const shaWord = `0x${target.sha.padStart(64, '0')}` as Hex
    const attestation = {
      jobId: this.#jobId(task),
      submissionHash: target.deliverable_hash as Hex,
      policyHash: task.terms_hash as Hex,
      repo: sdk.hashText(target.repo),
      headSha: shaWord,
      testedSha: shaWord,
      checkRunsHash: sdk.hashText(canonicalJson({ checks, missing })),
      conclusion: success ? sdk.EvidenceConclusion.Success : sdk.EvidenceConclusion.Failure,
      validUntil: BigInt(this.#now() + 7 * 24 * 3600),
    }
    const signature = await cfg.attester.signTypedData({
      domain: sdk.evaluatorDomain(ctx.deployment.chainId, ctx.stack.evaluator),
      types: sdk.evidenceTypes,
      primaryType: 'EvidenceAttestation',
      message: attestation,
    })
    const relay = sdk.wallet(this.#config.network, cfg.relay, cfg.rpcUrl)
    const receipt = await sdk.attachEvidence(ctx, relay, attestation, cfg.attester.address, signature)
    this.#sql.run(
      'INSERT INTO evidence (id, task_id, submission_hash, verifier, conclusion, tested_sha, checks_json, tx_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      randomId(8), task.id, target.deliverable_hash, cfg.attester.address, attestation.conclusion, target.sha,
      JSON.stringify({ checks, missing }), receipt.transactionHash, this.#now(),
    )
    return { conclusion: success ? 'success' : 'failure', checks, missing, txHash: receipt.transactionHash, evidence: this.#evidence(task) }
  }

  /**
   * Every evidence statement on this task with its label (R114-06): "matches the awarded on-chain deliverable" only
   * when it names the deliverable the core recorded in `JobSubmitted`; before that, "matches this submitted
   * candidate" when it names a deliverable the board recorded. A job id alone is never a match.
   */
  #evidence(task: TaskRow) {
    const onchain = this.#sql.all<{ deliverable_hash: string }>('SELECT deliverable_hash FROM onchain_submissions WHERE task_id = ?', task.id)[0]
    const known = new Set(
      [
        ...this.#sql.all<{ h: string }>('SELECT deliverable_hash AS h FROM candidates WHERE task_id = ?', task.id),
        ...this.#sql.all<{ h: string }>('SELECT deliverable_hash AS h FROM deliverables WHERE task_id = ?', task.id),
      ].map((r) => r.h.toLowerCase()),
    )
    return this.#sql
      .all<{ submission_hash: string; verifier: string; conclusion: number; tested_sha: string; checks_json: string; tx_hash: string; created_at: number }>(
        'SELECT submission_hash, verifier, conclusion, tested_sha, checks_json, tx_hash, created_at FROM evidence WHERE task_id = ? ORDER BY created_at',
        task.id,
      )
      .map((e) => ({
        verifier: e.verifier,
        submissionHash: e.submission_hash,
        conclusion: e.conclusion === 1 ? 'success' : 'failure',
        testedSha: e.tested_sha,
        checks: JSON.parse(e.checks_json) as unknown,
        txHash: e.tx_hash,
        label: eq(onchain?.deliverable_hash, e.submission_hash)
          ? 'matches the awarded on-chain deliverable'
          : known.has(e.submission_hash.toLowerCase())
            ? 'matches this submitted candidate'
            : 'unmatched',
      }))
  }

  // -----------------------------------------------------------------------------------------------
  // Arbitration (any harness holding the arbitrator key: apps/arbiter, a Claude Code session, a person)
  // -----------------------------------------------------------------------------------------------

  readonly #arbitrators = new Map<string, Address>()

  async #arbitratorOf(stack: string): Promise<Address> {
    const known = this.#arbitrators.get(stack)
    if (known !== undefined) return known
    const ctx = this.#ctx(stack)
    const a = await ctx.publicClient.readContract({ address: ctx.stack.evaluator, abi: sdk.jobsEvaluatorAbi, functionName: 'arbitrator' })
    this.#arbitrators.set(stack, a)
    return a
  }

  async #requireArbitrator(caller: Caller, stack: string): Promise<Address> {
    const me = this.#requireCaller(caller)
    if (!eq(await this.#arbitratorOf(stack), me)) throw new BoardError('forbidden', `only the ${stack} stack's arbitrator`)
    return me
  }

  /**
   * One runner per arbitrator key (plan B2.4): a runner takes or renews the lease; another runner is told who holds
   * it until when. Rulings refuse a runner without the lease, so two harnesses never decide the same dispute.
   */
  async arbiterLease(caller: Caller, input: { runner: string; ttlSeconds?: number; release?: boolean }) {
    const me = this.#requireCaller(caller)
    const stacks = Object.keys(this.#config.contexts)
    const mine = await Promise.all(stacks.map(async (st) => eq(await this.#arbitratorOf(st), me)))
    if (!mine.some(Boolean)) throw new BoardError('forbidden', 'only an arbitrator key holds an arbiter lease')
    const key = me.toLowerCase()
    const now = this.#now()
    const [lease] = this.#sql.all<{ runner: string; expires_at: number }>('SELECT runner, expires_at FROM arbiter_leases WHERE arbitrator = ?', key)
    if (lease !== undefined && lease.runner !== input.runner && lease.expires_at > now) {
      return { held: false, holder: lease.runner, expiresAt: lease.expires_at }
    }
    if (input.release === true) {
      this.#sql.run('DELETE FROM arbiter_leases WHERE arbitrator = ? AND runner = ?', key, input.runner)
      return { held: false, holder: null, expiresAt: null }
    }
    const expiresAt = now + Math.min(Math.max(input.ttlSeconds ?? 120, 30), 900)
    this.#sql.run('INSERT OR REPLACE INTO arbiter_leases (arbitrator, runner, expires_at) VALUES (?, ?, ?)', key, input.runner, expiresAt)
    return { held: true, holder: input.runner, expiresAt }
  }

  #requireLease(arbitrator: Address, runner: string) {
    const [lease] = this.#sql.all<{ runner: string; expires_at: number }>(
      'SELECT runner, expires_at FROM arbiter_leases WHERE arbitrator = ?',
      arbitrator.toLowerCase(),
    )
    if (lease !== undefined && lease.runner !== runner && lease.expires_at > this.#now()) {
      throw new BoardError('conflict', `runner ${lease.runner} holds the arbiter lease until ${lease.expires_at}`)
    }
  }

  /** Every open dispute the caller arbitrates, with its deadline and any decision already recorded. */
  async listDisputes(caller: Caller) {
    const me = this.#requireCaller(caller)
    const stacks = Object.keys(this.#config.contexts)
    const mine = await Promise.all(stacks.map(async (st) => eq(await this.#arbitratorOf(st), me)))
    if (!mine.some(Boolean)) throw new BoardError('forbidden', 'arbitrator tools need a session signed in with the arbitrator wallet')
    const out = []
    for (const task of this.#sql.all<TaskRow>('SELECT * FROM tasks WHERE job_id IS NOT NULL ORDER BY created_at')) {
      if (this.#config.contexts[task.stack as sdk.StackName] === undefined) continue
      if (!eq(await this.#arbitratorOf(task.stack), me)) continue
      const ctx = this.#taskCtx(task)
      const disputedAt = await ctx.publicClient.readContract({ address: ctx.stack.evaluator, abi: sdk.jobsEvaluatorAbi, functionName: 'disputedAt', args: [this.#jobId(task)] })
      if (disputedAt === 0) continue
      const view = await this.#chainView(task)
      if (view.status !== 'disputed') continue
      const decision = this.#ruling(task.id, disputedAt)
      out.push({
        taskId: task.id,
        jobId: task.job_id,
        stack: task.stack,
        title: parseTerms(task.terms_json).title,
        violation: view.violation,
        arbitrationEndsAt: view.arbitrationEndsAt,
        decision: decision === undefined ? null : this.#decisionView(decision),
      })
    }
    return out
  }

  /** A recorded decision as every harness sees it: re-used as is, never re-asked of a model (R114-08). */
  #decisionView(r: RulingRow) {
    const reason = this.#sql.all<{ text: string }>('SELECT text FROM reasons WHERE hash = ?', r.reason_hash)[0]?.text ?? null
    return {
      forWorker: r.for_worker === 1,
      slashLoser: r.slash_loser === 1,
      reason,
      reasonHash: r.reason_hash,
      runner: r.runner,
      model: r.model,
      promptVersion: r.prompt_version,
      signed: r.signature !== null,
      txHash: r.tx_hash,
    }
  }

  #ruling(taskId: string, disputedAt: number): RulingRow | undefined {
    return this.#sql.all<RulingRow>('SELECT * FROM rulings WHERE task_id = ? AND disputed_at = ?', taskId, disputedAt)[0]
  }

  /**
   * The whole dispute as the arbitrator decides it: the offer, the rejection and its published reason, the on-chain
   * deliverable, the attested evidence with its label, and both sides' statements. Readable by the arbitrator and
   * the parties. `bundleHash` pins the decision to exactly this bundle.
   */
  async getDisputeBundle(caller: Caller, input: { taskId: string }): Promise<{ bundle: DisputeBundle; bundleHash: Hex }> {
    const me = this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    const bundle = await this.#bundle(task)
    const terms = parseTerms(task.terms_json)
    const view = await this.#chainView(task)
    if (!eq(bundle.arbitrator, me) && this.#roles(terms, view, me).length === 0) throw new BoardError('forbidden', 'only the arbitrator and the parties')
    return { bundle, bundleHash: bundleHash(bundle) }
  }

  async #bundle(task: TaskRow): Promise<DisputeBundle> {
    const ctx = this.#taskCtx(task)
    const jobId = this.#jobId(task)
    const terms = parseTerms(task.terms_json)
    const [disputedAt, reasonHash, view, arbitrator] = await Promise.all([
      ctx.publicClient.readContract({ address: ctx.stack.evaluator, abi: sdk.jobsEvaluatorAbi, functionName: 'disputedAt', args: [jobId] }),
      ctx.publicClient.readContract({ address: ctx.stack.evaluator, abi: sdk.jobsEvaluatorAbi, functionName: 'rejectionReasonOf', args: [jobId] }),
      this.#chainView(task),
      this.#arbitratorOf(task.stack),
    ])
    if (disputedAt === 0) throw new BoardError('conflict', 'this job has not been disputed')
    const reason = this.#sql.all<{ text: string }>('SELECT text FROM reasons WHERE hash = ?', reasonHash)[0]
    const onchain = this.#sql.all<{ deliverable_hash: string }>('SELECT deliverable_hash FROM onchain_submissions WHERE task_id = ?', task.id)[0]
    const deliverable =
      onchain === undefined
        ? undefined
        : this.#sql
            .all<{ repo: string; branch: string; sha: string; kind: string | null; descriptor_json: string | null; check_json: string | null }>(
              'SELECT repo, branch, sha, kind, descriptor_json, check_json FROM deliverables WHERE task_id = ? AND lower(deliverable_hash) = lower(?)',
              task.id,
              onchain.deliverable_hash,
            )
            .map(({ repo, branch, sha, ...rest }) => {
              const v = deliverableView({ repo, branch, sha, ...rest })
              return { repo, branch, sha, descriptor: v.descriptor, check: v.check }
            })[0]
    return {
      taskId: task.id,
      jobId: jobId.toString(),
      stack: task.stack,
      chainId: ctx.deployment.chainId,
      evaluator: ctx.stack.evaluator,
      arbitrator,
      disputedAt,
      arbitrationEndsAt: disputedAt + terms.windows.arbitrationSeconds,
      offer: {
        title: terms.title,
        brief: terms.brief,
        acceptanceCriteria: terms.acceptanceCriteria,
        reward: terms.reward.toString(),
        token: terms.token,
        creatorBond: terms.creatorBond.toString(),
        workerBond: terms.workerBond.toString(),
        deliveryDeadline: terms.deliveryDeadline,
      },
      rejection: {
        violation: (view.violation ?? 'None') as ViolationName,
        reasonHash,
        // Only text whose hash is the on-chain reason hash counts as the published reason.
        reasonText: reason === undefined || sdk.hashText(reason.text) !== reasonHash ? null : reason.text,
      },
      submission: { deliverableHash: (onchain?.deliverable_hash ?? null) as Hex | null, submittedAt: view.submittedAt, timely: view.timely },
      deliverable: deliverable ?? null,
      evidence: this.#evidence(task).map((e) => ({ conclusion: e.conclusion, label: e.label, checks: e.checks, txHash: e.txHash })),
      statements: this.#sql
        .all<{ role: string; text: string }>('SELECT role, text FROM statements WHERE task_id = ? ORDER BY created_at, id', task.id)
        .map((r) => ({ role: r.role, text: r.text })),
    }
  }

  /**
   * Records the arbitrator's decision for this dispute and returns the EIP-712 `Ruling` to sign. The decision is
   * persisted per dispute: the first one is final on the board (a different decision is refused; the same one returns
   * the same message), it must be made on the current bundle, by the runner holding the lease, within the window.
   */
  async prepareRuling(
    caller: Caller,
    input: {
      taskId: string
      forWorker: boolean
      slashLoser: boolean
      reason: string
      bundleHash: string
      runner: string
      model?: string
      promptVersion?: string
    },
  ) {
    const task = this.#task(input.taskId)
    const me = await this.#requireArbitrator(caller, task.stack)
    this.#requireLease(me, input.runner)
    const bundle = await this.#bundle(task)
    const view = await this.#chainView(task)
    if (view.status !== 'disputed') throw new BoardError('conflict', `the task is ${view.status}, not disputed`)
    const now = this.#now()
    if (now >= bundle.arbitrationEndsAt) throw new BoardError('conflict', 'the arbitration window has closed; only the refund timeout settles')
    const recorded = this.#ruling(task.id, bundle.disputedAt)
    // A recorded decision is re-used as is (another harness, a retry); a new one must be made on the current bundle.
    if (recorded === undefined && !eq(bundleHash(bundle), input.bundleHash)) throw new BoardError('conflict', 'the dispute bundle changed; read it again')
    const refusal = rulingRefusal(bundle.rejection.violation, input.forWorker, input.slashLoser)
    if (refusal !== undefined) throw new BoardError('invalid', refusal)
    if (input.reason.trim().length < 20 || input.reason.length > 2000) throw new BoardError('invalid', 'the reason is 20 to 2000 characters')
    const reasonHash = sdk.hashText(input.reason.trim())
    let row = recorded
    if (row === undefined) {
      this.#sql.run('INSERT OR IGNORE INTO reasons (hash, task_id, text, created_at) VALUES (?, ?, ?, ?)', reasonHash, task.id, input.reason.trim(), now)
      this.#sql.run(
        `INSERT INTO rulings (task_id, disputed_at, arbitrator, runner, bundle_hash, for_worker, slash_loser, reason_hash, deadline, nonce, signature, tx_hash, created_at, model, prompt_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
        task.id, bundle.disputedAt, me, input.runner, input.bundleHash, input.forWorker ? 1 : 0, input.slashLoser ? 1 : 0, reasonHash,
        Math.min(bundle.arbitrationEndsAt, now + 3600), randomUint(16).toString(), now, input.model ?? null, input.promptVersion ?? null,
      )
      this.#operation(task.id, 'rule', me, { forWorker: input.forWorker, slashLoser: input.slashLoser, reasonHash })
      row = this.#ruling(task.id, bundle.disputedAt) as RulingRow
    } else if (row.for_worker !== (input.forWorker ? 1 : 0) || row.slash_loser !== (input.slashLoser ? 1 : 0) || !eq(row.reason_hash, reasonHash)) {
      throw new BoardError('conflict', 'this dispute already has a different decision recorded')
    }
    const ctx = this.#taskCtx(task)
    return {
      decision: this.#decisionView(row),
      ruling: this.#rulingMessage(row),
      sign: {
        description: `Ruling for job ${bundle.jobId}: ${input.forWorker ? 'for the worker' : 'for the creator'}${input.slashLoser ? ', loser slashed' : ''}`,
        typedData: typedDataJson(sdk.evaluatorDomain(ctx.deployment.chainId, ctx.stack.evaluator), sdk.rulingTypes, 'Ruling', this.#rulingMessage(row)),
      } satisfies SignRequest,
      next: 'Sign it with the arbitrator key, then submit_ruling({taskId, signature}).',
    }
  }

  #rulingMessage(row: RulingRow): sdk.Ruling {
    return {
      jobId: BigInt(this.#task(row.task_id).job_id as string),
      forWorker: row.for_worker === 1,
      slashLoser: row.slash_loser === 1,
      reasonHash: row.reason_hash as Hex,
      deadline: BigInt(row.deadline),
      nonce: BigInt(row.nonce),
    }
  }

  /**
   * Points the caller's account at the deployment's DeleGator (EIP-7702) with an authorization the caller signed; the
   * relay sends the type-4 transaction. For wallets that sign an authorization but cannot send one: Privy's
   * TEE-backed embedded wallets drop `authorizationList` from a transaction. The relay pays the gas and gains nothing:
   * the authorization names only the DeleGator, and the account's own key keeps control of it.
   */
  async upgradeAccount(caller: Caller, input: { authorization: Record<string, unknown> | string }) {
    const me = this.#requireCaller(caller)
    const ctx = this.#ctx('main')
    const delegator = ctx.deployment.delegation.delegator
    if (eq(await sdk.delegationOf(ctx.publicClient, me), delegator)) return { upgraded: true, txHash: null, note: 'your account already points at the DeleGator' }
    const relay = this.#config.relay
    if (relay === undefined) throw new BoardError('conflict', 'this board has no relay: send the authorization yourself, in a type-4 transaction to your own address')
    const a = typeof input.authorization === 'string' ? authorizationFromRlp(input.authorization) : (input.authorization ?? {})
    const hex = (k: string) => {
      const v = a[k]
      if (typeof v !== 'string' || !isHex(v)) throw new BoardError('invalid', `authorization.${k} must be hex`)
      return v
    }
    const int = (k: string) => {
      const v = a[k]
      if ((typeof v !== 'number' && typeof v !== 'string') || !/^(0x[0-9a-fA-F]+|\d+)$/.test(String(v))) throw new BoardError('invalid', `authorization.${k} must be an integer`)
      return Number(v)
    }
    const address = hex('address')
    if (!isAddress(address) || !eq(address, delegator)) throw new BoardError('invalid', `the authorization must name the DeleGator ${delegator}`)
    if (int('chainId') !== ctx.deployment.chainId) throw new BoardError('invalid', `the authorization must be for chain ${ctx.deployment.chainId}`)
    const yParity = int('yParity')
    if (yParity !== 0 && yParity !== 1) throw new BoardError('invalid', 'authorization.yParity must be 0 or 1')
    const authorization = { address: getAddress(address), chainId: ctx.deployment.chainId, nonce: int('nonce'), r: hex('r'), s: hex('s'), yParity }
    if (!eq(await recoverAuthorizationAddress({ authorization }), me)) throw new BoardError('forbidden', 'the authorization is not signed by your account')
    const nonce = await ctx.publicClient.getTransactionCount({ address: me, blockTag: 'pending' })
    if (authorization.nonce !== nonce) throw new BoardError('conflict', `the authorization's nonce is ${authorization.nonce} but your account's is ${nonce}: sign it again`)
    const hash = await sdk.wallet(this.#config.network, relay.account, relay.rpcUrl).sendTransaction({ to: me, data: '0x', authorizationList: [authorization] })
    const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success' || !eq(await sdk.delegationOf(ctx.publicClient, me), delegator)) {
      throw new BoardError('chain', `the upgrade ${hash} did not point your account at the DeleGator`)
    }
    return { upgraded: true, txHash: hash }
  }

  /**
   * The signed ruling: checked against the arbitrator key on the chain, stored, and relayed with
   * `ruleWithSignature` (the relay pays gas and holds no authority). Idempotent: a relayed ruling returns its hash.
   */
  async submitRuling(caller: Caller, input: { taskId: string; signature: string }) {
    this.#requireCaller(caller)
    const task = this.#task(input.taskId)
    await this.#requireUnpaused(task.stack)
    const ctx = this.#taskCtx(task)
    const disputedAt = await ctx.publicClient.readContract({ address: ctx.stack.evaluator, abi: sdk.jobsEvaluatorAbi, functionName: 'disputedAt', args: [this.#jobId(task)] })
    const row = this.#ruling(task.id, disputedAt)
    if (row === undefined) throw new BoardError('not-found', 'no decision recorded; prepare_ruling first')
    if (row.tx_hash !== null) return { txHash: row.tx_hash, relayed: true, task: await this.getTask(caller, { taskId: task.id }) }
    const ruling = this.#rulingMessage(row)
    const valid = await ctx.publicClient.verifyTypedData({
      address: await this.#arbitratorOf(task.stack),
      domain: sdk.evaluatorDomain(ctx.deployment.chainId, ctx.stack.evaluator),
      types: sdk.rulingTypes,
      primaryType: 'Ruling',
      message: { ...ruling },
      signature: input.signature as Hex,
    })
    if (!valid) throw new BoardError('forbidden', 'the signature is not the arbitrator’s over this ruling')
    this.#sql.run('UPDATE rulings SET signature = ? WHERE task_id = ? AND disputed_at = ?', input.signature, task.id, disputedAt)
    const tx = this.#tx(ctx, 'ruleWithSignature: settles the dispute as ruled', ctx.stack.evaluator,
      encodeFunctionData({ abi: sdk.jobsEvaluatorAbi, functionName: 'ruleWithSignature', args: [ruling, input.signature as Hex] }))
    const relay = this.#config.relay
    if (relay === undefined) return { relayed: false, transactions: [tx], next: 'Anyone may send it; then report_transaction.' }
    // A crash after an earlier relay: the nonce is spent, so that ruling is on-chain; never send a second one.
    const spent = await ctx.publicClient.readContract({ address: ctx.stack.evaluator, abi: sdk.jobsEvaluatorAbi, functionName: 'rulingNonceUsed', args: [ruling.nonce] })
    if (spent) return { relayed: true, txHash: null, note: 'this ruling is already on-chain (its nonce is spent)', task: await this.getTask(caller, { taskId: task.id }) }
    const receipt = await sdk.ruleWithSignature(ctx, sdk.wallet(this.#config.network, relay.account, relay.rpcUrl), ruling, input.signature as Hex)
    this.#sql.run('UPDATE rulings SET tx_hash = ? WHERE task_id = ? AND disputed_at = ?', receipt.transactionHash, task.id, disputedAt)
    this.#sql.run(
      "UPDATE operations SET status = 'confirmed', tx_hash = ?, updated_at = ? WHERE task_id = ? AND kind = 'rule' AND status = 'prepared'",
      receipt.transactionHash, this.#now(), task.id,
    )
    return { txHash: receipt.transactionHash, relayed: true, task: await this.getTask(caller, { taskId: task.id }) }
  }

  // -----------------------------------------------------------------------------------------------
  // Anyone
  // -----------------------------------------------------------------------------------------------

  /** Whatever permissionless step the chain allows now (timeouts, settlement), as transactions anyone may send. */
  async settlementActions(_caller: Caller, input: { taskId: string }) {
    const task = this.#task(input.taskId)
    await this.#requireUnpaused(task.stack)
    const ctx = this.#taskCtx(task)
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
    if (s === 'selection-closed') {
      txs.push(this.#tx(ctx, 'expireContest: no award by the selection deadline; the prize returns', ctx.stack.holding,
        encodeFunctionData({ abi: sdk.jobHoldingAbi, functionName: 'expireContest', args: [jobId] })))
    }
    // A timeout that ends in a refund leaves the reward in Holding: offer settle right after it, so a batching
    // wallet sends both as one transaction (a sequential one sends them in order).
    const completes = txs.length === 1 && s === 'submitted' && view.timely
    if (txs.length === 1 && !completes) {
      txs.push(this.#tx(ctx, 'settle: pays out what the timeout left in Holding', ctx.stack.holding,
        encodeFunctionData({ abi: sdk.jobHoldingAbi, functionName: 'settle', args: [jobId] })))
    } else if (['rejected', 'expired', 'cancelled'].includes(s) || (view.coreStatus === 'Expired')) {
      // Offered only while Holding still has something to pay out: a settled job answers NothingToSettle.
      const pending = await ctx.publicClient
        .simulateContract({ address: ctx.stack.holding, abi: sdk.jobHoldingAbi, functionName: 'settle', args: [jobId] })
        .then(() => true, () => false)
      if (pending) {
        txs.push(this.#tx(ctx, 'settle: pays out what is still in Holding', ctx.stack.holding,
          encodeFunctionData({ abi: sdk.jobHoldingAbi, functionName: 'settle', args: [jobId] })))
      }
    }
    return { status: s, transactions: txs }
  }

  /**
   * Every task's off-chain record for Explore, without chain reads (Explore takes chain facts from the indexer's
   * D1): the frozen offer's display fields, the job id once published, and Jev's advisory verdict.
   */
  taskIndex(_caller: Caller) {
    return this.#sql.all<TaskRow>('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 500').map((t) => {
      const terms = parseTerms(t.terms_json)
      const screening = t.screening_json === null ? null : (JSON.parse(t.screening_json) as { verdict?: string; reasons?: string[] })
      return {
        taskId: t.id,
        jobId: t.job_id,
        stack: t.stack,
        title: terms.title,
        brief: terms.brief,
        acceptanceCriteria: terms.acceptanceCriteria,
        mode: terms.mode,
        token: terms.token,
        reward: terms.reward.toString(),
        creatorBond: terms.creatorBond.toString(),
        workerBond: terms.workerBond.toString(),
        creator: terms.creator,
        approver: terms.approver,
        deliveryDeadline: terms.deliveryDeadline,
        selectionDeadline: terms.selectionDeadline,
        requiredChecks: terms.evidencePolicy?.checks ?? [],
        quoted: terms.quote !== null,
        deliverable: specOf(terms),
        executionBudget: terms.executionBudget === undefined ? null : { ...terms.executionBudget, cap: terms.executionBudget.cap.toString() },
        termsHash: t.terms_hash,
        manifestUrl: `${this.#config.manifestBaseUrl}/${t.terms_hash}.json`,
        screening: { verdict: screening?.verdict ?? 'unscreened', reasons: screening?.reasons ?? [] },
        createdAt: t.created_at,
      }
    })
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
    const deliverables = this.#sql
      .all<{ worker: string; deliverable_hash: string; repo: string; branch: string; sha: string; kind: string | null; descriptor_json: string | null; check_json: string | null }>(
        'SELECT worker, deliverable_hash, repo, branch, sha, kind, descriptor_json, check_json FROM deliverables WHERE task_id = ? ORDER BY created_at',
        task.id,
      )
      .map(deliverableView)
    const onchain = this.#sql.all<{ deliverable_hash: string; tx_hash: string }>('SELECT deliverable_hash, tx_hash FROM onchain_submissions WHERE task_id = ?', task.id)[0] ?? null
    return { ...summary, terms: JSON.parse(task.terms_json) as unknown, mine, deliverables, onchainSubmission: onchain, evidence: this.#evidence(task), operations }
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
      deliverable: specOf(terms),
      executionBudget:
        terms.executionBudget === undefined
          ? null
          : {
              ...(terms.executionBudget.kind === 'call'
                ? {
                    kind: 'call',
                    target: terms.executionBudget.target,
                    function: terms.executionBudget.function,
                    amount: formatUnits(terms.executionBudget.cap, 18),
                    symbol: nativeSymbol(this.#taskCtx(task)),
                  }
                : {
                    kind: 'advance',
                    ...(await this.#displayAmount(this.#taskCtx(task), { token: terms.executionBudget.token, amount: terms.executionBudget.cap.toString() })),
                  }),
              expiresAt: terms.executionBudget.expiresAt,
              /** promised: in the terms, not granted yet; live: the worker can draw; revoked / ended. */
              grant: this.#budget.grantStatus(task.id),
            },
      jobId: task.job_id,
      screening: task.screening_json === null ? { verdict: 'unscreened', reasons: [] } : (JSON.parse(task.screening_json) as unknown),
      chain: { ...view, paused: await this.paused(task.stack as sdk.StackName) },
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

  /**
   * A publish whose confirmation never reached the board (the response was lost, the client crashed before
   * `report_transaction`): the offer's `termsHash` is listed on-chain, so the listing is found among the newest jobs
   * and recorded, and a retry is never needed (a second publish of the same terms would revert on `PolicyHashUsed`).
   */
  async #recoverPublish(task: TaskRow): Promise<string | null> {
    const ctx = this.#taskCtx(task)
    const listed = await ctx.publicClient
      .readContract({ address: ctx.stack.holding, abi: sdk.jobHoldingAbi, functionName: 'policyListed', args: [task.terms_hash as Hex] })
      .catch(() => false)
    if (!listed) return null
    const counter = await ctx.publicClient.readContract({ address: ctx.deployment.core, abi: sdk.coreAbi, functionName: 'jobCounter' })
    for (let id = counter; id > 0n && id > counter - 64n; id--) {
      const listing = await sdk.getListing(ctx, id).catch(() => undefined)
      if (listing === undefined || !eq(listing.policyHash, task.terms_hash)) continue
      this.#sql.run('UPDATE tasks SET job_id = ? WHERE id = ? AND job_id IS NULL', id.toString(), task.id)
      this.#sql.run(
        "UPDATE operations SET status = 'confirmed', updated_at = ? WHERE task_id = ? AND kind = 'publish' AND status = 'prepared'",
        this.#now(),
        task.id,
      )
      task.job_id = id.toString()
      return task.job_id
    }
    return null
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
    if (task.job_id === null && (await this.#recoverPublish(task)) === null) return base
    const ctx = this.#taskCtx(task)
    const jobId = BigInt(task.job_id as string)
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
