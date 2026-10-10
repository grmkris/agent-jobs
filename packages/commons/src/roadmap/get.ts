import { Effect } from 'effect'
import { CommonsSql } from '../services.ts'
import type { Address } from '../schema/ids.ts'
import type { GetRoadmapItemInput } from '../schema/roadmap.ts'
import { enabled } from '../roles/holders.ts'
import { itemOf, requireItem } from './common.ts'
import { sqlEffect } from '../sql/effects.ts'
import { rootGap } from '../gaps/cluster.ts'
import { gapOf } from '../gaps/rows.ts'
import { itemLog } from '../roles/log.ts'
import { roadmapWeights } from './weights.ts'

export const getRoadmapItem = Effect.fnUntraced(function* (
  caller: Address | undefined,
  input: typeof GetRoadmapItemInput.Type,
) {
  yield* enabled()
  const sql = yield* CommonsSql
  const row = yield* sqlEffect(() => requireItem(sql, input.itemId))
  const voters = sql
    .all<{ voter: Address }>(
      'SELECT voter FROM commons_supports WHERE item_id=? AND withdrawn_at IS NULL ORDER BY voter',
      row.id,
    )
    .map((r) => r.voter)
  const snapshot = yield* roadmapWeights(voters).pipe(Effect.catch(() => Effect.succeed(null)))
  const gaps = sql
    .all<{ gap_id: number }>('SELECT gap_id FROM commons_item_gaps WHERE item_id=? ORDER BY gap_id', row.id)
    .map((r) => gapOf(sql, rootGap(sql, r.gap_id)))
  const supporters = voters.map((address) => ({ address, weight: (snapshot?.stake.get(address) ?? 0n).toString() }))
  const weight = supporters.reduce((sum, s) => sum + BigInt(s.weight), 0n)
  return {
    item: itemOf(sql, row, weight, caller),
    supporters,
    block: snapshot?.block.toString() ?? null,
    gaps,
    log: itemLog(sql, row.id),
    thread: {
      subject: `roadmap:${row.id}`,
      count: sql.all<{ count: number }>(
        'SELECT count(*) count FROM commons_messages WHERE subject=?',
        `roadmap:${row.id}`,
      )[0]!.count,
    },
  }
})
