import { nowSeconds } from '../time.ts'
import { Effect } from 'effect'
import { CommonsSql } from '../services.ts'
import type { MergeItemsInput } from '../schema/roles.ts'
import { requireRole } from '../roles/holders.ts'
import { writeRoleLog } from '../roles/log.ts'
import { sqlEffect } from '../sql/effects.ts'
import { Conflict } from '../errors.ts'
import { itemOf, requireItem } from './common.ts'

export const mergeItems = Effect.fnUntraced(function* (caller: string | undefined, input: typeof MergeItemsInput.Type) {
  const actor = yield* requireRole(caller, true)
  const now = yield* nowSeconds
  const sql = yield* CommonsSql
  return yield* sqlEffect(() =>
    sql.transaction((tx) => {
      if (input.sourceId === input.targetId) throw new Conflict({ message: 'Cannot merge an item into itself' })
      const source = requireItem(tx, input.sourceId)
      const target = requireItem(tx, input.targetId)
      if (source.merged_into !== null) throw new Conflict({ message: 'Source item already merged' })
      if (target.merged_into !== null) throw new Conflict({ message: 'Target item already merged' })
      const moveSupports = ['open', 'planned', 'building'].includes(source.status)
      const movedSupports = tx.all<{ count: number }>(
        'SELECT count(*) count FROM commons_supports WHERE item_id=? AND withdrawn_at IS NULL',
        source.id,
      )[0]!.count
      if (moveSupports)
        tx.run(
          `INSERT OR IGNORE INTO commons_supports(item_id,voter,created_at,withdrawn_at)
      SELECT ?,voter,created_at,NULL FROM commons_supports WHERE item_id=? AND withdrawn_at IS NULL`,
          target.id,
          source.id,
        )
      if (moveSupports)
        tx.run(
          `UPDATE commons_supports SET withdrawn_at=NULL WHERE item_id=? AND voter IN
      (SELECT voter FROM commons_supports WHERE item_id=? AND withdrawn_at IS NULL)`,
          target.id,
          source.id,
        )
      tx.run('UPDATE commons_supports SET withdrawn_at=? WHERE item_id=? AND withdrawn_at IS NULL', now, source.id)
      tx.run('UPDATE commons_items SET merged_into=?,updated_at=? WHERE id=?', target.id, now, source.id)
      tx.run('UPDATE commons_items SET updated_at=? WHERE id=?', now, target.id)
      const logSeq = writeRoleLog(tx, {
        actor: actor.address,
        role: actor.role,
        action: 'merge_items',
        kind: 'item',
        id: source.id,
        detail: { targetId: target.id },
        reason: input.reason,
        now,
      })
      return { item: itemOf(tx, requireItem(tx, target.id)), movedSupports: moveSupports ? movedSupports : 0, logSeq }
    }),
  )
})
