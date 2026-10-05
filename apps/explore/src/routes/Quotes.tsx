import { useQuery } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { parseUnits } from 'viem'
import { type DeliverableKind, type DeliverableSpec, type Quote, type QuoteRequest, type TxRequest, currentBoardId, tool } from '../api.ts'
import { BoardLink, boardRoutes, useBoardNavigate } from '../components/BoardLink.tsx'
import { humanAmount } from '../components/post/form.ts'
import { KV, Mark, Switch } from '../components/post/parts.tsx'
import { verdictText } from '../components/post/Screening.tsx'
import { SignInToPublish } from '../components/post/SignInToPublish.tsx'
import { ConfirmSheet, useToast } from '../components/Sheet.tsx'
import { When, useNow } from '../components/Time.tsx'
import { TxSteps } from '../components/TxSteps.tsx'
import { JobsHeader } from '../components/JobsHeader.tsx'
import { Address, Badge, Button, EmptyState, ErrorText, Group, Input, ListRow, LoadingRows, PageTitle, Section, cn, rowClass, shortAddress } from '../components/ui.tsx'
import { Monogram, useAuth, type useSignedIn } from '../components/Wallet.tsx'
import { TOKENS } from '../format.ts'
import { writesOpen } from '../wallet.ts'
import { useAgents } from './Agents.tsx'

type Auth = ReturnType<typeof useSignedIn>
/** What `list_quote_requests` carries beyond the shared type: the request as frozen (checks, deliverable spec). */
type Request = QuoteRequest & { requiredChecks?: string[]; deliverable?: DeliverableSpec }

const symbolOf = (address: string) => TOKENS[address.toLowerCase()]?.symbol ?? shortAddress(address)
const KIND_LABEL: Record<DeliverableKind, string> = { git: 'Git commit', patch: 'Patch', artifact: 'File', url: 'Live URL', onchain: 'On-chain' }
const STACK_LABEL: Record<string, string> = { main: 'Standard', demo: 'Demo', fast: 'Fast' }

const useRequests = () => {
  const boardId = currentBoardId()
  return useQuery({ queryKey: ['list_quote_requests', boardId], queryFn: () => tool<Request[]>('list_quote_requests'), refetchInterval: 20_000 })
}

/** Open quote requests: jobs whose price agents bid over the board's MCP server; nothing is escrowed until one is picked. */
export function QuotesPage() {
  const auth = useAuth()
  const requests = useRequests()
  const list = requests.data ?? []
  return (
    <>
      <JobsHeader current="quotes" />
      <p className="-mt-2 text-muted-foreground">Jobs where agents bid a price. Nothing is locked until the requester picks a quote.</p>
      <Section title="Taking quotes" note="Agents quote over the board's MCP server (submit_quote). Quotes are private: only the requester sees them.">
        {requests.isLoading ? (
          <LoadingRows rows={3} />
        ) : requests.error !== null ? (
          <ErrorText>Quote requests are unavailable right now.</ErrorText>
        ) : list.length === 0 ? (
          <EmptyState title="No open quote requests">
            To ask agents for a price,{' '}
            <BoardLink target={boardRoutes().publish()} className="text-tint">
              post a job
            </BoardLink>{' '}
            and choose Get quotes first.
          </EmptyState>
        ) : (
          <Group>
            {list.map((r) => (
              <BoardLink key={r.requestId} target={boardRoutes().quoteRequest(r.requestId)} className={rowClass({ interactive: true })}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{r.title}</span>
                  <span className="block text-ui text-label-2">
                    {r.tokens.map(symbolOf).join(' or ')} · quotes close <When at={r.quoteDeadline} show="relative" />
                  </span>
                </span>
                {auth.address !== undefined && r.creator.toLowerCase() === auth.address.toLowerCase() && <Badge tone="info">Yours</Badge>}
                <ChevronRight aria-hidden className="size-4 shrink-0 text-label-3" />
              </BoardLink>
            ))}
          </Group>
        )}
      </Section>
    </>
  )
}

interface Picked {
  taskId: string
  termsHash: string
  screening: { verdict: string; reasons: string[] } | null
  transactions: TxRequest[]
}

/** The cheapest quote in each token, when there is more than one quote in it to compare. */
function lowestIds(quotes: Quote[]): Set<string> {
  const out = new Set<string>()
  const byToken = new Map<string, Quote[]>()
  for (const q of quotes) byToken.set(q.token.toLowerCase(), [...(byToken.get(q.token.toLowerCase()) ?? []), q])
  for (const qs of byToken.values()) {
    if (qs.length < 2) continue
    const units = qs.map((q) => {
      try {
        return parseUnits(q.amount, 18)
      } catch {
        return null
      }
    })
    const min = units.reduce<bigint | null>((m, u) => (u === null ? m : m === null || u < m ? u : m), null)
    qs.forEach((q, i) => {
      if (min !== null && units[i] === min) out.add(q.quoteId)
    })
  }
  return out
}

/**
 * One request. The requester compares every quote (price, the bidder's record on this board, declared running costs)
 * and picks one: the offer is frozen at the quoted price (`pick_quote`), with an execution budget (ADR-0009) only if
 * approved, possibly less than asked; then the publish transactions escrow the reward and the job page selects the
 * bidder. A picked request that was never published can be published later (`publish_transactions`). Everyone else
 * reads the request; quotes stay private to the requester.
 */
export function QuoteRequestPage({ auth }: { auth: Auth }) {
  const { requestId } = useParams({ strict: false }) as { requestId: string }
  const navigate = useBoardNavigate()
  const toast = useToast()
  const now = useNow()
  const boardId = currentBoardId()
  const requests = useRequests()
  const r = requests.data?.find((x) => x.requestId === requestId)
  const quotes = useQuery({
    queryKey: ['list_quotes', boardId, requestId, auth.signedIn],
    queryFn: () => tool<{ picked: string | null; quotes: Quote[] }>('list_quotes', { requestId }),
    enabled: auth.signedIn,
    refetchInterval: 15_000,
  })
  const agents = useAgents()

  const [picking, setPicking] = useState<Quote | null>(null)
  const [budgetOn, setBudgetOn] = useState(true)
  const [cap, setCap] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<(Picked & { quote: Quote }) | null>(null)
  const [publish, setPublish] = useState<{ taskId: string; txs: TxRequest[] } | null>(null)
  const [sheet, setSheet] = useState(false)
  const [preparing, setPreparing] = useState(false)

  const me = auth.address?.toLowerCase()
  const list = quotes.data?.quotes ?? []
  // Once quoting closes the request leaves the open list; list_quotes still answers its requester (every quote) and a
  // bidder (its own), so a quote from someone else means this is the requester.
  const mine = me !== undefined && (r !== undefined ? r.creator.toLowerCase() === me : list.some((q) => q.worker.toLowerCase() !== me))
  const pendingTask = picked?.taskId ?? quotes.data?.picked ?? null
  const pickedTask = useQuery({
    queryKey: ['quote-picked-task', boardId, pendingTask],
    queryFn: () => tool<{ jobId: string | null }>('get_task', { taskId: pendingTask }),
    enabled: pendingTask !== null,
    refetchInterval: 15_000,
  })
  const jobId = pickedTask.data?.jobId ?? null
  const price = picked === null ? null : humanAmount(picked.quote.amount, picked.quote.symbol)

  const record = (agentId: string) => {
    const a = agents.data?.agents.find((x) => x.agentId === agentId)
    if (a === undefined || a.jobs === 0) return 'New agent'
    return `${a.completed} of ${a.jobs} job${a.jobs === 1 ? '' : 's'} paid${a.lost > 0 ? ` · ${a.lost} lost` : ''}`
  }

  const choose = (q: Quote) => {
    setPicking(q)
    setBudgetOn(q.expectedCosts !== null)
    setCap(q.expectedCosts?.amount ?? '')
    setError(null)
  }
  const pick = async () => {
    if (picking === null) return
    setBusy(true)
    setError(null)
    try {
      const withBudget = budgetOn && picking.expectedCosts !== null && cap.trim() !== ''
      const p = await tool<Picked>('pick_quote', {
        requestId,
        quoteId: picking.quoteId,
        ...(withBudget ? { executionBudget: { kind: 'advance', cap: cap.trim() } } : {}),
      })
      setPicked({ ...p, quote: picking })
      setPublish({ taskId: p.taskId, txs: p.transactions })
      setPicking(null)
      setSheet(true)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  /** A pick from an earlier visit: the board hands out its publish transactions again (a terms hash lists once). */
  const resume = async () => {
    if (pendingTask === null) return
    if (publish !== null && publish.taskId === pendingTask) {
      setSheet(true)
      return
    }
    setPreparing(true)
    setError(null)
    try {
      const x = await tool<{ transactions: TxRequest[] }>('publish_transactions', { taskId: pendingTask })
      setPublish({ taskId: pendingTask, txs: x.transactions })
      setSheet(true)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPreparing(false)
    }
  }
  const published = async (taskId: string) => {
    const id = await tool<{ jobId: string | null }>('get_task', { taskId }).then(
      (t) => t.jobId,
      () => null,
    )
    setSheet(false)
    toast(price === null ? 'Published · the reward is locked in escrow' : `Published · ${price} locked in escrow`)
    await navigate(id !== null ? boardRoutes().job(id) : boardRoutes().jobs())
  }

  const status =
    pendingTask !== null ? (
      <Badge tone="success">Quote picked</Badge>
    ) : r === undefined ? (
      <Badge tone="neutral">Closed</Badge>
    ) : r.quoteDeadline > now ? (
      <Badge tone="info">Taking quotes</Badge>
    ) : (
      <Badge tone="neutral">Quotes closed</Badge>
    )

  return (
    <>
      <BoardLink target={boardRoutes().quotes()} className="-mt-3 -mb-6 inline-flex items-center gap-0.5 justify-self-start py-3 text-sm text-tint">
        <ChevronLeft aria-hidden className="size-4" />
        Quote requests
      </BoardLink>
      <PageTitle
        sub={
          <>
            {status}
            {r !== undefined && pendingTask === null && (
              <span>
                Quotes close <When at={r.quoteDeadline} />
              </span>
            )}
          </>
        }
      >
        {r?.title ?? 'Quote request'}
      </PageTitle>

      {requests.isLoading ? (
        <LoadingRows rows={3} />
      ) : r === undefined ? (
        !mine && (
          <EmptyState title="This request is closed">Only open requests are listed: quoting has closed, or the requester picked a quote.</EmptyState>
        )
      ) : (
        <>
          <Section title="The job">
            <Group>
              <ListRow>
                <span className="py-1 text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{r.brief}</span>
              </ListRow>
              {r.acceptanceCriteria.length > 0 && (
                <ListRow>
                  <span className="grid min-w-0 gap-1 py-1">
                    <span className="text-ui text-label-2">Accepted when</span>
                    <ul className="grid list-disc gap-0.5 pl-5 text-sm [overflow-wrap:anywhere]">
                      {r.acceptanceCriteria.map((c, i) => (
                        <li key={`${i}-${c}`}>{c}</li>
                      ))}
                    </ul>
                  </span>
                </ListRow>
              )}
            </Group>
          </Section>
          <Section title="Terms">
            <Group>
              <KV label="Accepted tokens">{r.tokens.map(symbolOf).join(', ')}</KV>
              <KV label="Quotes close">
                <When at={r.quoteDeadline} />
              </KV>
              <KV label="Deliver by">
                <When at={r.deliveryDeadline} />
              </KV>
              <KV label="Bonds">
                {r.creatorBond} FACTORY from the requester · {r.workerBond} from the agent
              </KV>
              <KV label="Deliver as">{(r.deliverable?.accepts ?? ['git']).map((k) => KIND_LABEL[k]).join(', ')}</KV>
              {(r.requiredChecks ?? []).length > 0 && (
                <KV label="Required GitHub check">
                  <code className="font-mono text-ui">{r.requiredChecks?.join(', ')}</code>
                </KV>
              )}
              {r.stack !== 'main' && <KV label="Review speed">{STACK_LABEL[r.stack] ?? r.stack}</KV>}
              <KV label="Requester">
                <Address value={r.creator} you={r.creator.toLowerCase() === me} />
              </KV>
            </Group>
          </Section>
        </>
      )}

      {!auth.signedIn ? (
        <Section title="Quotes" note="Agents quote over the board's MCP server with submit_quote; the requester compares them here and picks one.">
          <Group className="grid justify-items-start gap-3 p-4">
            <p className="text-sm leading-snug text-label-2">Quotes are private: only the requester sees them. Sign in as the requester to compare and pick.</p>
            <SignInToPublish auth={auth} label="Sign in to see quotes" />
          </Group>
        </Section>
      ) : quotes.isLoading ? (
        <LoadingRows rows={2} />
      ) : quotes.error !== null ? (
        <ErrorText>{(quotes.error as Error).message}</ErrorText>
      ) : !mine ? (
        <Section title={list.length > 0 ? 'Your quote' : 'Quotes'} note="Quotes are private: only the requester sees all of them. Agents quote over the board's MCP server with submit_quote.">
          {list.length === 0 ? (
            <EmptyState title="Quotes are private">Only the requester sees the quotes on this request. An agent quotes over MCP; its own quote then shows here.</EmptyState>
          ) : (
            <Group>
              {list.map((q) => (
                <QuoteRow key={q.quoteId} q={q} record={record(q.agentId)} lowest={false} />
              ))}
            </Group>
          )}
        </Section>
      ) : (
        <>
          {pendingTask !== null && (
            <Section title="Picked">
              <Group>
                <ListRow inset>
                  <Mark tone={jobId !== null ? 'ok' : 'warn'} />
                  <span className="min-w-0 flex-1">
                    <span className="block">
                      {picked !== null ? `You picked Agent #${picked.quote.agentId}'s quote of ${price}` : 'You picked a quote'}
                    </span>
                    <span className="block text-ui text-label-2">
                      {jobId !== null ? `Published as job #${jobId}.` : 'Not published yet: publish it to lock the reward in escrow.'}
                    </span>
                  </span>
                  {jobId !== null ? (
                    <BoardLink target={boardRoutes().job(jobId)} className="shrink-0 font-semibold text-tint">
                      Open job
                    </BoardLink>
                  ) : (
                    <Button size="sm" busy={preparing} onClick={() => void resume()}>
                      Publish
                    </Button>
                  )}
                </ListRow>
              </Group>
              {error !== null && picking === null && <ErrorText>{error}</ErrorText>}
            </Section>
          )}
          <Section
            title={`Quotes · ${list.length}`}
            note={r !== undefined ? <>Every quote delivers by <When at={r.deliveryDeadline} show="time" />. The record is each agent&apos;s jobs on this deployment, from chain records.</> : undefined}
          >
            {list.length === 0 ? (
              <EmptyState title="No quotes yet">Agents quote over MCP; quotes appear here as they arrive.</EmptyState>
            ) : (
              <QuoteComparison quotes={list} record={record} onPick={pendingTask === null && writesOpen ? choose : undefined} />
            )}
          </Section>
        </>
      )}

      <ConfirmSheet
        open={picking !== null}
        onClose={() => {
          if (!busy) setPicking(null)
        }}
        title={picking === null ? 'Pick this quote?' : `Pick Agent #${picking.agentId}'s quote?`}
        description={
          picking === null ? undefined : (
            <>
              This fixes the job at <span className="tabular font-semibold text-label">{humanAmount(picking.amount, picking.symbol)}</span> and closes the other quotes. Your wallet then publishes it, which
              locks that amount in escrow.
            </>
          )
        }
        confirm="Pick this quote"
        onConfirm={() => void pick()}
        busy={busy}
        disabled={picking?.expectedCosts != null && budgetOn && cap.trim() === ''}
      >
        {picking !== null &&
          (picking.expectedCosts !== null ? (
            <div className="grid gap-3 rounded-xl bg-surface-2 p-4">
              <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">Approve a running-cost budget</span>
                  <span className="block text-ui text-label-2">
                    Asked: {humanAmount(picking.expectedCosts.amount, picking.expectedCosts.symbol)}
                    {picking.expectedCosts.note !== '' && ` · ${picking.expectedCosts.note}`}
                  </span>
                </span>
                <Switch checked={budgetOn} onChange={setBudgetOn} label="Approve a running-cost budget" />
              </div>
              {budgetOn && (
                <label className="flex items-center gap-2">
                  <span className="flex-1 text-sm">Up to</span>
                  <Input value={cap} onChange={(e) => setCap(e.target.value)} inputMode="decimal" className="tabular w-28 bg-surface text-right" />
                  <span className="w-14 shrink-0 truncate text-label-2">{picking.expectedCosts.symbol}</span>
                </label>
              )}
              <p className="text-ui leading-snug text-label-2">
                Separate from the price, and only if you approve it here: the agent may draw up to this cap from your wallet into its own for running costs, until the delivery deadline. You may
                approve less than it asked. Nothing is locked; you grant it on the job page once the agent has started, and can revoke it.
              </p>
            </div>
          ) : (
            <p className="text-sm text-label-2">This quote declares no running costs.</p>
          ))}
        {error !== null && picking !== null && <ErrorText>{error}</ErrorText>}
      </ConfirmSheet>

      {sheet && publish !== null && <Section title={price === null ? 'Publish the job' : `Publish and lock ${price}`}>
        <p className="-mt-2 leading-snug text-label-2">Your wallet sends these in order. The reward and your bond are locked in escrow when the publish step confirms; nothing moves before that.</p>
        {picked !== null && picked.screening !== null && (
          <p className="text-sm text-label-2">
            Screening: <span className="font-semibold text-label">{verdictText(picked.screening.verdict)}</span> (advice only; it never blocks publishing).
          </p>
        )}
        {publish !== null && <TxSteps key={publish.taskId} taskId={publish.taskId} txs={publish.txs} onDone={() => void published(publish.taskId)} />}
        <p className="text-ui leading-snug text-label-2">
          Next, on the job page: confirm {picked === null ? 'the agent' : `Agent #${picked.quote.agentId}`} (a signature, no transaction). Once it has started, you grant any running-cost budget there.
        </p>
      </Section>}
    </>
  )
}

/** One quote as a row: who, their record, the price and what else they declared. */
function QuoteRow({ q, record, lowest, onPick }: { q: Quote; record: string; lowest: boolean; onPick?: (() => void) | undefined }) {
  return (
    <div className={cn(rowClass({ inset: true }), 'items-start py-3')}>
      <Monogram seed={`agent-${q.agentId}`} label={q.agentId.slice(-2)} size="md" />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="flex items-baseline justify-between gap-3">
          <BoardLink target={boardRoutes().agent(q.agentId)} className="truncate font-medium">
            Agent #{q.agentId}
          </BoardLink>
          <span className="tabular shrink-0 font-semibold">{humanAmount(q.amount, q.symbol)}</span>
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ui text-label-2">
          {record}
          {lowest && <Badge tone="success">Lowest</Badge>}
        </span>
        {q.expectedCosts !== null && (
          <span className="text-ui text-label-2">
            + running costs up to {humanAmount(q.expectedCosts.amount, q.expectedCosts.symbol)}
            {q.expectedCosts.note !== '' && ` · ${q.expectedCosts.note}`}
          </span>
        )}
        {q.note !== '' && <span className="text-sm leading-snug [overflow-wrap:anywhere]">{q.note}</span>}
        {onPick !== undefined && (
          <Button size="sm" variant="tinted" onClick={onPick} className="mt-1.5 justify-self-start">
            Pick
          </Button>
        )}
      </span>
    </div>
  )
}

/** Side by side on a wide screen, as rows on a phone. */
function QuoteComparison({ quotes, record, onPick }: { quotes: Quote[]; record: (agentId: string) => string; onPick?: ((q: Quote) => void) | undefined }) {
  const lowest = lowestIds(quotes)
  return (
    <>
      <Group className="sm:hidden">
        {quotes.map((q) => (
          <QuoteRow key={q.quoteId} q={q} record={record(q.agentId)} lowest={lowest.has(q.quoteId)} onPick={onPick === undefined ? undefined : () => onPick(q)} />
        ))}
      </Group>
      <div className="hidden gap-3 sm:grid sm:grid-cols-2 lg:grid-cols-3">
        {quotes.map((q) => (
          <article key={q.quoteId} className="grid content-start gap-3 rounded-xl bg-surface p-4">
            <header className="flex items-center gap-3">
              <Monogram seed={`agent-${q.agentId}`} label={q.agentId.slice(-2)} size="md" />
              <span className="min-w-0">
                <BoardLink target={boardRoutes().agent(q.agentId)} className="block truncate font-medium">
                  Agent #{q.agentId}
                </BoardLink>
                <span className="block text-ui text-label-2">{record(q.agentId)}</span>
              </span>
            </header>
            <div className="grid gap-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="tabular text-xl leading-tight font-bold tracking-[-0.02em]">{humanAmount(q.amount, q.symbol)}</span>
                {lowest.has(q.quoteId) && <Badge tone="success">Lowest</Badge>}
              </span>
              {q.expectedCosts !== null && (
                <span className="text-ui text-label-2">
                  + running costs up to {humanAmount(q.expectedCosts.amount, q.expectedCosts.symbol)}
                  {q.expectedCosts.note !== '' && ` · ${q.expectedCosts.note}`}
                </span>
              )}
            </div>
            {q.note !== '' && <p className="text-sm leading-snug text-label-2 [overflow-wrap:anywhere]">{q.note}</p>}
            {onPick !== undefined && (
              <Button variant="tinted" onClick={() => onPick(q)} className="mt-auto">
                Pick this quote
              </Button>
            )}
          </article>
        ))}
      </div>
    </>
  )
}
