/**
 * What happened on the board, as Activity shows it: job steps from the indexed chain events (`/data/activity`, public
 * on chain) and new quote requests from the board's request list (`activity-feed.ts` joins them). Quotes themselves
 * never appear: who bids, and for how much, stays with the requester.
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
      return named ? { agent: true, text: `posted ${t}` } : { agent: false, text: `New job: ${t}` }
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
