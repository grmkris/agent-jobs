/** Public, indexed backer-share schedules. The SDK window rule also drives the mining allocation. */
import { BoardError, DirectoryError, directoryAgentId } from '@sidequest/board'
import type { AsyncSql } from '@sidequest/indexer'
import {
  agentWindowShare,
  BACKER_SHARE_KEY,
  configuredClocks,
  decodeBackerShare,
  type Deployment,
} from '@sidequest/sdk'
import { Schema } from 'effect'
import { jsonResponse } from './json.ts'
import { COLLECT_INDEX_MAX_AGE } from './collect-index.ts'

type ShareSet = { position: number; value: string }

function epochClock(deployment: Deployment) {
  const h = deployment.sidequest
  if (h === null) throw new BoardError('unavailable', 'mining epochs are unavailable')
  const clocks = configuredClocks(deployment)
  const firstEnd = h.t0 + clocks.epochZeroDuration
  const epochAt = (at: number) => (at < firstEnd ? 0 : 1 + Math.floor((at - firstEnd) / clocks.epochDuration))
  const start = (epoch: number) => (epoch === 0 ? h.t0 : firstEnd + (epoch - 1) * clocks.epochDuration)
  const after = (at: number) => (at < h.t0 ? 0 : epochAt(at) + 1)
  return { ...clocks, epochAt, start, after }
}

export function backerShareSchedule(deployment: Deployment, agentId: string, sets: readonly ShareSet[], now: number) {
  const clock = epochClock(deployment)
  const epoch = clock.epochAt(now)
  const shareAt = (epochNumber: number) => {
    const at = clock.start(epochNumber)
    return agentWindowShare(sets, at - clock.unstakeDelay, at)
  }
  const current = { bps: shareAt(epoch), epoch, since: clock.start(epoch) }
  const next = { bps: shareAt(epoch + 1), epoch: epoch + 1 }
  const latest = sets.toSorted((a, b) => a.position - b.position).at(-1)
  let pendingCut: { bps: number; appliesFromEpoch: number; at: number } | null = null
  if (latest !== undefined && decodeBackerShare(latest.value) < Math.max(current.bps, next.bps)) {
    const bps = decodeBackerShare(latest.value)
    const candidates = [...new Set([epoch + 1, ...sets.map((set) => clock.after(set.position + clock.unstakeDelay))])]
      .filter((candidate) => candidate > epoch)
      .toSorted((a, b) => a - b)
    const appliesFromEpoch = candidates.find((candidate) => shareAt(candidate) === bps)
    if (appliesFromEpoch !== undefined) pendingCut = { bps, appliesFromEpoch, at: latest.position }
  }
  return { agentId, current, next, pendingCut, unstakeDelay: clock.unstakeDelay, epochSeconds: clock.epochDuration }
}

async function indexedSets(sql: AsyncSql, deployment: Deployment, agentId: string, now: number): Promise<ShareSet[]> {
  const h = deployment.sidequest
  if (h === null) throw new BoardError('unavailable', 'mining epochs are unavailable')
  const [cp] = await sql.all<{
    next_block: number
    updated_at: number
    core_address: string
    deployment_block: number
    complete: number
  }>(
    `SELECT c.*, s.next_block >= s.target_block AS complete FROM checkpoint c
      JOIN backer_share_checkpoint s ON s.chain_id=c.chain_id AND s.identity=lower(?) AND s.deployment_block=?
      WHERE c.chain_id=?`,
    deployment.identity,
    Number(h.block),
    deployment.chainId,
  )
  if (
    cp === undefined ||
    cp.complete !== 1 ||
    now - cp.updated_at > COLLECT_INDEX_MAX_AGE ||
    cp.updated_at > now + 5 ||
    cp.core_address?.toLowerCase() !== deployment.core.toLowerCase() ||
    cp.deployment_block !== Number(deployment.deployBlock)
  )
    throw new BoardError('unavailable', 'the backer share index is unavailable or behind')
  const rows = Schema.decodeUnknownSync(
    Schema.Array(Schema.Struct({ value: Schema.String, timestamp: Schema.NullOr(Schema.Number) })),
  )(
    await sql.all<{ value: string; timestamp: number | null }>(
      `SELECT json_extract(e.args_json,'$.metadataValue') AS value, b.timestamp
      FROM protocol_events e LEFT JOIN block_times b ON b.chain_id=e.chain_id AND b.block=e.block
      WHERE e.chain_id=? AND lower(e.contract)=lower(?) AND e.name='MetadataSet'
        AND json_extract(e.args_json,'$.agentId')=? AND json_extract(e.args_json,'$.metadataKey')=?
        AND e.block>=? AND e.block<? ORDER BY e.block, e.log_index`,
      deployment.chainId,
      deployment.identity,
      agentId,
      BACKER_SHARE_KEY,
      Number(h.block),
      cp.next_block,
    ),
  )
  return rows.flatMap((row) => {
    if (row.timestamp === null) throw new BoardError('unavailable', 'backer share event times are unavailable')
    return row.timestamp > now ? [] : [{ position: row.timestamp, value: row.value }]
  })
}

export async function backerShareRoute(
  sql: AsyncSql,
  deployment: Deployment,
  path: string,
  now: number,
  cors: Record<string, string> = {},
) {
  const headers = { ...cors, 'cache-control': 'no-store' }
  try {
    const agentId = directoryAgentId(path.slice('/data/backer-share/'.length))
    const sets = await indexedSets(sql, deployment, agentId, now)
    return jsonResponse({ ok: true, ...backerShareSchedule(deployment, agentId, sets, now) }, { headers })
  } catch (error) {
    const invalid = error instanceof DirectoryError && error.code === 'invalid'
    return jsonResponse(
      {
        ok: false,
        code: invalid ? 'invalid' : 'unavailable',
        message: invalid
          ? error.message
          : 'the backer share schedule is unavailable; retry after the indexer catches up',
      },
      { status: invalid ? 400 : 503, headers },
    )
  }
}
