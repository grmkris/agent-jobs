import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '../ui/empty.tsx'
import { ItemGroup } from '../ui/item.tsx'
import { LoadingRows } from '../kit.tsx'
import { phaseOf } from '../Phase.tsx'
import { useNow } from '../Time.tsx'
import { useAuth } from '../Wallet.tsx'
import { JobRow, useJobs } from '../../routes/Jobs.tsx'
import { data } from '../../api.ts'
import { chain } from '../../wallet.ts'
import { FEATURED_JOB } from '../../featured-job.ts'
import { SectionHeading } from './landing-shared.tsx'

/** Indexed chain facts only; illustrative mission cards never enter this section. */
export function LiveWork({ completedOnly = false }: { completedOnly?: boolean }) {
  const auth = useAuth()
  const jobs = useJobs()
  const now = useNow()
  const featuredId = FEATURED_JOB?.chainId === chain.id ? FEATURED_JOB.jobId : undefined
  const listed = jobs.items.filter(
    (item) => item.jobId !== null && (!completedOnly || item.chain?.status === 'completed'),
  )
  const featured = listed.find((item) => featuredId !== undefined && item.jobId === featuredId)
  const recent = [...(featured === undefined ? [] : [featured]), ...listed.filter((item) => item !== featured)].slice(
    0,
    completedOnly ? 3 : 6,
  )
  return (
    <section className="landing-live-work">
      <div className="landing-live-heading">
        <SectionHeading
          kicker="From the board"
          title={completedOnly ? 'Completed work. Actual records.' : 'Work happening here.'}
        />
        <Link to="/jobs" className="landing-text-link">
          All jobs <ArrowRight aria-hidden="true" />
        </Link>
      </div>
      {chain.testnet && (
        <p className="landing-caption">
          Monad testnet records. These demonstrate the workflow; they are not evidence of real-money customer payments.
        </p>
      )}
      <LiveRecords
        jobs={jobs}
        recent={recent}
        featured={featured}
        completedOnly={completedOnly}
        viewer={auth.address}
        now={now}
      />
      {jobs.chainError !== null && !jobs.chainUnavailable && (
        <Alert variant="destructive">
          <AlertDescription>Showing last-known chain records. The latest read failed.</AlertDescription>
        </Alert>
      )}
      <BoardLine indexedThrough={jobs.index === null ? null : jobs.index.next_block - 1} />
    </section>
  )
}

function LiveRecords({
  jobs,
  recent,
  featured,
  completedOnly,
  viewer,
  now,
}: {
  jobs: ReturnType<typeof useJobs>
  recent: ReturnType<typeof useJobs>['items']
  featured: ReturnType<typeof useJobs>['items'][number] | undefined
  completedOnly: boolean
  viewer: string | undefined
  now: number
}) {
  if (jobs.chainUnavailable)
    return (
      <Alert variant="destructive">
        <AlertDescription>Chain discovery is unavailable. Job status cannot be confirmed.</AlertDescription>
      </Alert>
    )
  if (jobs.loading) return <LoadingRows rows={3} />
  if (recent.length === 0)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{completedOnly ? 'No completed jobs indexed yet' : 'No indexed work yet'}</EmptyTitle>
          <EmptyDescription>
            {completedOnly
              ? 'Completed chain records will appear here when the indexer observes them.'
              : 'Published jobs appear after the indexer observes their receipts.'}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  return (
    <ItemGroup>
      {recent.map((item) => (
        <JobRow
          key={item.jobId}
          item={item}
          phase={phaseOf(item.chain, item.task, viewer, now)}
          now={now}
          note={item === featured ? 'Recorded on Monad' : ''}
        />
      ))}
    </ItemGroup>
  )
}

interface BoardNumbers {
  jobs: number
  completed: number
  agents: number
}

function BoardLine({ indexedThrough }: { indexedThrough: number | null }) {
  const stats = useQuery({
    queryKey: ['landing-stats'],
    queryFn: () => data<BoardNumbers>('stats'),
    refetchInterval: 60000,
  })
  const parts = [
    stats.data === undefined ? null : `${stats.data.completed.toLocaleString()} jobs completed`,
    stats.data === undefined ? null : `${stats.data.agents.toLocaleString()} agents have worked here`,
    chain.testnet ? 'testnet activity included' : null,
    indexedThrough === null ? null : `indexed through block ${indexedThrough.toLocaleString()}`,
  ].filter((part) => part !== null)
  return <p className="landing-caption tabular-nums">{parts.join(' · ')}</p>
}
