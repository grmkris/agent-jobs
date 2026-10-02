/**
 * The admin page's checks, before anything is signed: a fee schedule proposal against the rules `FeeSchedule.propose`
 * enforces (so the Safe never sends one that reverts), and the epoch file whose root `EpochDistributor.setRoot` posts.
 * Pure, so they are unit-tested (admin.test.ts).
 */
import * as sdk from '@agent-jobs/sdk'
import { type Abi, type Address, type Hex, decodeFunctionData, getAddress, isAddress, isHex, zeroAddress } from 'viem'
import { MULTI_SEND_CALL_ONLY, describe, preValidated, safeAbi, unpackMultiSend } from './safe.ts'
import { factoryAmount } from './stake.ts'

export interface ScheduleDraft {
  /** FACTORY, as typed. */
  thresholds: string[]
  /** Percent, as typed ("10", "2.5"). */
  rates: string[]
  treasury: string
}

/** Percent as typed, in basis points; null when it is not a number with at most two decimals. */
export function bpsOf(text: string): number | null {
  const t = text.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null
  return Math.round(Number(t) * 100)
}

/** The draft as `propose` takes it, or why it would be refused: the contract's rules, in its order. */
export function scheduleProposal(d: ScheduleDraft, maxBps: number): { thresholds: bigint[]; bps: number[]; treasury: Address } | string {
  const thresholds: bigint[] = []
  for (const [i, t] of d.thresholds.entries()) {
    const wei = i === 0 && t.trim() === '0' ? 0n : factoryAmount(t)
    if (wei === null) return `Tier ${i + 1}: enter a FACTORY threshold.`
    thresholds.push(wei)
  }
  const bps: number[] = []
  for (const [i, r] of d.rates.entries()) {
    const b = bpsOf(r)
    if (b === null) return `Tier ${i + 1}: enter a fee in percent, at most two decimals.`
    bps.push(b)
  }
  if (thresholds[0] !== 0n) return 'The first tier must start at 0 FACTORY, so every stake has a fee.'
  if (thresholds.some((t, i) => i > 0 && t <= (thresholds[i - 1] as bigint))) return 'Each tier must start above the one before it.'
  if (bps.some((b) => b > maxBps)) return `No tier may charge more than ${maxBps / 100} %.`
  if (bps.some((b, i) => i > 0 && b > (bps[i - 1] as number))) return 'A bigger stake may not pay a higher fee.'
  if (!isAddress(d.treasury.trim(), { strict: false }) || d.treasury.trim().toLowerCase() === zeroAddress) return 'Enter the treasury address that receives fees.'
  return { thresholds, bps, treasury: d.treasury.trim() as Address }
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/

/** What the admin page takes from `pnpm mining:epoch`'s `epoch-<n>.json` (B8, scripts/mining/README.md). */
export interface EpochFile {
  epoch: bigint
  root: Hex
  /** Base units: the sum of the tree's leaves, what `setRoot` posts. */
  total: bigint
  dataHash: Hex
  emission: bigint
  budget: bigint | null
  leaves: number | null
  /** Who signed the epoch's price list, when the file names them. */
  priceSigner: string | null
  /**
   * What is left to fund, as the run read it: `fund(epoch, amount)`, right only while `MiningReserve.totalFunded()`
   * is still `expectTotalFunded` (fund is additive). Null when the epoch was fully funded at the run.
   */
  fund: { amount: bigint; expectTotalFunded: bigint; fundedForEpoch: bigint } | null
}

/** The configured contracts an epoch file's calls must go to. */
export interface EpochFileContext {
  chainId: number
  reserve: string
  distributor: string
}

const dec = (x: unknown): bigint | null => (typeof x === 'string' && /^\d+$/.test(x) ? BigInt(x) : null)

/**
 * Reads an epoch file in the shape B8 pins: `chainId` (this chain), `epoch`, `total` and `emission` as decimal strings,
 * `root` and `dataHash`, and `calls`. `calls.setRoot` must be the distributor's `setRoot` with exactly the file's
 * epoch, root, total and data hash; `calls.fund`, when there is one, the reserve's `fund` for this epoch and the
 * remainder `total - expect.fundedForEpoch`. A file whose epoch counted no fees has no root and nothing to do.
 */
export function readEpochFile(text: string, ctx: EpochFileContext): { ok: true; file: EpochFile } | { ok: false; problem: string } {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    return no('The file is not JSON.')
  }
  if (j === null || typeof j !== 'object' || Array.isArray(j)) return no('The file is not an epoch file.')
  const f = j as Record<string, unknown>
  if (typeof f.chainId !== 'number') return no('It names no chain.')
  if (f.chainId !== ctx.chainId) return no(`It is for chain ${f.chainId}, not this network (${ctx.chainId}).`)
  const epoch = dec(f.epoch)
  if (epoch === null) return no('It has no epoch number.')
  if (f.root === null) return no(`No fee counted in epoch ${epoch}: there is no root to post and nothing to fund.`)
  if (typeof f.root !== 'string' || !BYTES32.test(f.root)) return no('Its root is not 0x and 64 hex digits.')
  const root = f.root as Hex
  const total = dec(f.total)
  if (total === null || total === 0n) return no('Its total is not a positive whole number of base units.')
  if (typeof f.dataHash !== 'string' || !BYTES32.test(f.dataHash)) return no('Its data hash is not 0x and 64 hex digits.')
  const dataHash = f.dataHash as Hex
  const emission = dec(f.emission)
  if (emission === null) return no('It has no emission.')
  if (total > emission) return no('Its total is more than its emission.')

  const calls = (f.calls ?? null) as Record<string, { to?: unknown; data?: unknown; expect?: Record<string, unknown> }> | null
  if (calls === null || typeof calls !== 'object') return no('It has no calls for the Safe.')
  const decoded = (call: { to?: unknown; data?: unknown } | undefined, to: string, abi: Abi) => {
    if (call === undefined || typeof call.to !== 'string' || typeof call.data !== 'string' || !isHex(call.data) || !same(call.to, to)) return null
    try {
      return decodeFunctionData({ abi, data: call.data })
    } catch {
      return null
    }
  }
  const setRoot = decoded(calls.setRoot, ctx.distributor, sdk.epochDistributorAbi as Abi)
  const [rEpoch, rRoot, rTotal, rHash] = (setRoot?.args ?? []) as readonly [bigint, Hex, bigint, Hex]
  if (setRoot?.functionName !== 'setRoot' || rEpoch !== epoch || !same(rRoot, root) || rTotal !== total || !same(rHash, dataHash)) {
    return no('Its setRoot call is not the distributor’s, for this epoch, root, total and data hash.')
  }
  let fund: EpochFile['fund'] = null
  if (calls.fund !== undefined) {
    const call = decoded(calls.fund, ctx.reserve, sdk.miningReserveAbi as Abi)
    const [fEpoch, amount] = (call?.args ?? []) as readonly [bigint, bigint]
    const expectTotalFunded = dec(calls.fund.expect?.totalFunded)
    const fundedForEpoch = dec(calls.fund.expect?.fundedForEpoch)
    if (call?.functionName !== 'fund' || fEpoch !== epoch) return no('Its fund call is not the reserve’s, for this epoch.')
    if (expectTotalFunded === null || fundedForEpoch === null) return no('Its fund call does not say what was funded when it was made.')
    if (amount === 0n || amount > total || amount !== total - fundedForEpoch) return no('Its fund amount is not what is left of the total.')
    fund = { amount, expectTotalFunded, fundedForEpoch }
  }
  const tree = f.tree as { values?: unknown } | undefined
  const priceList = f.priceList as { signer?: unknown } | undefined
  return {
    ok: true,
    file: { epoch, root, total, dataHash, emission, budget: dec(f.budget), leaves: Array.isArray(tree?.values) ? tree.values.length : null, priceSigner: typeof priceList?.signer === 'string' ? priceList.signer : null, fund },
  }
}

/**
 * A new total for a posted root (`resizeRoot`), or why not. Only shrinking is offered here, to the leaf sum when the
 * posted total overstated it; the contract never lets a total drop below what is already claimed.
 */
export function resizeProblem(text: string, root: { total: bigint; claimed: bigint }): string | null {
  const total = /^0*\.?0*$/.test(text.trim()) && text.trim() !== '' && text.trim() !== '.' ? 0n : factoryAmount(text)
  if (total === null) return 'Enter the new total in FACTORY: the sum of the root’s leaves.'
  if (total >= root.total) return 'The new total must be below the posted one.'
  if (total < root.claimed) return 'The total cannot drop below what has already been claimed.'
  return null
}

/** A contract the console may call, with the functions it may call on it as the Safe, and directly (anyone may). */
export interface AdminTarget {
  name: string
  abi: Abi
  safe: readonly string[]
  direct: readonly string[]
}

/** What an admin transaction is checked against: the chain, the Safe, the signed-in owner and the config's contracts. */
export interface AdminContext {
  chainId: number
  safe: Address
  owner: Address
  /** By lowercase address. */
  targets: Readonly<Record<string, AdminTarget>>
}

/** One contract call inside an admin transaction, decoded from its calldata. */
export interface InnerCall {
  contract: string
  to: Address
  functionName: string
  args: Array<[string, string]>
  data: Hex
}

export type AdminTx =
  | { ok: true; via: 'safe' | 'atomic' | 'direct'; calls: InnerCall[]; outer: Array<[string, string]> | null }
  | { ok: false; problem: string }

const no = (problem: string) => ({ ok: false as const, problem })

/** The pause pairs D13 sends atomically: the core's pause or unpause, then the Evaluator's notePause. */
const ATOMIC = [['Core', ['pause', 'unpause']], ['HirelingEvaluator', ['notePause']]] as const
/** The core's pause and unpause go out only inside that pair, never alone (U5-SEC-002); a lone notePause is fine. */
const pairedOnly = (call: InnerCall) => call.contract === ATOMIC[0][0] && (ATOMIC[0][1] as readonly string[]).includes(call.functionName)

/**
 * Reads an admin transaction back from its calldata alone, and refuses it unless it is one this console builds for
 * this chain, Safe and owner: `execTransaction` signed as this owner with no value, refund or gas price, around an
 * allowed call on a configured contract (operation 0), or around MultiSendCallOnly with exactly a pause pair
 * (operation 1); or an allowed permissionless call made directly. Nothing stored beside the calldata is trusted.
 */
export function readAdminTx(tx: { chainId: number; to: string; data: string; value?: string | undefined }, ctx: AdminContext): AdminTx {
  if (tx.chainId !== ctx.chainId) return no('It is for another network.')
  if ((tx.value ?? '0') !== '0') return no('It sends value.')
  if (!isHex(tx.data)) return no('Its calldata is not hex.')
  const call = (to: string, data: Hex, via: 'safe' | 'direct'): InnerCall | string => {
    const target = ctx.targets[to.toLowerCase()]
    if (target === undefined) return `It calls ${to}, which is not a Hireling contract in this deployment.`
    let read: ReturnType<typeof describe>
    try {
      read = describe(target.abi, data)
    } catch {
      return `Its call to ${target.name} does not decode.`
    }
    const allowed = via === 'safe' ? target.safe : target.direct
    if (!allowed.includes(read.functionName)) return `${target.name}.${read.functionName} is not something this console sends ${via === 'safe' ? 'as the Safe' : 'directly'}.`
    return { contract: target.name, to: getAddress(to), functionName: read.functionName, args: read.args, data }
  }

  if (!same(tx.to, ctx.safe)) {
    const inner = call(tx.to, tx.data, 'direct')
    return typeof inner === 'string' ? no(inner) : { ok: true, via: 'direct', calls: [inner], outer: null }
  }
  let args: readonly unknown[]
  try {
    const decoded = decodeFunctionData({ abi: safeAbi, data: tx.data })
    if (decoded.functionName !== 'execTransaction') return no('It is not a Safe execTransaction.')
    args = decoded.args
  } catch {
    return no('It does not decode as a Safe execTransaction.')
  }
  const [to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, signatures] = args as [Address, bigint, Hex, number, bigint, bigint, bigint, Address, Address, Hex]
  if (value !== 0n || safeTxGas !== 0n || baseGas !== 0n || gasPrice !== 0n || !same(gasToken, zeroAddress) || !same(refundReceiver, zeroAddress)) {
    return no('It moves value or pays a refund from the Safe.')
  }
  if (signatures.toLowerCase() !== preValidated(ctx.owner).toLowerCase()) return no('It is not signed as you, the signed-in Safe owner.')
  const outer: Array<[string, string]> = [
    ['to', to],
    ['value', '0'],
    ['operation', operation === 1 ? '1 (delegatecall)' : '0 (call)'],
    ['safeTxGas', '0'],
    ['baseGas', '0'],
    ['gasPrice', '0'],
    ['gasToken', zeroAddress],
    ['refundReceiver', zeroAddress],
    ['signatures', signatures],
  ]
  if (operation === 0) {
    const inner = call(to, data, 'safe')
    if (typeof inner === 'string') return no(inner)
    if (pairedOnly(inner)) return no(`${inner.contract}.${inner.functionName} goes out only with the Evaluator’s notePause, as one MultiSend transaction.`)
    return { ok: true, via: 'safe', calls: [inner], outer }
  }
  if (operation !== 1) return no('It uses an unknown Safe operation.')
  if (!same(to, MULTI_SEND_CALL_ONLY)) return no('Its delegatecall is not to MultiSendCallOnly.')
  const packed = unpackMultiSend(data)
  if (packed === null) return no('Its MultiSend batch does not decode.')
  if (packed.length !== ATOMIC.length || packed.some((p) => p.operation !== 0 || p.value !== 0n)) return no('Its MultiSend batch is not a pause pair.')
  const calls: InnerCall[] = []
  for (const [i, p] of packed.entries()) {
    const inner = call(p.to, p.data, 'safe')
    if (typeof inner === 'string') return no(inner)
    const [contract, functions] = ATOMIC[i] as (typeof ATOMIC)[number]
    if (inner.contract !== contract || !(functions as readonly string[]).includes(inner.functionName)) return no('Its MultiSend batch is not a pause pair.')
    calls.push(inner)
  }
  return { ok: true, via: 'atomic', calls, outer }
}

/**
 * Reads a whole console operation: each transaction by `readAdminTx`, and the operation refused unless it is exactly
 * one transaction, as every operation this console builds is. A pause and its note split over two transactions is
 * the gap D13 closes, whatever each one reads as alone.
 */
export function readAdminOp(txs: ReadonlyArray<Parameters<typeof readAdminTx>[0]>, ctx: AdminContext): AdminTx[] {
  const reads = txs.map((tx) => readAdminTx(tx, ctx))
  return txs.length === 1 ? reads : [...reads, no(`It holds ${txs.length} transactions; this console sends one per operation.`)]
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
