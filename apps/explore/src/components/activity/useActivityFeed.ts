import { type InfiniteData, useInfiniteQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { type FeedEvent, type FeedJob, feedEvents, feedJobs } from '../../activity-feed.ts'
import { boardPrefix, data } from '../../api.ts'
import type { ActivityStep } from '../../live-activity.ts'
import { useQuoteRequests } from '../../quote-requests.ts'
import { useJobs, usePosterAgents } from '../../routes/Jobs.tsx'
import { useMinute } from '../Time.tsx'
import { useAuth } from '../Wallet.tsx'

interface ActivityPage {
  steps: ActivityStep[]
  nextCursor: string | null
}

const activityPage = (cursor: string | undefined) =>
  data<ActivityPage>(`activity?limit=50${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`)

/**
 * The board's chain steps, newest first, a page of 50 at a time. Only the first page polls: refetching an infinite
 * query re-reads every loaded page in turn, so once someone has loaded more, the list holds still until they reload.
 */
function useSteps() {
  return useInfiniteQuery<ActivityPage, Error, InfiniteData<ActivityPage>, readonly string[], string | undefined>({
    queryKey: ['activity-feed', boardPrefix()],
    initialPageParam: undefined,
    queryFn: ({ pageParam }) => activityPage(pageParam),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: (query) => ((query.state.data?.pages.length ?? 0) > 1 ? false : 20_000),
    refetchIntervalInBackground: false,
  })
}

export interface ActivityFeed {
  jobs: ReturnType<typeof useJobs>
  steps: ReturnType<typeof useSteps>
  /** Every job and open request, newest activity first. */
  feed: FeedJob[]
  /** The loaded steps and the requests as events, newest first. */
  events: FeedEvent[]
  requestsError: Error | null
  viewer: string | undefined
  now: number
}

/** The Activity page's data: the jobs list's records, the board's requests and its chain steps, joined. */
export function useActivityFeed(): ActivityFeed {
  const jobs = useJobs()
  const requests = useQuoteRequests()
  const posters = usePosterAgents()
  const { address } = useAuth()
  const now = useMinute()
  const steps = useSteps()
  const loaded = useMemo(() => steps.data?.pages.flatMap((page) => page.steps) ?? [], [steps.data])
  const feed = useMemo(
    () => feedJobs({ items: jobs.items, requests: requests.data ?? [], steps: loaded, posters, viewer: address, now }),
    [jobs.items, requests.data, loaded, posters, address, now],
  )
  const events = useMemo(() => feedEvents(loaded, feed, steps.hasNextPage), [loaded, feed, steps.hasNextPage])
  return { jobs, steps, feed, events, requestsError: requests.error, viewer: address, now }
}
