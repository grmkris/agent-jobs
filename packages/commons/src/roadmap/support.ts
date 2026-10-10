import { nowSeconds } from '../time.ts'
import { Effect } from 'effect'
import { CommonsSql } from '../services.ts'
import type { Address } from '../schema/ids.ts'
import { SupportItemOutput, WithdrawSupportOutput, type SupportItemInput } from '../schema/roadmap.ts'
import { authenticated, enabled } from '../roles/holders.ts'
import { Conflict, StakeRequired } from '../errors.ts'
import { sqlEffect } from '../sql/effects.ts'
import { takeRate } from '../rate.ts'
import { ownStake } from '../stake.ts'
import { activeSupports, requireActive, requireItem } from './common.ts'

export const supportItem = Effect.fnUntraced(function* (
  caller: Address | undefined,
  input: typeof SupportItemInput.Type,
) {
  yield* enabled()
  const address = yield* authenticated(caller)
  const own = yield* ownStake(address)
  if (own.stake <= 0n) return yield* new StakeRequired({ minimum: '1', stake: own.stake.toString(), backing: '0' })
  const sql = yield* CommonsSql
  const now = yield* nowSeconds
  const count = yield* sqlEffect(() =>
    sql.transaction((tx) => {
      requireActive(requireItem(tx, input.itemId))
      takeRate(tx, 'support', address, now)
      const countBefore = activeSupports(tx, address)
      if (
        tx.all(
          'SELECT item_id FROM commons_supports WHERE item_id=? AND voter=? AND withdrawn_at IS NULL',
          input.itemId,
          address,
        ).length > 0
      )
        return countBefore
      if (countBefore >= 5) throw new Conflict({ message: 'Support cap reached' })
      tx.run(
        `INSERT INTO commons_supports(item_id,voter,created_at,withdrawn_at) VALUES(?,?,?,NULL)
      ON CONFLICT(item_id,voter) DO UPDATE SET withdrawn_at=NULL,created_at=excluded.created_at`,
        input.itemId,
        address,
        now,
      )
      return activeSupports(tx, address)
    }),
  )
  return SupportItemOutput.make({ itemId: input.itemId, supporting: true, activeSupports: count, limit: 5 })
})
export const withdrawSupport = Effect.fnUntraced(function* (
  caller: Address | undefined,
  input: typeof SupportItemInput.Type,
) {
  yield* enabled()
  const address = yield* authenticated(caller)
  const sql = yield* CommonsSql
  const now = yield* nowSeconds
  const count = yield* sqlEffect(() =>
    sql.transaction((tx) => {
      requireItem(tx, input.itemId)
      takeRate(tx, 'support', address, now)
      tx.run(
        'UPDATE commons_supports SET withdrawn_at=? WHERE item_id=? AND voter=? AND withdrawn_at IS NULL',
        now,
        input.itemId,
        address,
      )
      return activeSupports(tx, address)
    }),
  )
  return WithdrawSupportOutput.make({ itemId: input.itemId, supporting: false, activeSupports: count })
})
