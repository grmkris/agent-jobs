import { Schema } from 'effect'
import { Conflict, NotFound } from '../errors.ts'
import { RoadmapItemDetail } from '../schema/roadmap.ts'
import type { SyncSql } from '../sql/sync.ts'
import { hiddenOf, type HiddenRow } from '../thread/rows.ts'

export interface ItemRow extends HiddenRow {
  id: number
  title: string
  problem: string
  proposal: string
  proposer: string
  proposer_stake: string
  proposer_block: string | null
  status: string
  merged_into: number | null
  created_at: number
  updated_at: number
}
export interface SupportRow {
  item_id: number
  voter: string
}
export function requireItem(sql: SyncSql, id: number): ItemRow {
  const row = sql.all<ItemRow>('SELECT * FROM commons_items WHERE id=?', id)[0]
  if (row === undefined) throw new NotFound({ message: 'Roadmap item not found' })
  return row
}
function isActive(row: ItemRow): boolean {
  return row.merged_into === null && ['open', 'planned', 'building'].includes(row.status)
}
export function requireActive(row: ItemRow): void {
  if (!isActive(row)) throw new Conflict({ message: 'Item is not supportable' })
}
export function activeSupports(sql: SyncSql, address: string): number {
  return sql.all<{ count: number }>(
    `SELECT count(*) count FROM commons_supports s JOIN commons_items i ON i.id=s.item_id
    WHERE s.voter=? AND s.withdrawn_at IS NULL AND i.status IN ('open','planned','building') AND i.merged_into IS NULL`,
    address,
  )[0]!.count
}
export function itemOf(sql: SyncSql, row: ItemRow, weight = 0n, caller?: string): RoadmapItemDetail {
  const gaps = sql
    .all<{ gap_id: number }>('SELECT gap_id FROM commons_item_gaps WHERE item_id=? ORDER BY gap_id', row.id)
    .map((g) => g.gap_id)
  const supporters = sql.all<{ count: number }>(
    'SELECT count(*) count FROM commons_supports WHERE item_id=? AND withdrawn_at IS NULL',
    row.id,
  )[0]!.count
  const mine =
    caller === undefined
      ? {}
      : {
          mine:
            sql.all(
              'SELECT item_id FROM commons_supports WHERE item_id=? AND voter=? AND withdrawn_at IS NULL',
              row.id,
              caller,
            ).length > 0,
        }
  return Schema.decodeUnknownSync(RoadmapItemDetail)({
    id: row.id,
    title: row.title,
    status: row.status,
    proposer: row.proposer,
    supporters,
    weight: weight.toString(),
    gapIds: gaps,
    mergedInto: row.merged_into,
    hidden: hiddenOf(row),
    threadSubject: `roadmap:${row.id}`,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    problem: row.problem,
    proposal: row.proposal,
    proposerStake: row.proposer_stake,
    proposerBlock: row.proposer_block,
    ...mine,
  })
}
