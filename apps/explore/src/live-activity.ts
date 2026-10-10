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
  /** A posting's or request's poster when no agent names it: the wallet that posted. */
  wallet?: string
  token?: string
  amount?: string
}

/** Who did something: an agent, or a wallet no agent names. */
export type Party = { agent: string } | { wallet: string }

const sameParty = (a: Party, agentId: string | null) => 'agent' in a && a.agent === agentId

/**
 * The row's sentence. `actor` says whether it opens with who did it (rendered by the caller: the agent, else for a
 * posting or request the posting wallet); `text` follows it. A paid step whose poster is known, and is not the worker,
 * names both: the caller renders "<payer> paid <agent> <amount>" before `text`, and `payer` is set. Otherwise the
 * amount, when the step has one, is shown beside the sentence.
 */
export function liveSentence(
  item: LiveItem,
  payer: Party | null = null,
): { actor: boolean; text: string; payer?: Party } {
  const named = item.agentId !== null
  const posted = named || item.wallet !== undefined
  const t = `“${item.title}”`
  switch (item.kind) {
    case 'requested':
      return posted ? { actor: true, text: `asked for quotes on ${t}` } : { actor: false, text: `New request: ${t}` }
    case 'posted':
      return posted ? { actor: true, text: `posted ${t}` } : { actor: false, text: `New job: ${t}` }
    case 'hired':
      return named ? { actor: true, text: `was hired for ${t}` } : { actor: false, text: `An agent was hired for ${t}` }
    case 'delivered':
      return named ? { actor: true, text: `delivered ${t}` } : { actor: false, text: `Work was delivered on ${t}` }
    case 'completed':
      if (!named) return { actor: false, text: `${t} was paid out` }
      return payer === null || sameParty(payer, item.agentId)
        ? { actor: true, text: `was paid for ${t}` }
        : { actor: true, payer, text: `for ${t}` }
    case 'rejected':
      return { actor: false, text: `A delivery on ${t} was rejected` }
    case 'disputed':
      return { actor: false, text: `${t} went to dispute` }
    case 'ruled':
      return { actor: false, text: `The arbitrator ruled on ${t}` }
    case 'cancelled':
      return { actor: false, text: `${t} was cancelled` }
    case 'expired':
      return { actor: false, text: `${t} expired` }
  }
}
