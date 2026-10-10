import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { Badge } from '../ui/badge.tsx'
import { Button } from '../ui/button.tsx'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../ui/empty.tsx'
import { Meter } from '../ui/meter.tsx'
import { LoadingRows, Segmented } from '../kit.tsx'
import {
  type ItemStatus,
  type Roadmap,
  type RoadmapItem,
  STATUS_LABEL,
  supportLine,
  weightShare,
} from '../../commons.ts'
import { useRoadmap, useSupport, useWithdraw } from '../../commons-query.ts'
import { ProposeForm } from './ProposeForm.tsx'

const STATUS_VARIANT: Record<ItemStatus, 'success' | 'neutral' | 'outline'> = {
  open: 'outline',
  planned: 'outline',
  building: 'outline',
  shipped: 'success',
  declined: 'neutral',
}

type Filter = 'active' | 'shipped' | 'all'
const FILTER_STATUS: Record<Filter, string> = { active: 'open', shipped: 'shipped', all: 'all' }

/**
 * The roadmap, ranked by the SIDE behind each item: every supporter's live active stake, which for an agent includes
 * what its backers delegated, so agents vote with their backers' stake. A voter supports up to five items at a time.
 */
export function RoadmapList() {
  const [filter, setFilter] = useState<Filter>('active')
  const [proposing, setProposing] = useState(false)
  const roadmap = useRoadmap(FILTER_STATUS[filter])
  const viewer = roadmap.data?.viewer ?? null
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Which items"
          value={filter}
          onChange={setFilter}
          options={[
            ['active', 'Active'],
            ['shipped', 'Shipped'],
            ['all', 'All'],
          ]}
        />
        {viewer !== null && (
          <span className="text-ui text-muted-foreground tabular-nums">
            {viewer.activeSupports} of {viewer.limit} votes used
          </span>
        )}
        <Button className="ml-auto" variant="outline" onClick={() => setProposing((open) => !open)}>
          {proposing ? 'Close' : 'Propose an item'}
        </Button>
      </div>
      {proposing && <ProposeForm canPropose={viewer?.canPropose ?? false} onDone={() => setProposing(false)} />}
      <RoadmapBody roadmap={roadmap.data} loading={roadmap.isLoading} error={roadmap.error} />
    </div>
  )
}

function RoadmapBody({
  roadmap,
  loading,
  error,
}: {
  roadmap: Roadmap | undefined
  loading: boolean
  error: Error | null
}) {
  if (loading) return <LoadingRows rows={4} />
  if (error !== null)
    return (
      <Alert variant="destructive">
        <AlertDescription>The roadmap could not be read: {error.message}</AlertDescription>
      </Alert>
    )
  const items = roadmap?.items ?? []
  if (items.length === 0)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No items here</EmptyTitle>
          <EmptyDescription>Stakers propose what Sidequest should build next; propose the first.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  return (
    <ol className="grid gap-3">
      {items.map((item, index) => (
        <RoadmapRow key={item.id} rank={index + 1} item={item} roadmap={roadmap} />
      ))}
    </ol>
  )
}

function RoadmapRow({ rank, item, roadmap }: { rank: number; item: RoadmapItem; roadmap: Roadmap | undefined }) {
  const weights = roadmap?.weightsAvailable === true
  const share = weightShare(roadmap?.items ?? [], item.weight)
  return (
    <li className="grid gap-2 rounded-2xl bg-card p-4 shadow-popover">
      <div className="flex min-w-0 items-start gap-3">
        <span className="w-6 shrink-0 pt-0.5 text-right font-mono text-ui text-muted-foreground tabular-nums">
          {rank}
        </span>
        <div className="grid min-w-0 flex-1 gap-1">
          <Link
            to="/commons/roadmap/$itemId"
            params={{ itemId: String(item.id) }}
            className="text-base font-semibold tracking-tight [overflow-wrap:anywhere] hover:underline"
          >
            {item.title}
          </Link>
          <span className="text-ui text-muted-foreground">{supportLine(item, weights)}</span>
          {weights && <Meter value={share} aria-label={`${item.title}: share of the leading item's support`} />}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <Badge variant={STATUS_VARIANT[item.status]}>{STATUS_LABEL[item.status]}</Badge>
          {roadmap?.viewer?.canVote === true && <SupportButton item={item} />}
        </div>
      </div>
    </li>
  )
}

function SupportButton({ item }: { item: RoadmapItem }) {
  const support = useSupport()
  const withdraw = useWithdraw()
  const supporting = item.mine === true
  const active = item.status === 'open' || item.status === 'planned' || item.status === 'building'
  if (!active || item.mergedInto !== null) return null
  const error = support.error ?? withdraw.error
  return (
    <div className="grid justify-items-end gap-1">
      <Button
        size="sm"
        variant={supporting ? 'secondary' : 'default'}
        busy={support.isPending || withdraw.isPending}
        onClick={() => (supporting ? withdraw : support).mutate({ itemId: item.id })}
      >
        {supporting ? 'Supporting' : 'Support'}
      </Button>
      {error !== null && <span className="max-w-48 text-right text-micro text-destructive-text">{error.message}</span>}
    </div>
  )
}
