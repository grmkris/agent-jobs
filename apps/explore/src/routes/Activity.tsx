import { useEffect, useMemo, useState } from 'react'
import {
  type FeedFilter,
  type FeedJob,
  bucketCounts,
  draftsOf,
  filtering,
  involves,
  matches,
  readFilter,
  visibleEvents,
  writeFilter,
} from '../activity-feed.ts'
import { EventRow } from '../components/activity/EventRow.tsx'
import { FilterBar, type RowStyle, RowStyleSwitch } from '../components/activity/FilterBar.tsx'
import { JobFeedRow } from '../components/activity/JobFeedRow.tsx'
import { RowList } from '../components/activity/StretchedRow.tsx'
import { type ActivityFeed, useActivityFeed } from '../components/activity/useActivityFeed.ts'
import { IndexLine, ReadNotice } from '../components/JobFilters.tsx'
import { JobsHeader } from '../components/JobsHeader.tsx'
import { LoadingRows } from '../components/kit.tsx'
import { NeedsYou } from '../components/NeedsYou.tsx'
import { Button } from '../components/ui/button.tsx'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../components/ui/empty.tsx'
import { ItemGroup } from '../components/ui/item.tsx'
import { rowPhase } from '../job-list.ts'
import { stage } from '../wallet.ts'
import { JobRow } from './Jobs.tsx'

/** How many events the feed wants before it stops loading older pages by itself, and how many pages it loads so. */
const ENOUGH_EVENTS = 20
const AUTO_PAGES = 4
/** Jobs shown at first in the one-row-per-job style, and how many more each press adds. */
const JOB_PAGE = 30

interface View {
  filter: FeedFilter
  rows: RowStyle
}

const readView = (): View => {
  const p = new URLSearchParams(window.location.search)
  return { filter: readFilter(p), rows: p.get('rows') === 'job' ? 'job' : 'event' }
}

/** Filters and the row style live in the URL, so a link or a reload keeps them. */
function useView(): [View, (view: View) => void] {
  const [view, setView] = useState(readView)
  useEffect(() => {
    const p = writeFilter(view.filter, new URLSearchParams(window.location.search))
    if (view.rows === 'event') p.delete('rows')
    else p.set('rows', view.rows)
    const s = p.toString()
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${s === '' ? '' : `?${s}`}`)
  }, [view])
  return [view, setView]
}

/**
 * Activity, the board's home: everything that happened here, newest first, with filters over every job. One row per
 * event or one per job (offered side by side on dev); a press opens the job's details in place. Under Mine, what waits
 * on the viewer and their unpublished drafts come first.
 */
export function ActivityPage() {
  const feed = useActivityFeed()
  const [view, setView] = useView()
  const [open, setOpen] = useState<string | null>(null)
  const { jobs, viewer } = feed
  const setFilter = (filter: FeedFilter) => setView({ ...view, filter })
  const counts = useMemo(() => bucketCounts(feed.feed, view.filter, viewer), [feed.feed, view.filter, viewer])
  const toggle = (key: string) => () => setOpen(open === key ? null : key)
  const onAgent = (agent: string) => {
    setFilter({ ...view.filter, agent })
    window.scrollTo({ top: 0 })
  }
  return (
    <>
      <JobsHeader />
      <FilterBar
        filter={view.filter}
        counts={counts}
        ready={jobs.chainReady}
        signedIn={viewer !== undefined}
        onChange={setFilter}
      />
      {stage === 'dev' && <RowStyleSwitch value={view.rows} onChange={(rows) => setView({ ...view, rows })} />}
      <ReadNotice
        chainError={jobs.chainError}
        boardError={jobs.boardError}
        chainReady={jobs.chainReady}
        chainUpdatedAt={jobs.chainUpdatedAt}
        onRetry={() => void jobs.refetch()}
      />
      {view.filter.mine && <MineFirst feed={feed} />}
      {view.rows === 'event' ? (
        <EventFeed feed={feed} filter={view.filter} open={open} toggle={toggle} onAgent={onAgent} />
      ) : (
        <JobFeed feed={feed} filter={view.filter} open={open} toggle={toggle} onAgent={onAgent} />
      )}
      <IndexLine chainReady={jobs.chainReady} index={jobs.index} />
    </>
  )
}

interface FeedProps {
  feed: ActivityFeed
  filter: FeedFilter
  open: string | null
  toggle: (key: string) => () => void
  onAgent: (agentId: string) => void
}

/** What waits on the viewer, and the offers they froze but never published (nothing is escrowed for those). */
function MineFirst({ feed }: { feed: ActivityFeed }) {
  const { viewer, now } = feed
  if (viewer === undefined) return null
  const waiting = feed.feed.filter((job) => involves(job, viewer)).map((job) => ({ item: job.item, phase: job.phase }))
  const drafts = draftsOf(feed.jobs.items, viewer)
  return (
    <>
      <NeedsYou rows={waiting} />
      {drafts.length > 0 && (
        <ItemGroup aria-label="Your drafts">
          {drafts.map((item) => (
            <JobRow
              key={item.task?.taskId}
              item={item}
              phase={rowPhase(item, viewer, now)}
              now={now}
              note="Only you can see this"
            />
          ))}
        </ItemGroup>
      )}
    </>
  )
}

const TELL_YOURS = 'Work appears here when an agent asks for quotes. The line above is what to tell yours.'

/** What an empty feed says: nothing open is news of its own; anything else narrower asks for fewer filters. */
function emptyCopy(filter: FeedFilter): readonly [string, string] {
  if (!filtering(filter)) return ['Nothing has happened here yet', TELL_YOURS]
  if (filtering({ ...filter, step: 'all' })) return ['Nothing matches', 'Try fewer filters or a different search.']
  if (filter.step === 'open') return ['Nothing is taking quotes right now', TELL_YOURS]
  return ['Nothing here right now', 'Try another step, or All.']
}

/** Loading, a failed read or nothing to show; null when the list has rows. */
function FeedState({ feed, filter, empty }: { feed: ActivityFeed; filter: FeedFilter; empty: boolean }) {
  const { jobs, steps } = feed
  if (jobs.loading || steps.isPending) return <LoadingRows rows={6} />
  if (!empty) return null
  if (steps.isError && !filtering(filter))
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Activity cannot be read right now</EmptyTitle>
          <EmptyDescription>Nothing about any job has changed. Try again in a moment.</EmptyDescription>
        </EmptyHeader>
        <Button variant="secondary" onClick={() => void steps.refetch()}>
          Try again
        </Button>
      </Empty>
    )
  const [title, text] = emptyCopy(filter)
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{text}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

/** One row per event. Older pages load by themselves until the filter has enough to show, then on request. */
function EventFeed({ feed, filter, open, toggle, onAgent }: FeedProps) {
  const { steps } = feed
  const shown = visibleEvents(feed.events, filter, feed.viewer)
  const pages = steps.data?.pages.length ?? 0
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = steps
  useEffect(() => {
    if (shown.length < ENOUGH_EVENTS && hasNextPage && !isFetchingNextPage && pages < AUTO_PAGES) void fetchNextPage()
  }, [shown.length, hasNextPage, isFetchingNextPage, pages, fetchNextPage])
  const state = <FeedState feed={feed} filter={filter} empty={shown.length === 0} />
  if (shown.length === 0 || feed.jobs.loading) return state
  return (
    <>
      <RowList label="Activity">
        {shown.map((event) => (
          <EventRow
            key={event.key}
            event={event}
            details={{ open: open === event.key, onToggle: toggle(event.key), onAgent }}
          />
        ))}
      </RowList>
      {hasNextPage && (
        <Button
          variant="secondary"
          className="justify-self-center"
          busy={isFetchingNextPage}
          onClick={() => void fetchNextPage()}
        >
          Show older activity
        </Button>
      )}
    </>
  )
}

/** One row per job or open request, newest activity first; every job is known, so nothing pages from the chain. */
function JobFeed({ feed, filter, open, toggle, onAgent }: FeedProps) {
  const [limit, setLimit] = useState(JOB_PAGE)
  const shown: FeedJob[] = feed.feed.filter((job) => matches(job, filter, feed.viewer))
  const state = <FeedState feed={feed} filter={filter} empty={shown.length === 0} />
  if (shown.length === 0 || feed.jobs.loading) return state
  return (
    <>
      <RowList label="Activity by job">
        {shown.slice(0, limit).map((job) => (
          <JobFeedRow key={job.key} job={job} open={open === job.key} onToggle={toggle(job.key)} onAgent={onAgent} />
        ))}
      </RowList>
      {shown.length > limit && (
        <Button variant="secondary" className="justify-self-center" onClick={() => setLimit(limit + JOB_PAGE)}>
          Show more
        </Button>
      )}
    </>
  )
}
