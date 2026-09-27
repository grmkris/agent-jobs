/**
 * Every on-chain operation of the protocol, one function each, over viem clients. Writes simulate first (so a
 * revert surfaces with its decoded error before anything is sent), then send and wait for the receipt; a reverted
 * receipt throws. Signing helpers produce exactly the EIP-712 messages the contracts verify.
 *
 * These functions move money or change dispute state. Callers that retry must reconcile against the chain first
 * (R114-07); the board's operation records do that, this layer does not guess.
 */
import {
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
  decodeEventLog,
  keccak256,
  maxUint256,
  stringToHex,
} from 'viem'
import {
  coreAbi,
  factoryTokenAbi,
  faucetTokenAbi,
  identityAbi,
  jobHoldingAbi,
  jobsEvaluatorAbi,
} from './abi/index.ts'
import type { Deployment, Stack } from './deployment.ts'
import {
  type Authorization,
  type Ruling,
  type Selection,
  EMPTY_HASH,
  coreDomain,
  evaluatorDomain,
  holdingDomain,
  rulingTypes,
  selectionTypes,
  setBudgetTypes,
  submitTypes,
} from './typed-data.ts'

export type Wallet = WalletClient<Transport, Chain, Account>

/** The protocol's modes, as `JobHolding.Mode`. */
export const Mode = { Hire: 0, Contest: 1 } as const
/** A rejection's finding, as `JobsEvaluator.Violation`. */
export const Violation = { None: 0, Quality: 1, Falsified: 2 } as const
export type ViolationName = keyof typeof Violation

/** The ERC-8183 core's job status. */
export const JobStatus = ['Open', 'Funded', 'Submitted', 'Completed', 'Rejected', 'Expired'] as const
export type JobStatusName = (typeof JobStatus)[number]

export interface Ctx {
  readonly publicClient: PublicClient
  readonly deployment: Deployment
  readonly stack: Stack
}

/** Hash of a human-readable string, for manifest, terms, reasons and deliverables in scripts and tests. */
export const hashText = (text: string): Hex => keccak256(stringToHex(text))

/** A random nonce that fits `uint72` (core authorisations) and `uint256` (selections, rulings). */
export function randomNonce(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(9))
  return bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n)
}

async function send(ctx: Ctx, wallet: Wallet, request: Parameters<Wallet['writeContract']>[0]) {
  const hash = await wallet.writeContract(request)
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted`)
  return receipt
}

async function write(
  ctx: Ctx,
  wallet: Wallet,
  address: Address,
  abi: readonly unknown[],
  functionName: string,
  args: readonly unknown[],
) {
  const { request } = await ctx.publicClient.simulateContract({
    account: wallet.account,
    address,
    abi,
    functionName,
    args,
  } as never)
  return send(ctx, wallet, request as never)
}

// -------------------------------------------------------------------------------------------------
// Tokens and identity
// -------------------------------------------------------------------------------------------------

/** Testnet only: mints the token's faucet amount to the wallet (FACTORY, mUSD, mEUR). */
export function faucet(ctx: Ctx, wallet: Wallet, token: Address) {
  return write(ctx, wallet, token, faucetTokenAbi, 'faucet', [])
}

/** Approves `spender` for `amount` of `token` unless the allowance already covers it. */
export async function ensureAllowance(ctx: Ctx, wallet: Wallet, token: Address, spender: Address, amount: bigint) {
  const current = await ctx.publicClient.readContract({
    address: token,
    abi: factoryTokenAbi,
    functionName: 'allowance',
    args: [wallet.account.address, spender],
  })
  if (current >= amount) return undefined
  return write(ctx, wallet, token, factoryTokenAbi, 'approve', [spender, maxUint256])
}

export function balanceOf(ctx: Ctx, token: Address, who: Address) {
  return ctx.publicClient.readContract({ address: token, abi: factoryTokenAbi, functionName: 'balanceOf', args: [who] })
}

/** Registers the wallet as an ERC-8004 agent; its agent wallet defaults to the owner. Returns the agent id. */
export async function registerAgent(ctx: Ctx, wallet: Wallet, agentURI: string): Promise<bigint> {
  const { request, result } = await ctx.publicClient.simulateContract({
    account: wallet.account,
    address: ctx.deployment.identity,
    abi: identityAbi,
    functionName: 'register',
    args: [agentURI],
  })
  await send(ctx, wallet, request as never)
  return result
}

export function agentWallet(ctx: Ctx, agentId: bigint) {
  return ctx.publicClient.readContract({
    address: ctx.deployment.identity,
    abi: identityAbi,
    functionName: 'getAgentWallet',
    args: [agentId],
  })
}

// -------------------------------------------------------------------------------------------------
// Publish
// -------------------------------------------------------------------------------------------------

export interface PublishInput {
  readonly mode: 'hire' | 'contest'
  readonly token: Address
  readonly reward: bigint
  readonly creatorBond: bigint
  readonly workerBond: bigint
  readonly manifestHash: Hex
  /** The offer's `termsHash`; Holding refuses one it has already listed. */
  readonly termsHash: Hex
  readonly deliveryDeadline: number
  /** Contest only. */
  readonly selectionDeadline?: number
  /** Defaults to the creator. */
  readonly approver?: Address
}

/** The earliest `expiredAt` the listing accepts: the delivery deadline plus the evaluator's settlement window. */
export async function minExpiry(ctx: Ctx, deliveryDeadline: number): Promise<number> {
  const window = await ctx.publicClient.readContract({
    address: ctx.stack.evaluator,
    abi: jobsEvaluatorAbi,
    functionName: 'settlementWindow',
  })
  return deliveryDeadline + Number(window)
}

/** Escrows the reward and the creator bond (approving both first) and lists the offer. Returns the job id. */
export async function publish(ctx: Ctx, wallet: Wallet, p: PublishInput) {
  await ensureAllowance(ctx, wallet, p.token, ctx.stack.holding, p.reward)
  if (p.creatorBond > 0n) await ensureAllowance(ctx, wallet, ctx.deployment.factory, ctx.stack.holding, p.creatorBond)
  const receipt = await write(ctx, wallet, ctx.stack.holding, jobHoldingAbi, 'publish', [
    {
      approver: p.approver ?? '0x0000000000000000000000000000000000000000',
      manifestHash: p.manifestHash,
      policyHash: p.termsHash,
      token: p.token,
      reward: p.reward,
      creatorBond: p.creatorBond,
      workerBond: p.workerBond,
      deliveryDeadline: p.deliveryDeadline,
      expiredAt: await minExpiry(ctx, p.deliveryDeadline),
      mode: p.mode === 'hire' ? Mode.Hire : Mode.Contest,
      selectionDeadline: p.selectionDeadline ?? 0,
    },
  ])
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== ctx.stack.holding.toLowerCase()) continue
    try {
      const event = decodeEventLog({ abi: jobHoldingAbi, data: log.data, topics: log.topics })
      if (event.eventName === 'Published') return { jobId: event.args.jobId, receipt }
    } catch {
      // not ours
    }
  }
  throw new Error(`publish ${receipt.transactionHash} emitted no Published event`)
}

// -------------------------------------------------------------------------------------------------
// Hire: selection and activation
// -------------------------------------------------------------------------------------------------

/** The creator signs its pick of one applicant. Nothing happens on-chain until the worker activates. */
export function signSelection(ctx: Ctx, creator: Wallet, sel: Selection): Promise<Hex> {
  return creator.signTypedData({
    domain: holdingDomain(ctx.deployment.chainId, ctx.stack.holding),
    types: selectionTypes,
    primaryType: 'Selection',
    message: sel,
  })
}

/** The worker's core `SetBudgetAuthorization`, which Holding applies inside `activate` or `award`. */
export async function signBudget(
  ctx: Ctx,
  worker: Wallet,
  a: { jobId: bigint; token: Address; amount: bigint; nonce?: bigint; deadline: bigint },
): Promise<Authorization> {
  const nonce = a.nonce ?? randomNonce()
  const sig = await worker.signTypedData({
    domain: coreDomain(ctx.deployment.chainId, ctx.deployment.core),
    types: setBudgetTypes,
    primaryType: 'SetBudgetAuthorization',
    message: {
      signer: worker.account.address,
      jobId: a.jobId,
      token: a.token,
      amount: a.amount,
      optParamsHash: EMPTY_HASH,
      nonce,
      deadline: a.deadline,
    },
  })
  return { signer: worker.account.address, nonce, deadline: a.deadline, sig }
}

/** The worker's core `SubmitAuthorization` for one exact deliverable (contest entries). */
export async function signSubmit(
  ctx: Ctx,
  worker: Wallet,
  a: { jobId: bigint; deliverable: Hex; nonce?: bigint; deadline: bigint },
): Promise<Authorization> {
  const nonce = a.nonce ?? randomNonce()
  const sig = await worker.signTypedData({
    domain: coreDomain(ctx.deployment.chainId, ctx.deployment.core),
    types: submitTypes,
    primaryType: 'SubmitAuthorization',
    message: {
      signer: worker.account.address,
      jobId: a.jobId,
      deliverable: a.deliverable,
      optParamsHash: EMPTY_HASH,
      nonce,
      deadline: a.deadline,
    },
  })
  return { signer: worker.account.address, nonce, deadline: a.deadline, sig }
}

/**
 * The worker's own activation: provider, bond, budget and funding in one transaction, approving the worker bond
 * first. Never relayed (R114-01).
 */
export async function activate(ctx: Ctx, worker: Wallet, sel: Selection, creatorSig: Hex) {
  const listing = await getListing(ctx, sel.jobId)
  if (listing.workerBond > 0n) {
    await ensureAllowance(ctx, worker, ctx.deployment.factory, ctx.stack.holding, listing.workerBond)
  }
  const budgetAuth = await signBudget(ctx, worker, {
    jobId: sel.jobId,
    token: listing.token,
    amount: listing.reward,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
  })
  return write(ctx, worker, ctx.stack.holding, jobHoldingAbi, 'activate', [sel, creatorSig, budgetAuth])
}

export function cancelSelection(ctx: Ctx, creator: Wallet, nonce: bigint) {
  return write(ctx, creator, ctx.stack.holding, jobHoldingAbi, 'cancelSelection', [nonce])
}

export function cancel(ctx: Ctx, creator: Wallet, jobId: bigint) {
  return write(ctx, creator, ctx.stack.holding, jobHoldingAbi, 'cancel', [jobId])
}

/** The worker's final submission, sent directly to the core. */
export function submit(ctx: Ctx, worker: Wallet, jobId: bigint, deliverable: Hex) {
  return write(ctx, worker, ctx.deployment.core, coreAbi, 'submit', [jobId, deliverable, '0x'])
}

// -------------------------------------------------------------------------------------------------
// Contest
// -------------------------------------------------------------------------------------------------

export interface Candidate {
  readonly worker: Address
  readonly agentId: bigint
  readonly deliverable: Hex
  readonly budgetAuth: Authorization
  readonly submitAuth: Authorization
}

/** What an entrant signs at entry: both authorisations, valid until the contest's selection deadline. */
export async function signEntry(ctx: Ctx, worker: Wallet, jobId: bigint, agentId: bigint, deliverable: Hex) {
  const listing = await getListing(ctx, jobId)
  const deadline = BigInt(listing.selectionDeadline)
  return {
    worker: worker.account.address,
    agentId,
    deliverable,
    budgetAuth: await signBudget(ctx, worker, { jobId, token: listing.token, amount: listing.reward, deadline }),
    submitAuth: await signSubmit(ctx, worker, { jobId, deliverable, deadline }),
  } satisfies Candidate
}

/** The approver buys one finished entry: paid in this transaction, the winner offline. */
export function award(ctx: Ctx, approver: Wallet, jobId: bigint, candidate: Candidate) {
  return write(ctx, approver, ctx.stack.holding, jobHoldingAbi, 'award', [jobId, candidate])
}

export function expireContest(ctx: Ctx, anyone: Wallet, jobId: bigint) {
  return write(ctx, anyone, ctx.stack.holding, jobHoldingAbi, 'expireContest', [jobId])
}

// -------------------------------------------------------------------------------------------------
// Review, dispute, ruling
// -------------------------------------------------------------------------------------------------

export function accept(ctx: Ctx, approver: Wallet, jobId: bigint) {
  return write(ctx, approver, ctx.stack.evaluator, jobsEvaluatorAbi, 'accept', [jobId])
}

export function reject(ctx: Ctx, approver: Wallet, jobId: bigint, violation: ViolationName, reasonHash: Hex) {
  return write(ctx, approver, ctx.stack.evaluator, jobsEvaluatorAbi, 'reject', [
    jobId,
    Violation[violation],
    reasonHash,
  ])
}

export function dispute(ctx: Ctx, worker: Wallet, jobId: bigint) {
  return write(ctx, worker, ctx.stack.evaluator, jobsEvaluatorAbi, 'dispute', [jobId])
}

export function rule(ctx: Ctx, arbitrator: Wallet, r: Omit<Ruling, 'deadline' | 'nonce'>) {
  return write(ctx, arbitrator, ctx.stack.evaluator, jobsEvaluatorAbi, 'rule', [
    r.jobId,
    r.forWorker,
    r.slashLoser,
    r.reasonHash,
  ])
}

/** The arbitrator signs a ruling; any harness can do this without gas. */
export function signRuling(ctx: Ctx, arbitrator: Wallet, r: Ruling): Promise<Hex> {
  return arbitrator.signTypedData({
    domain: evaluatorDomain(ctx.deployment.chainId, ctx.stack.evaluator),
    types: rulingTypes,
    primaryType: 'Ruling',
    message: r,
  })
}

/** Anyone relays a signed ruling; it carries only the arbitrator's authority. */
export function ruleWithSignature(ctx: Ctx, relayer: Wallet, r: Ruling, sig: Hex) {
  return write(ctx, relayer, ctx.stack.evaluator, jobsEvaluatorAbi, 'ruleWithSignature', [r, sig])
}

// -------------------------------------------------------------------------------------------------
// Permissionless timeouts and settlement
// -------------------------------------------------------------------------------------------------

export function completeAfterSilence(ctx: Ctx, anyone: Wallet, jobId: bigint) {
  return write(ctx, anyone, ctx.stack.evaluator, jobsEvaluatorAbi, 'completeAfterSilence', [jobId])
}

export function rejectAfterWindow(ctx: Ctx, anyone: Wallet, jobId: bigint) {
  return write(ctx, anyone, ctx.stack.evaluator, jobsEvaluatorAbi, 'rejectAfterWindow', [jobId])
}

export function refundAfterArbitrationTimeout(ctx: Ctx, anyone: Wallet, jobId: bigint) {
  return write(ctx, anyone, ctx.stack.evaluator, jobsEvaluatorAbi, 'refundAfterArbitrationTimeout', [jobId])
}

/** The missed-delivery burn, after the delivery deadline. */
export function burnMissedDelivery(ctx: Ctx, anyone: Wallet, jobId: bigint) {
  return write(ctx, anyone, ctx.stack.evaluator, jobsEvaluatorAbi, 'rejectAfterDeliveryDeadline', [jobId])
}

/** Pays whatever of a terminal job is still in Holding to whoever the evaluator says is owed it. */
export function settle(ctx: Ctx, anyone: Wallet, jobId: bigint) {
  return write(ctx, anyone, ctx.stack.holding, jobHoldingAbi, 'settle', [jobId])
}

// -------------------------------------------------------------------------------------------------
// Reads
// -------------------------------------------------------------------------------------------------

export async function getJob(ctx: Ctx, jobId: bigint) {
  const job = await ctx.publicClient.readContract({
    address: ctx.deployment.core,
    abi: coreAbi,
    functionName: 'getJob',
    args: [jobId],
  })
  return { ...job, statusName: JobStatus[job.status] as JobStatusName }
}

export function getListing(ctx: Ctx, jobId: bigint) {
  return ctx.publicClient.readContract({
    address: ctx.stack.holding,
    abi: jobHoldingAbi,
    functionName: 'getListing',
    args: [jobId],
  })
}

export function selectionDigest(ctx: Ctx, sel: Selection) {
  return ctx.publicClient.readContract({
    address: ctx.stack.holding,
    abi: jobHoldingAbi,
    functionName: 'selectionDigest',
    args: [sel],
  })
}

export function rulingDigest(ctx: Ctx, r: Ruling) {
  return ctx.publicClient.readContract({
    address: ctx.stack.evaluator,
    abi: jobsEvaluatorAbi,
    functionName: 'rulingDigest',
    args: [r],
  })
}
