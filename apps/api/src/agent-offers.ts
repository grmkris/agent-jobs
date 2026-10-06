/** Publish a managed hire's frozen terms before the executor can escrow its reward. */
import { BoardError, canonicalJson } from '@sidequest/board'
import type { AgentPreparedCall } from '@sidequest/board'
import type { AsyncSql } from '@sidequest/indexer'
import { keccak256, stringToHex } from 'viem'
import { boardOfTerms, recordOffer } from './registry.ts'

export interface OfferBucket {
  get(key: string): Promise<{ text(): Promise<string> } | null>
  put(key: string, value: string): Promise<unknown>
}

export async function publishAgentOffer(input: {
  readonly sql: AsyncSql
  readonly bucket: OfferBucket | undefined
  readonly boardId: string
  readonly action: AgentPreparedCall
  readonly now: number
}): Promise<void> {
  const { sql, bucket, boardId, action, now } = input
  if (action.manifest === undefined) return
  const { manifest, termsHash, taskId } = action
  if (typeof manifest !== 'string' || typeof termsHash !== 'string' || typeof taskId !== 'string' || taskId.length === 0 ||
      keccak256(stringToHex(canonicalJson(JSON.parse(manifest)))) !== termsHash.toLowerCase()) {
    throw new BoardError('conflict', 'The frozen offer publication is invalid')
  }
  if (bucket === undefined) throw new BoardError('unavailable', 'Offer publication is unavailable; no hire was sent')
  const key = `offers/${termsHash.toLowerCase()}.json`
  const previous = await bucket.get(key)
  if (previous === null) await bucket.put(key, manifest)
  const stored = await bucket.get(key)
  if (stored === null || await stored.text() !== manifest) throw new BoardError('unavailable', 'Frozen offer readback failed; no hire was sent')
  const existing = await boardOfTerms(sql, termsHash)
  if (existing !== undefined && (existing.boardId !== boardId || existing.taskId !== taskId)) throw new BoardError('conflict', 'Frozen offer belongs to another board or task')
  await recordOffer(sql, { boardId, termsHash, taskId, now })
  const recorded = await boardOfTerms(sql, termsHash)
  if (recorded?.boardId !== boardId || recorded.taskId !== taskId) throw new BoardError('unavailable', 'Offer attribution readback failed; no hire was sent')
}
