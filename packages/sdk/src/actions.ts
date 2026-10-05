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
  zeroAddress,
} from 'viem'
import {
  coreAbi,
  factoryTokenAbi,
  faucetTokenAbi,
  identityAbi,
  jobHoldingAbi,
  jobPoolAbi,
  jobPoolFactoryAbi,
  jobsEvaluatorAbi,
  hirelingHoldingAbi,
  hirelingEvaluatorAbi,
  stakeVaultAbi,
  factoryV2Abi,
} from './abi/index.ts'
import type { Deployment, Stack } from './deployment.ts'
import { readWindowBounds, validateOfferWindows } from './clocks.ts'
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
  gas?: bigint,
) {
  const { request } = await ctx.publicClient.simulateContract({
    account: wallet.account,
    address,
    abi,
    functionName,
    args,
    ...(gas === undefined ? {} : { gas }),
  } as never)
  return send(ctx, wallet, request as never)
}

const isV1 = (ctx: Ctx) => ctx.stack.kind === 'hireling-v1'
const holdingAbi = (ctx: Ctx) => isV1(ctx) ? hirelingHoldingAbi : jobHoldingAbi
const evaluatorAbi = (ctx: Ctx) => isV1(ctx) ? hirelingEvaluatorAbi : jobsEvaluatorAbi
/** ADR-0011/D4b: Monad charges the requested limit; floors are deliberately explicit. */
export const V1_GAS = { settle: 1_000_000n, claimTopUpRefund: 450_000n, cancel: 700_000n, evaluator: 1_200_000n, retryDeferred: 300_000n } as const

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
  /** Required on v1; frozen per offer instead of taken from a legacy evaluator. */
  readonly reviewWindow?: number
  readonly disputeWindow?: number
  readonly arbitrationWindow?: number
  readonly arbitrator?: Address
}

/** The earliest `expiredAt` the listing accepts: the delivery deadline plus the evaluator's settlement window. */
export async function minExpiry(ctx: Ctx, deliveryDeadline: number, windows?: { reviewWindow: number; disputeWindow: number; arbitrationWindow: number }): Promise<number> {
  if (isV1(ctx)) {
    if (windows === undefined) throw new Error('v1 expiry needs the offer windows')
    const margin = await ctx.publicClient.readContract({ address: ctx.stack.holding, abi: hirelingHoldingAbi, functionName: 'margin' })
    return deliveryDeadline + windows.reviewWindow + windows.disputeWindow + windows.arbitrationWindow + Number(margin)
  }
  const window = await ctx.publicClient.readContract({
    address: ctx.stack.evaluator,
    abi: jobsEvaluatorAbi,
    functionName: 'settlementWindow',
  })
  return deliveryDeadline + Number(window)
}

/** Escrows the reward and posts or reserves the creator bond. Returns the job id. */
export async function publish(ctx: Ctx, wallet: Wallet, p: PublishInput) {
  if (isV1(ctx)) {
    if (p.mode !== 'hire') throw new Error('hireling-v1 supports hires only')
    if (p.arbitrator === undefined || p.arbitrator.toLowerCase() === zeroAddress) throw new Error('v1 publish needs an explicit arbitrator')
    const windows = { reviewWindow: p.reviewWindow, disputeWindow: p.disputeWindow, arbitrationWindow: p.arbitrationWindow }
    if (Object.values(windows).some(v => v === undefined || !Number.isSafeInteger(v) || v <= 0)) throw new Error('v1 publish needs explicit review, dispute and arbitration windows')
    validateOfferWindows({ reviewSeconds: p.reviewWindow!, disputeSeconds: p.disputeWindow!, arbitrationSeconds: p.arbitrationWindow! }, await readWindowBounds(ctx))
    const expiry = await minExpiry(ctx, p.deliveryDeadline, windows as { reviewWindow: number; disputeWindow: number; arbitrationWindow: number })
    await requireStake(ctx, wallet.account.address, p.creatorBond)
    await ensureAllowance(ctx, wallet, p.token, ctx.stack.holding, p.reward)
    const receipt = await write(ctx, wallet, ctx.stack.holding, hirelingHoldingAbi, 'publish', [{
      approver: p.approver ?? '0x0000000000000000000000000000000000000000',
      arbitrator: p.arbitrator, manifestHash: p.manifestHash,
      policyHash: p.termsHash, token: p.token, reward: p.reward, creatorBond: p.creatorBond, workerBond: p.workerBond,
      deliveryDeadline: p.deliveryDeadline, expiredAt: expiry, ...windows,
    }])
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== ctx.stack.holding.toLowerCase()) continue
      try {
        const event = decodeEventLog({ abi: hirelingHoldingAbi, data: log.data, topics: log.topics })
        if (event.eventName === 'Published') return { jobId: event.args.jobId, receipt }
      } catch { /* Other logs are not the listing receipt. */ }
    }
    throw new Error(`publish ${receipt.transactionHash} emitted no Published event`)
  }
  await ensureAllowance(ctx, wallet, p.token, ctx.stack.holding, p.reward)
  if (p.creatorBond > 0n) await ensureAllowance(ctx, wallet, ctx.stack.factory, ctx.stack.holding, p.creatorBond)
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

/** The chain facts the worker independently accepts, besides the Selection's hash label. */
export interface ActivationTerms {
  creator: Address
  approver: Address
  token: Address
  reward: bigint
  creatorBond: bigint
  workerBond: bigint
  arbitrator: Address
  reviewWindow: number
  disputeWindow: number
  arbitrationWindow: number
  deliveryDeadline: number
}

/** Checks economic terms independently of the Selection's termsHash label (D12). */
export function assertActivationTerms(listing: ActivationTerms, expected: ActivationTerms): void {
  for (const key of ['creator', 'approver', 'token', 'arbitrator'] as const) {
    if (listing[key].toLowerCase() !== expected[key].toLowerCase()) throw new Error(`Listing ${key} does not match the accepted offer`)
  }
  for (const key of ['reward', 'creatorBond', 'workerBond', 'reviewWindow', 'disputeWindow', 'arbitrationWindow', 'deliveryDeadline'] as const) {
    if (listing[key] !== expected[key]) throw new Error(`Listing ${key} does not match the accepted offer`)
  }
}

/** The worker's activation: provider, bond, budget and funding in one transaction. V1 requires accepted chain terms. */
export async function activate(ctx: Ctx, worker: Wallet, sel: Selection, creatorSig: Hex, expected?: ActivationTerms) {
  const listing = await getListing(ctx, sel.jobId)
  if (isV1(ctx)) {
    if (expected === undefined) throw new Error('v1 activation needs the accepted offer terms')
    // Read the v1 shape explicitly: a legacy listing lacks the offer's arbitrator and windows.
    const actual = await getV1Listing(ctx, sel.jobId)
    assertActivationTerms(actual, expected)
    if (actual.policyHash.toLowerCase() !== sel.termsHash.toLowerCase()) throw new Error('Listing policy hash does not match Selection')
    await requireStake(ctx, worker.account.address, listing.workerBond)
  }
  else if (listing.workerBond > 0n) {
    await ensureAllowance(ctx, worker, ctx.stack.factory, ctx.stack.holding, listing.workerBond)
  }
  const amount = isV1(ctx) ? (await quoteActivation(ctx, sel.jobId, worker.account.address))[2] : listing.reward
  const budgetAuth = await signBudget(ctx, worker, {
    jobId: sel.jobId,
    token: listing.token,
    amount,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
  })
  return write(ctx, worker, ctx.stack.holding, holdingAbi(ctx), 'activate', [sel, creatorSig, budgetAuth])
}

export function cancelSelection(ctx: Ctx, creator: Wallet, nonce: bigint) {
  return write(ctx, creator, ctx.stack.holding, holdingAbi(ctx), 'cancelSelection', [nonce])
}

export function cancel(ctx: Ctx, creator: Wallet, jobId: bigint) {
  return write(ctx, creator, ctx.stack.holding, holdingAbi(ctx), 'cancel', [jobId], isV1(ctx) ? V1_GAS.cancel : undefined)
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
  if (isV1(ctx)) throw new Error('hireling-v1 supports hires only')
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
  if (isV1(ctx)) throw new Error('hireling-v1 supports hires only')
  return write(ctx, approver, ctx.stack.holding, jobHoldingAbi, 'award', [jobId, candidate])
}

export function expireContest(ctx: Ctx, anyone: Wallet, jobId: bigint) {
  if (isV1(ctx)) throw new Error('hireling-v1 supports hires only')
  return write(ctx, anyone, ctx.stack.holding, jobHoldingAbi, 'expireContest', [jobId])
}

// -------------------------------------------------------------------------------------------------
// Review, dispute, ruling
// -------------------------------------------------------------------------------------------------

export function accept(ctx: Ctx, approver: Wallet, jobId: bigint) {
  return write(ctx, approver, ctx.stack.evaluator, evaluatorAbi(ctx), 'accept', [jobId], isV1(ctx) ? V1_GAS.evaluator : undefined)
}

export function reject(ctx: Ctx, approver: Wallet, jobId: bigint, violation: ViolationName, reasonHash: Hex) {
  return write(ctx, approver, ctx.stack.evaluator, evaluatorAbi(ctx), 'reject', [
    jobId,
    Violation[violation],
    reasonHash,
  ])
}

export function dispute(ctx: Ctx, worker: Wallet, jobId: bigint) {
  return write(ctx, worker, ctx.stack.evaluator, evaluatorAbi(ctx), 'dispute', [jobId])
}

export function rule(ctx: Ctx, arbitrator: Wallet, r: Omit<Ruling, 'deadline' | 'nonce'>) {
  return write(ctx, arbitrator, ctx.stack.evaluator, evaluatorAbi(ctx), 'rule', [
    r.jobId,
    r.forWorker,
    r.slashLoser,
    r.reasonHash,
  ], isV1(ctx) ? V1_GAS.evaluator : undefined)
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
  return write(ctx, relayer, ctx.stack.evaluator, evaluatorAbi(ctx), 'ruleWithSignature', [r, sig], isV1(ctx) ? V1_GAS.evaluator : undefined)
}

// -------------------------------------------------------------------------------------------------
// Permissionless timeouts and settlement
// -------------------------------------------------------------------------------------------------

export function completeAfterSilence(ctx: Ctx, anyone: Wallet, jobId: bigint) {
  return write(ctx, anyone, ctx.stack.evaluator, evaluatorAbi(ctx), 'completeAfterSilence', [jobId], isV1(ctx) ? V1_GAS.evaluator : undefined)
}

export function rejectAfterWindow(ctx: Ctx, anyone: Wallet, jobId: bigint) {
  return write(ctx, anyone, ctx.stack.evaluator, evaluatorAbi(ctx), 'rejectAfterWindow', [jobId], isV1(ctx) ? V1_GAS.evaluator : undefined)
}

export function refundAfterArbitrationTimeout(ctx: Ctx, anyone: Wallet, jobId: bigint) {
  return write(ctx, anyone, ctx.stack.evaluator, evaluatorAbi(ctx), 'refundAfterArbitrationTimeout', [jobId], isV1(ctx) ? V1_GAS.evaluator : undefined)
}

/** The missed-delivery burn, after the delivery deadline. */
export function burnMissedDelivery(ctx: Ctx, anyone: Wallet, jobId: bigint) {
  return write(ctx, anyone, ctx.stack.evaluator, evaluatorAbi(ctx), 'rejectAfterDeliveryDeadline', [jobId], isV1(ctx) ? V1_GAS.evaluator : undefined)
}

/** Pays whatever of a terminal job is still in Holding to whoever the evaluator says is owed it. */
export function settle(ctx: Ctx, anyone: Wallet, jobId: bigint) {
  return write(ctx, anyone, ctx.stack.holding, holdingAbi(ctx), 'settle', [jobId], isV1(ctx) ? V1_GAS.settle : undefined)
}

/** C9 deferred decision recovery. A caller must send this before `settle`. */
export function retryDeferred(ctx: Ctx, anyone: Wallet, jobId: bigint) {
  if (!isV1(ctx)) throw new Error('retryDeferred is only available on hireling-v1')
  return write(ctx, anyone, ctx.stack.evaluator, hirelingEvaluatorAbi, 'retryDeferred', [jobId], V1_GAS.retryDeferred)
}

/** Waits for the deferred core recovery before settling. Reconcile both calls before retrying. */
export async function settleDeferred(ctx: Ctx, anyone: Wallet, jobId: bigint) {
  const retry = await retryDeferred(ctx, anyone, jobId)
  const settled = await settle(ctx, anyone, jobId)
  return { retry, settled }
}

export async function topUp(ctx: Ctx, contributor: Wallet, jobId: bigint, amount: bigint) {
  if (!isV1(ctx)) throw new Error('topUp is only available on hireling-v1')
  if (amount <= 0n) throw new Error('top-up amount must be positive')
  const listing = await getListing(ctx, jobId)
  await ensureAllowance(ctx, contributor, listing.token, ctx.stack.holding, amount)
  return write(ctx, contributor, ctx.stack.holding, hirelingHoldingAbi, 'topUp', [jobId, amount])
}

export function claimTopUpRefund(ctx: Ctx, caller: Wallet, jobId: bigint, contributor: Address = caller.account.address) {
  if (!isV1(ctx)) throw new Error('claimTopUpRefund is only available on hireling-v1')
  return write(ctx, caller, ctx.stack.holding, hirelingHoldingAbi, 'claimTopUpRefund', [jobId, contributor], V1_GAS.claimTopUpRefund)
}

export async function delegate(ctx: Ctx, staker: Wallet, amount: bigint) {
  if (!isV1(ctx) || ctx.deployment.hireling === null) throw new Error('delegate is only available on hireling-v1')
  if (amount <= 0n) throw new Error('stake amount must be positive')
  await ensureAllowance(ctx, staker, ctx.deployment.hireling.factory, ctx.deployment.hireling.vault, amount)
  return write(ctx, staker, ctx.deployment.hireling.vault, stakeVaultAbi, 'delegate', [staker.account.address, amount])
}

export function delegateWithPermit(ctx: Ctx, staker: Wallet, amount: bigint, permit: { deadline: bigint; v: number; r: Hex; s: Hex }) {
  if (!isV1(ctx) || ctx.deployment.hireling === null) throw new Error('delegateWithPermit is only available on hireling-v1')
  return write(ctx, staker, ctx.deployment.hireling.vault, stakeVaultAbi, 'delegateWithPermit', [staker.account.address, amount, permit.deadline, permit.v, permit.r, permit.s])
}

export async function delegatePermit(ctx: Ctx, staker: Address, amount: bigint, deadline: bigint) {
  if (!isV1(ctx) || ctx.deployment.hireling === null) throw new Error('delegatePermit is only available on hireling-v1')
  const factory = ctx.deployment.hireling.factory
  const [name, nonce] = await Promise.all([
    ctx.publicClient.readContract({ address: factory, abi: factoryV2Abi, functionName: 'name' }),
    ctx.publicClient.readContract({ address: factory, abi: factoryV2Abi, functionName: 'nonces', args: [staker] }),
  ])
  return { domain: { name, version: '1', chainId: ctx.deployment.chainId, verifyingContract: factory }, primaryType: 'Permit' as const,
    types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    message: { owner: staker, spender: ctx.deployment.hireling.vault, value: amount, nonce, deadline },
  }
}

/** Convert FACTORY assets to an owned, unqueued share amount before preparing an exit. */
export async function undelegationShares(ctx: Ctx, account: Address, delegator: Address, amount: bigint): Promise<bigint> {
  if (!isV1(ctx) || ctx.deployment.hireling === null) throw new Error('undelegation requires Hireling v1')
  if (amount <= 0n) throw new Error('undelegation amount must be positive')
  const vault = ctx.deployment.hireling.vault
  const [position, shares] = await Promise.all([
    ctx.publicClient.readContract({ address: vault, abi: stakeVaultAbi, functionName: 'positionOf', args: [account, delegator] }),
    ctx.publicClient.readContract({ address: vault, abi: stakeVaultAbi, functionName: 'convertToShares', args: [account, amount] }),
  ])
  const owned = position.shares - position.queuedShares
  const value = await ctx.publicClient.readContract({ address: vault, abi: stakeVaultAbi, functionName: 'convertToAssets', args: [account, owned] })
  if (amount > value || shares > owned) throw new Error('undelegation amount exceeds the owned position')
  if (shares === 0n) throw new Error('undelegation amount rounds to zero shares')
  return shares
}

export async function requestUndelegate(ctx: Ctx, staker: Wallet, amount: bigint) {
  if (!isV1(ctx) || ctx.deployment.hireling === null) throw new Error('requestUndelegate is only available on hireling-v1')
  const shares = await undelegationShares(ctx, staker.account.address, staker.account.address, amount)
  return write(ctx, staker, ctx.deployment.hireling.vault, stakeVaultAbi, 'requestUndelegate', [staker.account.address, shares])
}

export function cancelUndelegate(ctx: Ctx, staker: Wallet) {
  if (!isV1(ctx) || ctx.deployment.hireling === null) throw new Error('cancelUndelegate is only available on hireling-v1')
  return write(ctx, staker, ctx.deployment.hireling.vault, stakeVaultAbi, 'cancelUndelegate', [staker.account.address])
}

export function withdraw(ctx: Ctx, staker: Wallet) {
  if (!isV1(ctx) || ctx.deployment.hireling === null) throw new Error('withdraw is only available on hireling-v1')
  return write(ctx, staker, ctx.deployment.hireling.vault, stakeVaultAbi, 'withdraw', [staker.account.address])
}

export async function getStake(ctx: Ctx, account: Address) {
  if (!isV1(ctx) || ctx.deployment.hireling === null) throw new Error('getStake is only available on hireling-v1')
  const vault = ctx.deployment.hireling.vault
  const [staked, reserved, available, unstake] = await Promise.all([
    ctx.publicClient.readContract({ address: vault, abi: stakeVaultAbi, functionName: 'stakeOf', args: [account] }),
    ctx.publicClient.readContract({ address: vault, abi: stakeVaultAbi, functionName: 'reservedOf', args: [account] }),
    ctx.publicClient.readContract({ address: vault, abi: stakeVaultAbi, functionName: 'availableOf', args: [account] }),
    ctx.publicClient.readContract({ address: vault, abi: stakeVaultAbi, functionName: 'positionOf', args: [account, account] }),
  ])
  const unstaking = await ctx.publicClient.readContract({ address: vault, abi: stakeVaultAbi, functionName: 'convertToAssets', args: [account, unstake.queuedShares] })
  return { staked, reserved, available, unstaking, unlockAt: Number(unstake.unlockAt) }
}

export async function requireStake(ctx: Ctx, account: Address, bond: bigint): Promise<void> {
  if (bond < 0n) throw new Error('bond cannot be negative')
  if (bond > 0n && (await getStake(ctx, account)).available < bond) throw new Error('Insufficient available stake for the bond; stake FACTORY before proceeding')
}

export function quoteActivation(ctx: Ctx, jobId: bigint, worker: Address) {
  if (!isV1(ctx)) throw new Error('quoteActivation is only available on hireling-v1')
  return ctx.publicClient.readContract({ address: ctx.stack.holding, abi: hirelingHoldingAbi, functionName: 'quoteActivation', args: [jobId, worker] })
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

export async function getListing(ctx: Ctx, jobId: bigint) {
  if (isV1(ctx)) {
    const listing = await ctx.publicClient.readContract({ address: ctx.stack.holding, abi: hirelingHoldingAbi, functionName: 'getListing', args: [jobId] })
    return { ...listing, mode: 0, selectionDeadline: 0, workerBondPosted: listing.workerBondReserved }
  }
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
    abi: holdingAbi(ctx),
    functionName: 'selectionDigest',
    args: [sel],
  })
}

export function getV1Listing(ctx: Ctx, jobId: bigint) {
  if (!isV1(ctx)) throw new Error('v1 listing is only available on hireling-v1')
  return ctx.publicClient.readContract({ address: ctx.stack.holding, abi: hirelingHoldingAbi, functionName: 'getListing', args: [jobId] })
}

export function termsOf(ctx: Ctx, jobId: bigint) {
  if (!isV1(ctx)) throw new Error('termsOf is only available on hireling-v1')
  return ctx.publicClient.readContract({ address: ctx.stack.holding, abi: hirelingHoldingAbi, functionName: 'termsOf', args: [jobId] })
}

export function caseOf(ctx: Ctx, jobId: bigint) {
  if (!isV1(ctx)) throw new Error('v1 caseOf is only available on hireling-v1')
  return ctx.publicClient.readContract({ address: ctx.stack.evaluator, abi: hirelingEvaluatorAbi, functionName: 'caseOf', args: [jobId] })
}

export function cancelRuling(ctx: Ctx, arbitrator: Wallet, nonce: bigint) {
  if (!isV1(ctx)) throw new Error('cancelRuling is only available on hireling-v1')
  return write(ctx, arbitrator, ctx.stack.evaluator, hirelingEvaluatorAbi, 'cancelRuling', [nonce])
}

export function withdrawOwed(ctx: Ctx, account: Wallet, token: Address) {
  return write(ctx, account, ctx.stack.holding, holdingAbi(ctx), 'withdraw', [token])
}

export function rulingDigest(ctx: Ctx, r: Ruling) {
  return ctx.publicClient.readContract({
    address: ctx.stack.evaluator,
    abi: evaluatorAbi(ctx),
    functionName: 'rulingDigest',
    args: [r],
  })
}

/** Attaches a verifier's signed evidence; the sender is only a relay (the evaluator checks the verifier's signature). */
export function attachEvidence(
  ctx: Ctx,
  relay: Wallet,
  attestation: {
    jobId: bigint
    submissionHash: Hex
    policyHash: Hex
    repo: Hex
    headSha: Hex
    testedSha: Hex
    checkRunsHash: Hex
    conclusion: number
    validUntil: bigint
  },
  verifier: Address,
  sig: Hex,
) {
  return write(ctx, relay, ctx.stack.evaluator, evaluatorAbi(ctx), 'attachEvidence', [attestation.jobId, attestation, verifier, sig])
}

// -------------------------------------------------------------------------------------------------
// Pools (ADR-0007): pooled funding of one offer through a JobPool clone
// -------------------------------------------------------------------------------------------------

export interface PoolInput {
  /** The salt the creator picks; with the creator's address it fixes the pool's address. */
  readonly salt: Hex
  readonly curator: Address
  readonly goal: bigint
  readonly pledgeDeadline: number
  /** The offer the pool publishes at launch: its reward is the goal, its creator bond zero. */
  readonly publish: Omit<PublishInput, 'reward' | 'creatorBond' | 'approver'>
  /** Receives the FACTORY hold back; defaults to the creator. */
  readonly holdProvider?: Address
}

function poolFactoryOf(ctx: Ctx): Address {
  if (isV1(ctx)) throw new Error('Pools are not supported on Hireling v1')
  const f = ctx.deployment.poolFactory
  if (f === null) throw new Error(`no JobPoolFactory on ${ctx.deployment.network}`)
  return f
}

/** The address `createPool` will give this creator's pool for `salt`. */
export function predictPool(ctx: Ctx, creator: Address, salt: Hex) {
  return ctx.publicClient.readContract({ address: poolFactoryOf(ctx), abi: jobPoolFactoryAbi, functionName: 'predict', args: [creator, salt] })
}

/** The `JobPool.Params` tuple `create` takes, as the SDK builds it. */
export async function poolParams(ctx: Ctx, p: PoolInput) {
  if (isV1(ctx)) throw new Error('Pools are not supported on Hireling v1')
  const pub = p.publish
  return {
    token: pub.token,
    goal: p.goal,
    pledgeDeadline: p.pledgeDeadline,
    curator: p.curator,
    holding: ctx.stack.holding,
    publish: {
      approver: p.curator,
      manifestHash: pub.manifestHash,
      policyHash: pub.termsHash,
      token: pub.token,
      reward: p.goal,
      creatorBond: 0n,
      workerBond: pub.workerBond,
      deliveryDeadline: pub.deliveryDeadline,
      expiredAt: await minExpiry(ctx, pub.deliveryDeadline),
      mode: pub.mode === 'hire' ? Mode.Hire : Mode.Contest,
      selectionDeadline: pub.selectionDeadline ?? 0,
    },
    governance: 0,
    holdProvider: p.holdProvider ?? '0x0000000000000000000000000000000000000000',
  } as const
}

/** Clones the pool (approving the FACTORY hold to the factory first). Returns the pool address. */
export async function createPool(ctx: Ctx, creator: Wallet, p: PoolInput) {
  const factory = poolFactoryOf(ctx)
  const hold = await ctx.publicClient.readContract({ address: ctx.stack.holding, abi: jobHoldingAbi, functionName: 'minHoldToPublish' })
  if (hold > 0n) await ensureAllowance(ctx, creator, ctx.stack.factory, factory, hold)
  const receipt = await write(ctx, creator, factory, jobPoolFactoryAbi, 'create', [p.salt, await poolParams(ctx, p)])
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== factory.toLowerCase()) continue
    try {
      const event = decodeEventLog({ abi: jobPoolFactoryAbi, data: log.data, topics: log.topics })
      if (event.eventName === 'PoolCreated') return { pool: event.args.pool, receipt }
    } catch {
      // not ours
    }
  }
  throw new Error(`createPool ${receipt.transactionHash} emitted no PoolCreated event`)
}

/** Pledges `amount` of the pool's token (approving it first); the pool caps it to what the goal still needs. */
export async function pledge(ctx: Ctx, pledger: Wallet, pool: Address, token: Address, amount: bigint) {
  await ensureAllowance(ctx, pledger, token, pool, amount)
  return write(ctx, pledger, pool, jobPoolAbi, 'pledge', [amount])
}

export function unpledge(ctx: Ctx, pledger: Wallet, pool: Address, amount: bigint) {
  return write(ctx, pledger, pool, jobPoolAbi, 'unpledge', [amount])
}

/** Publishes the full pool's offer. Returns the job id from the pool's `Launched` event. */
export async function launchPool(ctx: Ctx, anyone: Wallet, pool: Address) {
  const receipt = await write(ctx, anyone, pool, jobPoolAbi, 'launch', [])
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== pool.toLowerCase()) continue
    try {
      const event = decodeEventLog({ abi: jobPoolAbi, data: log.data, topics: log.topics })
      if (event.eventName === 'Launched') return { jobId: event.args.jobId, receipt }
    } catch {
      // not ours
    }
  }
  throw new Error(`launch ${receipt.transactionHash} emitted no Launched event`)
}

export function poolRefund(ctx: Ctx, pledger: Wallet, pool: Address) {
  return write(ctx, pledger, pool, jobPoolAbi, 'refund', [])
}

/** The curator cancels the launched, unactivated hire (Holding's `cancel`, forwarded by the pool). */
export function poolCancel(ctx: Ctx, curator: Wallet, pool: Address) {
  return write(ctx, curator, pool, jobPoolAbi, 'cancel', [])
}

export function poolCancelPool(ctx: Ctx, curator: Wallet, pool: Address) {
  return write(ctx, curator, pool, jobPoolAbi, 'cancelPool', [])
}

export function reclaimHold(ctx: Ctx, anyone: Wallet, pool: Address) {
  return write(ctx, anyone, pool, jobPoolAbi, 'reclaimHold', [])
}

export const PoolPhase = ['funding', 'launched', 'cancelled', 'expired'] as const

/** One read of a pool: its params, totals, phase and job id. */
export async function getPool(ctx: Ctx, pool: Address) {
  const read = <F extends string>(functionName: F, args: readonly unknown[] = []) =>
    ctx.publicClient.readContract({ address: pool, abi: jobPoolAbi, functionName, args } as never)
  const [params, totalPledged, paidOut, jobId, launchedAt, cancelledAt, phase, refundable, holdAmount] = await Promise.all([
    read('params'),
    read('totalPledged'),
    read('paidOut'),
    read('jobId'),
    read('launchedAt'),
    read('cancelledAt'),
    read('phase'),
    read('refundable'),
    read('holdAmount'),
  ])
  return {
    params: params as Awaited<ReturnType<typeof poolParams>>,
    totalPledged: totalPledged as bigint,
    paidOut: paidOut as bigint,
    jobId: jobId as bigint,
    launchedAt: Number(launchedAt),
    cancelledAt: Number(cancelledAt),
    phase: PoolPhase[Number(phase)] ?? 'funding',
    refundable: refundable as boolean,
    holdAmount: holdAmount as bigint,
  }
}

export function pledgedBy(ctx: Ctx, pool: Address, who: Address) {
  return ctx.publicClient.readContract({ address: pool, abi: jobPoolAbi, functionName: 'pledged', args: [who] })
}
