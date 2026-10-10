/**
 * A delivery as the activity rows and the receipt card show it, from the API's
 * `GET [/b/<slug>]/data/deliverables/<taskId>/<deliverableHash>/preview`: the deliverable the board recorded (its
 * descriptor and submission check) and what a delivered site says about itself (its `deliverable.json`, else its page
 * head). Read once per delivery and kept: none of it changes after submit.
 */
import { useQuery } from '@tanstack/react-query'
import type { FeedJob } from './activity-feed.ts'
import { type Deliverable, type DeliverableCheck, boardApi, currentBoardId } from './api.ts'

export type PreviewType = 'video' | 'audio' | 'site' | 'report' | 'dataset' | 'image' | 'code'

export interface DeliverablePreview {
  source: 'manifest' | 'page' | null
  type: PreviewType | null
  title: string | null
  summary: string | null
  /** https on a public host: the worker's own poster, loaded from its host. */
  poster: string | null
  media: string | null
}

export interface RowDelivery {
  deliverable: { descriptor: Deliverable; check: DeliverableCheck | null }
  preview: DeliverablePreview
}

/** Where a job's delivery preview is read: the board's own prefix for a tenant board, none for the public one. */
export const previewUrl = (apiBase: string, taskId: string, hash: string) =>
  `${apiBase}/data/deliverables/${encodeURIComponent(taskId)}/${hash.toLowerCase()}/preview`

/** The reply, or null when the API has nothing for it (not on chain yet, not this board's task). */
async function fetchDelivery(url: string): Promise<RowDelivery | null> {
  const res = await fetch(url)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`delivery preview: HTTP ${res.status}`)
  // SAFETY: the API answers `{ ok: true, deliverable, preview }` with 200 (apps/api/src/deliverable-preview.ts).
  return (await res.json()) as RowDelivery
}

/** Where a delivery is recorded: the board that froze the offer, the task, and the chain's deliverable hash. */
export interface DeliveryWhere {
  boardId: string
  taskId: string | undefined
  hash: string | null | undefined
}

/** A job's delivery, read once `enabled`; the job page and every row and card of the same job share one read. */
export function useJobDelivery({ boardId, taskId, hash }: DeliveryWhere, enabled = true) {
  return useQuery({
    queryKey: ['delivery-preview', boardId, taskId, hash ?? undefined],
    queryFn: () => fetchDelivery(previewUrl(boardApi(boardId).apiBase, taskId ?? '', hash ?? '')),
    enabled: enabled && taskId !== undefined && hash != null,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
}

/** The delivery of a job the chain shows as delivered; reads only once `enabled` (a row near the viewport, a card). */
export function useRowDelivery(job: FeedJob | undefined, enabled: boolean) {
  const chain = job?.item.chain
  return useJobDelivery(
    { boardId: chain?.board_id ?? currentBoardId(), taskId: job?.item.task?.taskId, hash: chain?.deliverable },
    enabled,
  )
}
