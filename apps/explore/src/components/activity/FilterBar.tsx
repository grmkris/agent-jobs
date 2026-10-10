import { X } from 'lucide-react'
import { type FeedFilter, STEP_FILTERS, type StepFilter } from '../../activity-feed.ts'
import { cn } from '../../lib/cn.ts'
import { AgentLabel } from '../agent/AgentChip.tsx'
import { AgentOrb } from '../agent/AgentOrb.tsx'
import { SearchBox, TagChips } from '../JobFilters.tsx'
import { Segmented } from '../kit.tsx'

const STEP_LABEL: Readonly<Record<StepFilter, string>> = {
  all: 'All',
  open: 'Open',
  progress: 'Under way',
  review: 'In review',
  paid: 'Paid',
  disputes: 'Disputes',
  closed: 'Closed',
}

export type RowStyle = 'event' | 'job'

const chip = (on: boolean) =>
  cn(
    'inline-flex min-h-8 items-center gap-1.5 rounded-full px-3 text-sm font-medium transition-colors pointer-coarse:min-h-11',
    on ? 'bg-primary/14 text-primary' : 'bg-muted text-muted-foreground hover:text-foreground',
  )

/**
 * Activity's filters: a search, where the work stands (with how many jobs each would show, hiding the empty ones),
 * the viewer's own work, tags, and the agent picked from a row's details.
 */
export function FilterBar({
  filter,
  counts,
  ready,
  signedIn,
  onChange,
}: {
  filter: FeedFilter
  counts: Readonly<Record<StepFilter, number>>
  /** Whether the counts are known; until then they read "—". */
  ready: boolean
  signedIn: boolean
  onChange: (filter: FeedFilter) => void
}) {
  const steps = STEP_FILTERS.filter((step) => step === 'all' || step === filter.step || !ready || counts[step] > 0)
  return (
    <div className="grid min-w-0 gap-2">
      <div className="grid min-w-0 grid-cols-1 gap-2 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] md:items-center">
        <SearchBox value={filter.q} onChange={(q) => onChange({ ...filter, q })} label="Search activity" />
        <Segmented
          label="Where the work stands"
          value={filter.step}
          onChange={(step) => onChange({ ...filter, step })}
          options={steps.map(
            (step) =>
              [
                step,
                <span key={step} className="whitespace-nowrap">
                  {STEP_LABEL[step]}{' '}
                  <span className="text-muted-foreground tabular-nums">{ready ? counts[step] : '—'}</span>
                </span>,
              ] as const,
          )}
        />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {signedIn && (
          <button
            type="button"
            aria-pressed={filter.mine}
            className={chip(filter.mine)}
            onClick={() => onChange({ ...filter, mine: !filter.mine })}
          >
            Mine
          </button>
        )}
        {filter.agent !== null && (
          <button
            type="button"
            className={chip(true)}
            aria-label="Show every agent's work"
            onClick={() => onChange({ ...filter, agent: null })}
          >
            <AgentOrb agentId={filter.agent} size="sm" />
            <AgentLabel id={filter.agent} />
            <X aria-hidden className="size-3.5" />
          </button>
        )}
        <TagChips tags={filter.tags} onChange={(tags) => onChange({ ...filter, tags })} />
      </div>
    </div>
  )
}

/** Two ways to read the feed, offered on dev while they are compared: one row per event, or one per job. */
export function RowStyleSwitch({ value, onChange }: { value: RowStyle; onChange: (style: RowStyle) => void }) {
  return (
    <Segmented
      label="Rows"
      className="w-fit"
      value={value}
      onChange={onChange}
      options={[
        ['event', 'Events'],
        ['job', 'Jobs'],
      ]}
    />
  )
}
