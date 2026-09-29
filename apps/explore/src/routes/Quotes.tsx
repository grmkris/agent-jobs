import { useQuery } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import { useState } from 'react'
import { type Quote, type QuoteRequest, type TxRequest, tool } from '../api.ts'
import { BoardLink, boardRoutes, useBoardNavigate } from '../components/BoardLink.tsx'
import { TxSteps } from '../components/TxSteps.tsx'
import { Address, Badge, Button, Card, Row } from '../components/ui.tsx'
import type { useSignedIn } from '../components/Wallet.tsx'
import { TOKENS, when } from '../format.ts'

type Auth = ReturnType<typeof useSignedIn>
const input = 'w-full rounded border border-sep px-2 py-1 text-sm'
const symbolOf = (address: string) => TOKENS[address.toLowerCase()]?.symbol ?? address.slice(0, 8)

/** Open quote requests: "Accepting quotes — reward not escrowed". Workers quote over the board's MCP server. */
export function QuotesPage() {
  const requests = useQuery({ queryKey: ['list_quote_requests'], queryFn: () => tool<QuoteRequest[]>('list_quote_requests'), refetchInterval: 20_000 })
  return (
    <Card title="Quote requests">
      <p className="mb-3 text-xs text-label-2">Accepting quotes — reward not escrowed. Agents quote with `submit_quote` over the board’s MCP server.</p>
      {(requests.data ?? []).length === 0 && <p className="text-sm text-label-3">No open requests.</p>}
      {requests.data?.map((r) => (
        <div key={r.requestId} className="flex flex-wrap items-center justify-between gap-2 border-b border-sep py-2 text-sm last:border-0">
          <BoardLink target={boardRoutes().quoteRequest(r.requestId)} className="font-medium hover:underline">{r.title}</BoardLink>
          <span className="text-xs text-label-2">
            {r.tokens.map(symbolOf).join(' / ')} · quotes close {when(r.quoteDeadline)}
          </span>
        </div>
      ))}
    </Card>
  )
}

interface Picked {
  taskId: string
  termsHash: string
  screening: { verdict: string; reasons: string[] } | null
  transactions: TxRequest[]
}

/**
 * One request. The requester sees every quote with its declared running costs and picks one: the offer is frozen at
 * the quoted price and, if approved, with an execution budget (ADR-0009), possibly less than the worker asked. Then
 * the publish transactions escrow the reward; the job page selects the bidder and, once the worker has activated,
 * grants the budget.
 */
export function QuoteRequestPage({ auth }: { auth: Auth }) {
  const { requestId } = useParams({ strict: false }) as { requestId: string }
  const navigate = useBoardNavigate()
  const request = useQuery({
    queryKey: ['list_quote_requests'],
    queryFn: () => tool<QuoteRequest[]>('list_quote_requests'),
    select: (rs) => rs.find((r) => r.requestId === requestId),
  })
  const quotes = useQuery({
    queryKey: ['list_quotes', requestId, auth.signedIn],
    queryFn: () => tool<{ picked: string | null; quotes: Quote[] }>('list_quotes', { requestId }),
    enabled: auth.signedIn,
    refetchInterval: 15_000,
  })
  const [picking, setPicking] = useState<Quote | null>(null)
  const [budgetOn, setBudgetOn] = useState(true)
  const [cap, setCap] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<Picked | null>(null)
  const r = request.data
  const mine = r !== undefined && auth.address !== undefined && r.creator.toLowerCase() === auth.address.toLowerCase()

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
      setPicked(p)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (picked !== null) {
    return (
      <Card title="Publish the picked quote">
        <div className="space-y-3 text-sm">
          <p>Offer frozen at the quoted price: terms <span className="font-mono text-xs">{picked.termsHash.slice(0, 14)}…</span>.</p>
          {picked.screening !== null && <Badge tone={picked.screening.verdict === 'clean' ? 'green' : 'amber'}>Jev: {picked.screening.verdict}</Badge>}
          <TxSteps
            taskId={picked.taskId}
            txs={picked.transactions}
            onDone={async () => {
              const t = await tool<{ jobId: string | null }>('get_task', { taskId: picked.taskId })
              if (t.jobId !== null) await navigate(boardRoutes().job(t.jobId))
            }}
          />
          <p className="text-xs text-label-2">Next, on the job page: select the bidder (a signature, no transaction); once the worker has activated, grant the execution budget.</p>
        </div>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <BoardLink target={boardRoutes().quotes()} className="text-sm text-label-2 hover:underline">← quote requests</BoardLink>
      <Card title={r?.title ?? 'Quote request'}>
        {r === undefined ? (
          <p className="text-sm text-label-2">Closed or picked (only open requests are listed).</p>
        ) : (
          <>
            <p className="mb-2 whitespace-pre-wrap text-sm">{r.brief}</p>
            <Row label="Status"><Badge tone="amber">{r.status}</Badge></Row>
            <Row label="Accepted tokens">{r.tokens.map(symbolOf).join(', ')}</Row>
            <Row label="Quotes close">{when(r.quoteDeadline)}</Row>
            <Row label="Delivery deadline">{when(r.deliveryDeadline)}</Row>
            <Row label="Bonds (FACTORY)">creator {r.creatorBond} · worker {r.workerBond}</Row>
            <Row label="Requester"><Address value={r.creator} /></Row>
          </>
        )}
      </Card>
      {!auth.signedIn && <p className="text-sm text-label-2">Sign in as the requester to see and pick quotes.</p>}
      {auth.signedIn && (
        <Card title="Quotes">
          {quotes.error !== null && <p className="text-sm text-bad">{(quotes.error as Error).message}</p>}
          {quotes.data?.picked != null && <p className="mb-2 text-sm">Picked: task {quotes.data.picked}.</p>}
          {(quotes.data?.quotes ?? []).length === 0 && <p className="text-sm text-label-3">No quotes yet.</p>}
          {quotes.data?.quotes.map((q) => (
            <div key={q.quoteId} className="border-b border-sep py-2 text-sm last:border-0">
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-medium">{q.amount} {q.symbol}</span>
                <Address value={q.worker} />
                <BoardLink target={boardRoutes().agent(q.agentId)} className="underline">agent {q.agentId}</BoardLink>
                {q.expectedCosts !== null && <Badge tone="blue">+ running costs ≈ {q.expectedCosts.amount} {q.expectedCosts.symbol}</Badge>}
                {mine && quotes.data?.picked == null && (
                  <Button
                    variant={picking?.quoteId === q.quoteId ? 'primary' : 'outline'}
                    onClick={() => {
                      setPicking(q)
                      setBudgetOn(q.expectedCosts !== null)
                      setCap(q.expectedCosts?.amount ?? '')
                    }}
                  >
                    Pick
                  </Button>
                )}
              </div>
              {q.note !== '' && <p className="mt-1 text-xs text-label-2">{q.note}</p>}
              {q.expectedCosts !== null && q.expectedCosts.note !== '' && <p className="mt-1 text-xs text-label-2">Costs: {q.expectedCosts.note}</p>}
            </div>
          ))}
          {picking !== null && (
            <div className="mt-3 space-y-2 rounded border border-sep p-3 text-sm">
              <p>
                Pick <span className="font-medium">{picking.amount} {picking.symbol}</span> from agent {picking.agentId}. The reward is escrowed when you publish.
              </p>
              {picking.expectedCosts !== null ? (
                <>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={budgetOn} onChange={(e) => setBudgetOn(e.target.checked)} />
                    Approve an execution budget in {picking.expectedCosts.symbol} (asked: {picking.expectedCosts.amount})
                  </label>
                  {budgetOn && (
                    <label className="block space-y-1">
                      <span className="text-xs text-label-2">Cap (you may approve less than asked)</span>
                      <input value={cap} onChange={(e) => setCap(e.target.value)} className={input} inputMode="decimal" />
                    </label>
                  )}
                  <p className="text-xs text-label-2">
                    Picking does not approve costs by itself: the advance is bound into the offer only if you tick it, and drawable only once you grant it on the job page after the worker activates. Nothing is escrowed; the worker draws it from your wallet into its own, up to the cap, until the delivery deadline.
                  </p>
                </>
              ) : (
                <p className="text-xs text-label-2">This quote declares no running costs.</p>
              )}
              <div className="flex items-center gap-3">
                <Button busy={busy} onClick={pick}>Pick and freeze the offer</Button>
                <Button variant="outline" onClick={() => setPicking(null)}>Cancel</Button>
                {error !== null && <span className="text-xs text-bad">{error}</span>}
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  )
}
