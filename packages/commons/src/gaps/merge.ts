import { nowSeconds } from '../time.ts'
import { Effect } from 'effect'
import { CommonsSql } from '../services.ts'
import type { MergeGapsInput } from '../schema/roles.ts'
import { requireRole } from '../roles/holders.ts'
import { writeRoleLog } from '../roles/log.ts'
import { sqlEffect } from '../sql/effects.ts'
import { Conflict } from '../errors.ts'
import { rootGap } from './cluster.ts'
import { gapOf } from './rows.ts'

export const mergeGaps = Effect.fnUntraced(function* (caller: string | undefined, input: typeof MergeGapsInput.Type) {
  const actor = yield* requireRole(caller, true)
  const now = yield* nowSeconds
  const sql = yield* CommonsSql
  return yield* sqlEffect(() =>
    sql.transaction((tx) => {
      const source = rootGap(tx, input.sourceGapId)
      const target = rootGap(tx, input.targetGapId)
      if (source.id === target.id) throw new Conflict({ message: 'Cannot merge a gap into itself' })
      tx.run('UPDATE commons_gap_reports SET gap_id=? WHERE gap_id=?', target.id, source.id)
      const movedReports = tx.all<{ count: number }>('SELECT changes() count')[0]!.count
      tx.run(
        'INSERT OR IGNORE INTO commons_item_gaps SELECT item_id,? FROM commons_item_gaps WHERE gap_id=?',
        target.id,
        source.id,
      )
      tx.run('DELETE FROM commons_item_gaps WHERE gap_id=?', source.id)
      tx.run('UPDATE commons_gaps SET merged_into=? WHERE id=?', target.id, source.id)
      const logSeq = writeRoleLog(tx, {
        actor: actor.address,
        role: actor.role,
        action: 'merge_gaps',
        kind: 'gap',
        id: source.id,
        detail: { targetId: target.id },
        reason: input.reason,
        now,
      })
      return { gap: gapOf(tx, target), movedReports, logSeq }
    }),
  )
})
