/** Validate hosted preparations against the bot's frozen decision before any signing. */
import { type Address, type Hex, encodeFunctionData, getAddress, keccak256 } from 'viem'
import type { Ctx } from './actions.ts'
import { hashText } from './actions.ts'
import { factoryTokenAbi, hirelingEvaluatorAbi, hirelingHoldingAbi } from './abi/index.ts'
import type { TxRequest } from './board-client.ts'
import type { OfferWindows } from './clocks.ts'
import { type DemandQuote, type DemandTemplate, parseMUsdAmount } from './demand-bot.ts'
import { type Selection, holdingDomain, selectionTypes, typedDataJson } from './typed-data.ts'

export function demandCanonicalJson(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString())
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(demandCanonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${demandCanonicalJson(entry)}`).join(',')}}`
}

export interface DemandIntent {
  readonly creator: Address
  readonly token: Address
  readonly template: DemandTemplate
  readonly title: string
  readonly brief: string
  readonly deliveryDeadline: number
  readonly quoteDeadline: number
  readonly arbitrator: Address
  readonly windows: OfferWindows
}

export interface DemandPreparation {
  readonly taskId: string
  readonly applicationId: string
  readonly termsHash: Hex
  readonly manifest?: string
  readonly manifestUrl?: string
  readonly manifestHash?: Hex
  readonly transactions: readonly TxRequest[]
}

export const DEMAND_MANIFEST_MAX_BYTES = 256 * 1024
export const DEMAND_MANIFEST_TIMEOUT_MS = 20_000

/** Hash the exact hosted bytes, without JSON normalization or authenticated fetches. */
export async function loadDemandManifest(prepared: DemandPreparation, boardUrl: string, timeoutMs = DEMAND_MANIFEST_TIMEOUT_MS): Promise<string> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(prepared.termsHash) || (prepared.manifestHash !== undefined && prepared.manifestHash !== prepared.termsHash)) throw new Error('manifest hash differs from prepared terms')
  let bytes: Uint8Array
  if (prepared.manifest !== undefined) {
    if (typeof prepared.manifest !== 'string') throw new Error('invalid inline manifest')
    bytes = new TextEncoder().encode(prepared.manifest)
  } else {
    const expected = new URL(`/offers/${prepared.termsHash}.json`, boardUrl)
    if (prepared.manifestUrl !== expected.href) throw new Error('manifest URL differs from prepared terms')
    const response = await fetch(expected, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } })
    if (!response.ok || response.body === null) throw new Error('offer manifest is unavailable')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      if (Number(response.headers.get('content-length') ?? '0') > DEMAND_MANIFEST_MAX_BYTES) throw new Error('offer manifest is too large')
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.length
        if (size > DEMAND_MANIFEST_MAX_BYTES) throw new Error('offer manifest is too large')
        chunks.push(chunk.value)
      }
    } finally { await reader.cancel() }
    bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  }
  if (bytes.length > DEMAND_MANIFEST_MAX_BYTES) throw new Error('offer manifest is too large')
  if (keccak256(bytes) !== prepared.termsHash) throw new Error('manifest hash differs from prepared terms')
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

export function assertDemandTransactions(actual: readonly TxRequest[], expected: readonly TxRequest[]) {
  if (actual.length !== expected.length) throw new Error('unexpected prepared transaction count')
  for (const [index, tx] of actual.entries()) {
    const want = expected[index]!
    if (tx.chainId !== 10143 || getAddress(tx.to) !== getAddress(want.to) || tx.data.toLowerCase() !== want.data.toLowerCase() || tx.value !== '0') throw new Error('prepared transaction differs from the frozen decision')
    if (tx.gas !== undefined && (!/^[1-9]\d*$/.test(tx.gas) || BigInt(tx.gas) > 2_000_000n)) throw new Error('unexpected gas limit')
  }
}

export function validateDemandPreparation(ctx: Ctx, intent: DemandIntent, requestHash: string, quote: DemandQuote, prepared: DemandPreparation, expiredAt: number) {
  if (prepared.manifest === undefined) throw new Error('offer manifest must be persisted before validation')
  const manifest = JSON.parse(prepared.manifest) as Record<string, unknown>
  const reward = parseMUsdAmount(quote.amount)
  const expectedFields = {
    v: 2, taskId: prepared.taskId, mode: 'hire', creator: intent.creator, approver: intent.creator,
    deployment: { chainId: 10143, core: ctx.deployment.core, holding: ctx.stack.holding, evaluator: ctx.stack.evaluator, identity: ctx.deployment.identity },
    token: intent.token, reward: reward.toString(), creatorBond: '0', workerBond: '0',
    deliveryDeadline: intent.deliveryDeadline, selectionDeadline: null, arbitrator: intent.arbitrator, windows: intent.windows,
    title: intent.title, brief: intent.brief, acceptanceCriteria: intent.template.acceptanceCriteria,
    quote: { requestHash, quoteHash: quote.quoteHash }, deliverable: intent.template.deliverable,
    evidencePolicy: intent.template.requiredChecks.length === 0 ? null : { checks: intent.template.requiredChecks, trustedProducer: 'github-actions', workflowPath: '.github/workflows' },
  }
  for (const [key, value] of Object.entries(expectedFields)) {
    let actual = manifest[key]
    let expected: unknown = value
    if (['creator', 'approver', 'token', 'arbitrator'].includes(key)) {
      actual = getAddress(actual as string)
      expected = getAddress(value as string)
    } else if (key === 'deployment') {
      const actualDeployment = actual as Record<string, unknown>
      const expectedDeployment = value as Record<string, unknown>
      const normalizedActual = { ...actualDeployment }
      const normalizedExpected = { ...expectedDeployment }
      for (const field of ['core', 'holding', 'evaluator', 'identity']) {
        normalizedActual[field] = getAddress(actualDeployment[field] as string)
        normalizedExpected[field] = getAddress(expectedDeployment[field] as string)
      }
      actual = normalizedActual
      expected = normalizedExpected
    }
    if (demandCanonicalJson(actual) !== demandCanonicalJson(expected)) throw new Error(`manifest mismatch: ${key}`)
  }
  if (manifest.executionBudget !== undefined || manifest.eligibility !== null || manifest.projectId !== null || manifest.policyVersion !== null) throw new Error('unexpected additional policy or budget')
  if (demandCanonicalJson(manifest) !== prepared.manifest || hashText(prepared.manifest) !== prepared.termsHash) throw new Error('manifest hash differs from prepared terms')
  const publish: TxRequest = {
    description: 'Publish exact demand hire', chainId: 10143, to: ctx.stack.holding, value: '0',
    data: encodeFunctionData({ abi: hirelingHoldingAbi, functionName: 'publish', args: [{
      approver: intent.creator, arbitrator: intent.arbitrator, manifestHash: prepared.termsHash, policyHash: prepared.termsHash,
      token: intent.token, reward, creatorBond: 0n, workerBond: 0n, deliveryDeadline: intent.deliveryDeadline, expiredAt,
      reviewWindow: intent.windows.reviewSeconds, disputeWindow: intent.windows.disputeSeconds, arbitrationWindow: intent.windows.arbitrationSeconds,
    }] }),
  }
  const approve: TxRequest = {
    description: 'Approve exact reward', chainId: 10143, to: intent.token, value: '0',
    data: encodeFunctionData({ abi: factoryTokenAbi, functionName: 'approve', args: [ctx.stack.holding, reward] }),
  }
  assertDemandTransactions(prepared.transactions, prepared.transactions.length === 2 ? [approve, publish] : [publish])
}

export function validateDemandSelection(ctx: Ctx, json: string, nonce: string, expected: Omit<Selection, 'nonce' | 'activateBy'>, latestActivation: number, now: number): Selection {
  const body = JSON.parse(json) as { message: { activateBy: number } }
  const activateBy = Number(body.message.activateBy)
  if (!Number.isSafeInteger(activateBy) || activateBy <= now || activateBy > latestActivation) throw new Error('invalid activation deadline')
  if (!/^\d+$/.test(nonce)) throw new Error('invalid selection nonce')
  const selection: Selection = { ...expected, nonce: BigInt(nonce), activateBy }
  const want = JSON.parse(typedDataJson(holdingDomain(10143, ctx.stack.holding), selectionTypes, 'Selection', selection)) as unknown
  if (demandCanonicalJson(JSON.parse(json)) !== demandCanonicalJson(want)) throw new Error('selection differs from the chosen worker and offer')
  return selection
}

export function demandAcceptTransaction(ctx: Ctx, jobId: bigint): TxRequest {
  return { description: 'Accept checked deliverable', chainId: 10143, to: ctx.stack.evaluator, value: '0', gas: '1200000', data: encodeFunctionData({ abi: hirelingEvaluatorAbi, functionName: 'accept', args: [jobId] }) }
}
