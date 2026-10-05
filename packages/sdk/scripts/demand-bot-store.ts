import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { type Address, type Hex } from 'viem'
import { type DemandQuote, type DailySpend, createDailySpend, releaseSpend } from '../src/demand-bot.ts'
import { type DemandIntent, type DemandPreparation, loadDemandManifest } from '../src/demand-bot-validation.ts'
import { type FlowState, parseFlowJson } from '../src/flow-journal.ts'
import type { Selection } from '../src/typed-data.ts'
import { ensureFlowDirectory, saveFlowState } from './flow-persistence.ts'

export interface DemandOperation {
  id: string
  sequence: number
  intent: DemandIntent
  quoteCollectionEndsAt?: number
  request?: { requestId: string; requestHash: Hex }
  quote?: DemandQuote
  prepared?: DemandPreparation
  jobId?: bigint
  publishedAt?: number
  selection?: { nonce: string; value: Selection; signature: Hex }
  selected?: boolean
  closed?: string
  review?: string
  reconciliation?: { at: number; blockNumber: bigint; latestNonce: number; pendingNonce: number; released: bigint }
  accept?: { to: Address; data: Hex; value: string; gas?: string }
}

export async function persistDemandManifest(operation: DemandOperation, save: () => void, boardUrl: string) {
  if (operation.prepared === undefined) throw new Error('demand preparation is missing')
  const manifest = await loadDemandManifest(operation.prepared, boardUrl)
  operation.prepared = { ...operation.prepared, manifest }
  save()
  return operation.prepared
}

/** Never discard a signed send, even if its receipt is currently missing. */
export function abandonDemandOperation(state: FlowState, bot: DemandBotState, operation: DemandOperation, reason: string): bigint {
  if (operation.jobId !== undefined || operation.publishedAt !== undefined || operation.selection !== undefined || operation.selected || operation.accept !== undefined ||
    Object.keys(state.sends).some(key => key.startsWith(`${operation.id}/`)) ||
    Object.keys(state.values).some(key => key.startsWith(`receipt/${operation.id}/`))) throw new Error('cannot abandon an operation with a possible chain effect')
  if (operation.closed !== undefined && operation.closed !== 'abandoned') throw new Error('operation is already closed')
  const released = releaseSpend(bot.spend, operation.id)
  operation.closed = 'abandoned'
  operation.review = reason
  return released
}

export interface DemandBotState {
  version: 1
  sequence: number
  nextRequestAt: number
  spend: DailySpend
  operations: DemandOperation[]
}

export function openDemandStore(path: string, binding: string, now: number) {
  const directory = pathToFileURL(`${path.replace(/\/$/, '')}/`)
  ensureFlowDirectory(directory)
  const file = new URL('journal.json', directory)
  const state: FlowState = existsSync(file) ? parseFlowJson(readFileSync(file, 'utf8')) : { binding, values: {}, sends: {} }
  if (state.binding !== binding) throw new Error('demand journal binding differs; never reset or transplant it')
  const bot = (state.values.bot ?? { version: 1, sequence: 0, nextRequestAt: now, spend: createDailySpend(), operations: [] }) as DemandBotState
  if (bot.version !== 1) throw new Error('unsupported demand journal version')
  state.values.bot = bot
  const save = () => saveFlowState(directory, state)
  save()
  return { directory, state, bot, save }
}
