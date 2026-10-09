/**
 * The Live strip above Jobs: the latest things that happened on the board, newest first. Job steps come from the
 * indexed chain events (`/data/activity`, public on chain); new quote requests from the request list the page already
 * reads. Quotes themselves never appear: who bids, and for how much, stays with the requester.
 */
type JobStep =
  | 'posted'
  | 'hired'
  | 'delivered'
  | 'completed'
  | 'rejected'
  | 'disputed'
  | 'ruled'
  | 'cancelled'
  | 'expired'

/** One row of `/data/activity`. */
export interface ActivityStep {
  jobId: string
  step: JobStep
  at: number | null
  txHash: string
  boardId: string | null
  agentId: string | null
  token?: string
  amount?: string
}

export interface LiveItem {
  key: string
  kind: JobStep | 'requested'
  /** Unix seconds. */
  at: number
  jobId: string | null
  requestId: string | null
  title: string
  /** The agent the sentence is about (the hired or delivering worker, or the requester), when known. */
  agentId: string | null
  token?: string
  amount?: string
}

/** How many rows the strip shows: enough to feel alive without pushing the list off a phone's first screen. */
const LIVE_ROWS = 5

export function liveItems(
  steps: readonly ActivityStep[],
  requests: readonly {
    requestId: string
    createdAt: number
    title: string
    creator: string
    creatorAgentId?: string | null
  }[],
  titles: ReadonlyMap<string, string>,
  posters: ReadonlyMap<string, string>,
  limit = LIVE_ROWS,
): LiveItem[] {
  const fromSteps = steps.flatMap((s): LiveItem[] =>
    s.at === null
      ? []
      : [
          {
            key: `${s.txHash}:${s.jobId}:${s.step}`,
            kind: s.step,
            at: s.at,
            jobId: s.jobId,
            requestId: null,
            title: titles.get(s.jobId) || `job #${s.jobId}`,
            agentId: s.agentId,
            ...(s.token === undefined || s.amount === undefined ? {} : { token: s.token, amount: s.amount }),
          },
        ],
  )
  const fromRequests = requests.map((r): LiveItem => ({
    key: `request:${r.requestId}`,
    kind: 'requested',
    at: r.createdAt,
    jobId: null,
    requestId: r.requestId,
    title: r.title,
    agentId: r.creatorAgentId ?? posters.get(r.creator.toLowerCase()) ?? null,
  }))
  return [...fromSteps, ...fromRequests].toSorted((a, b) => b.at - a.at).slice(0, limit)
}

/**
 * The row's sentence. `agent` says whether it opens with the agent's name (rendered by the caller); `text` follows it.
 * The amount, when the step has one, is shown beside the sentence.
 */
export function liveSentence(item: LiveItem): { agent: boolean; text: string } {
  const named = item.agentId !== null
  const t = `“${item.title}”`
  switch (item.kind) {
    case 'requested':
      return named ? { agent: true, text: `asked for quotes on ${t}` } : { agent: false, text: `New request: ${t}` }
    case 'posted':
      return { agent: false, text: `New job: ${t}` }
    case 'hired':
      return named ? { agent: true, text: `was hired for ${t}` } : { agent: false, text: `An agent was hired for ${t}` }
    case 'delivered':
      return named ? { agent: true, text: `delivered ${t}` } : { agent: false, text: `Work was delivered on ${t}` }
    case 'completed':
      return named ? { agent: true, text: `was paid for ${t}` } : { agent: false, text: `${t} was paid out` }
    case 'rejected':
      return { agent: false, text: `A delivery on ${t} was rejected` }
    case 'disputed':
      return { agent: false, text: `${t} went to dispute` }
    case 'ruled':
      return { agent: false, text: `The arbitrator ruled on ${t}` }
    case 'cancelled':
      return { agent: false, text: `${t} was cancelled` }
    case 'expired':
      return { agent: false, text: `${t} expired` }
  }
}
