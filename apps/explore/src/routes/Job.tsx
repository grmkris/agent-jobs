import { type Phase, lifecycle, lifecycleFromIndexed, lifecycleFromTask } from '@agent-jobs/react'
import { useQuery } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import { ChevronLeft, ChevronRight, CircleAlert, Clock, Lock, ReceiptText } from 'lucide-react'
import type { ReactNode } from 'react'
import { DELIVERABLE_KINDS, type Deliverable, type DeliverableCheck, type TaskIndexEntry, boardApi, currentBoardId, data } from '../api.ts'
import { BoardLink, boardRoutes } from '../components/BoardLink.tsx'
import { BudgetPanel } from '../components/BudgetPanel.tsx'
import { Delivered, type EvidenceRow } from '../components/job/Deliverables.tsx'
import { type JobEvent, JobActions } from '../components/job/JobActions.tsx'
import { type TimelineEvent, Timeline } from '../components/job/Timeline.tsx'
import { PhaseBadge, Sentence } from '../components/Phase.tsx'
import { useNow } from '../components/Time.tsx'
import { Address, Badge, Button, Group, ListRow, Row, Section, Skeleton, TxLink, cn, rowClass } from '../components/ui.tsx'
import { Monogram, type useSignedIn } from '../components/Wallet.tsx'
import { amount, bond, budgetCap, span, tokenInfo } from '../format.ts'
import { useToken } from '../useTokens.ts'
import { useJobs } from './Jobs.tsx'

export type { JobEvent }

interface Detail {
  job: {
    status: string
    mode: string | null
    stack: string | null
    worker: string | null
    agent_id: string | null
    deliverable: string | null
    violation: string | null
    rejection_reason_hash: string | null
    creator: string | null
    approver: string | null
    token: string | null
    reward: string | null
    creator_bond: string | null
    worker_bond: string | null
    delivery_deadline: number | null
    selection_deadline: number | null
    published_tx: string | null
  }
  submission: { deliverable: string; provider: string; tx_hash: string } | null
  evidence: EvidenceRow[]
  ruling: { for_worker: number; slash_loser: number; reason_hash: string; tx_hash: string } | null
  rewards: Array<{ kind: string; recipient: string; amount: string; tx_hash: string }>
  bonds: Array<{ side: string; outcome: string; recipient: string | null; amount: string; tx_hash: string }>
  feedback: { agent_id: string; value: string | null; tag: string | null; recorded: number; tx_hash: string } | null
  timeline?: TimelineEvent[]
  board: { boardId: string; taskId: string } | null
}

/** The board's `get_task` answer, as far as this page reads it. */
interface BoardTask {
  taskId: string
  title: string
  mode: 'hire' | 'contest'
  stack: string
  creator: string
  approver: string
  deliveryDeadline: number
  selectionDeadline: number | null
  workerBond: string
  termsHash: string
  screening: { verdict: string; reasons: string[] }
  chain: {
    status: string
    provider: string | null
    timely: boolean
    submittedAt: number | null
    reviewEndsAt: number | null
    disputeEndsAt: number | null
    arbitrationEndsAt: number | null
    violation: string | null
    listingMatchesOffer: boolean | null
    paused?: boolean
  }
  you: string[] | null
  terms: { brief?: string; acceptanceCriteria?: string[]; windows?: { reviewSeconds: number; disputeSeconds: number; arbitrationSeconds: number } }
  deliverables?: Array<{ repo: string; branch: string; sha: string; deliverable_hash: string; descriptor?: Deliverable; check?: DeliverableCheck | null }>
  evidence?: Array<{ submissionHash: string; label: string }>
}

type Auth = ReturnType<typeof useSignedIn>

const STACK: Record<string, string> = { main: 'Standard: 3-day review and dispute windows', demo: 'Demo: windows of minutes, for rehearsals', fast: 'Fast: 2-hour review and dispute windows' }
const VERDICT: Record<string, string> = { clean: 'Looks fine', caution: 'Flagged for a closer look', reject: 'Flagged as risky', unscreened: 'Not screened' }
const VIOLATION: Record<string, string> = { None: 'no fault named', Quality: 'not good enough', Falsified: 'faked evidence' }

/** How a finished job ended, read from its events, so the phase can say "accepted by silence" or "ruled for…". */
function outcomeOf(d: Detail | undefined) {
  const tl = d?.timeline ?? []
  const timeout = tl.find((e) => e.name === 'TimedOut')
  if (d?.ruling != null) return d.ruling.for_worker === 1 ? ('ruled-worker' as const) : ('ruled-creator' as const)
  if (timeout !== undefined) {
    const r = String(timeout.args.reason)
    if (r.startsWith('0x7265766965772d')) return 'silence' as const // "review-…"
    if (r.startsWith('0x64656c6976657279')) return 'missed' as const // "delivery…"
    if (r.startsWith('0x6172626974726174696f6e')) return 'arbitration-timeout' as const // "arbitration…"
    return 'rejection-final' as const
  }
  if (tl.some((e) => e.name === 'Awarded')) return 'awarded' as const
  if (tl.some((e) => e.name === 'Accepted')) return 'accepted' as const
  return null
}

export function JobPage({ auth, jobId: given, onEvent }: { auth: Auth; jobId?: string; onEvent?: (type: JobEvent, payload: Record<string, unknown>) => void }) {
  const params = useParams({ strict: false }) as { jobId?: string }
  const jobId = given ?? params.jobId ?? ''
  const now = useNow()
  const { items } = useJobs()
  const listed = items.find((i) => i.jobId === jobId)?.task
  const chain = useQuery({ queryKey: ['job', jobId], queryFn: () => data<Detail>(`jobs/${jobId}`), refetchInterval: 15_000, enabled: /^\d+$/.test(jobId) })
  const d = chain.data
  // The offer lives on the board it was frozen on, which may not be the one this page is on.
  const boardId = d?.board?.boardId ?? currentBoardId()
  const taskId = d?.board?.taskId ?? listed?.taskId
  const board = useQuery({
    queryKey: ['get_task', boardId, taskId, auth.signedIn],
    queryFn: () => boardApi(boardId).tool<BoardTask>('get_task', { taskId }),
    enabled: taskId !== undefined,
    refetchInterval: 15_000,
  })
  const t = board.data
  const mode: 'hire' | 'contest' = (t?.mode ?? d?.job.mode ?? listed?.mode) === 'contest' ? 'contest' : 'hire'
  const roles = t?.you ?? []

  // Minute resolution is enough for phases (deadlines are minutes apart); the countdowns tick on their own.
  const minute = Math.floor(now / 60) * 60
  let phase: Phase | null = null
  if (t !== undefined && !board.isError) phase = lifecycle({ ...lifecycleFromTask(t), outcome: outcomeOf(d) }, auth.address ?? null, minute)
  else if (d !== undefined) {
    const settlePending = ['rejected', 'cancelled', 'expired'].includes(d.job.status) && d.rewards.length === 0
    phase = lifecycle({ ...lifecycleFromIndexed(d.job), outcome: outcomeOf(d), settlePending }, auth.address ?? null, minute)
  }

  const title = listed?.title ?? t?.title ?? (/^\d+$/.test(jobId) ? `Job #${jobId}` : 'Job')
  const brief = listed?.brief ?? t?.terms.brief
  const criteria = listed?.acceptanceCriteria ?? t?.terms.acceptanceCriteria ?? []
  const reward = d?.job.reward ?? listed?.reward ?? null
  const token = d?.job.token ?? listed?.token ?? null
  // A token nobody listed (ADR-0010) is read from the chain once, so every amount on the page has its decimals.
  useToken(token)
  const agentId = d?.job.agent_id ?? null
  const otherBoard = d?.board != null && d.board.boardId !== currentBoardId() && d.board.boardId !== 'public'

  if (chain.isLoading && listed === undefined) return <JobSkeleton />
  if (chain.data === undefined && listed === undefined && !chain.isLoading) {
    return (
      <>
        <Back />
        <div className="grid gap-2 rounded-2xl bg-surface p-6 text-center">
          <p className="font-semibold">{chain.isError ? 'Chain job details are unavailable' : `Job #${jobId} is not indexed yet`}</p>
          <p className="text-[0.9rem] text-label-2">{chain.isError ? 'The chain index could not be read. This does not mean the job is still in progress or unpaid.' : 'A newly published job appears about a minute after its block is final.'}</p>
          <Button variant="tinted" onClick={() => void chain.refetch()}>Retry job details</Button>
        </div>
      </>
    )
  }

  return (
    <>
      <Back />
      {chain.isError && (
        <div role="status" className="grid gap-2 rounded-xl bg-warn-bg p-4 text-[0.9rem] text-warn">
          <p>Chain job details are unavailable.{d === undefined ? ' Payment history cannot be confirmed from the index.' : ` Showing last-known indexed facts from ${new Date(chain.dataUpdatedAt).toLocaleString()}.`}</p>
          <Button variant="tinted" onClick={() => void chain.refetch()}>Retry job details</Button>
        </div>
      )}
      {board.isError && <div role="status" className="grid gap-2 rounded-xl bg-warn-bg p-4 text-[0.9rem] text-warn"><p>Board details are unavailable. {d !== undefined ? 'Showing indexed chain facts instead; actions are paused until the offer refreshes.' : 'Offer terms and actions cannot be confirmed.'}</p><Button variant="tinted" onClick={() => void board.refetch()}>Retry offer details</Button></div>}
      <header className="grid min-w-0 gap-2">
        <h1 className="font-display text-[1.75rem] leading-[1.15] font-bold tracking-[-0.02em] [overflow-wrap:anywhere]">{title}</h1>
        <div className="flex flex-wrap items-center gap-2 text-[0.88rem] text-label-2">
          <PhaseBadge phase={phase} />
          {title !== `Job #${jobId}` && <span>Job #{jobId}</span>}
          <span>· {mode === 'contest' ? 'Contest' : listed?.quoted === true ? 'Hire from quotes' : 'Hire'}</span>
          {otherBoard && <Badge tone="info">{d?.board?.boardId}</Badge>}
          {roles.map((r) => (
            <Badge key={r} tone="info">
              You: {r}
            </Badge>
          ))}
        </div>
      </header>

      {reward !== null && <Money phase={phase} reward={reward} token={token} mode={mode} agentId={agentId} />}

      {phase !== null && <NextStep phase={phase} />}

      {phase !== null && t !== undefined && taskId !== undefined && (
        <JobActions
          job={{
            taskId,
            boardId,
            mode,
            reward,
            token,
            creatorBond: d?.job.creator_bond ?? listed?.creatorBond ?? null,
            workerBond: d?.job.worker_bond ?? listed?.workerBond ?? null,
            agentId,
            disputeSeconds: t.terms.windows?.disputeSeconds ?? null,
          }}
          phase={phase}
          roles={roles}
          signedIn={auth.signedIn}
          sourceAvailable={!board.isError && !chain.isError}
          onEvent={onEvent}
        />
      )}

      {d !== undefined && (d.timeline?.length ?? 0) > 0 && (
        <Section title="Progress">
          <Timeline
            events={d.timeline ?? []}
            phase={phase}
            job={{ token, reward, workerBond: d.job.worker_bond, agentId, deliveryDeadline: d.job.delivery_deadline, creator: d.job.creator }}
          />
        </Section>
      )}

      <Delivered
        deliverables={(t?.deliverables ?? []).map((x) => ({ deliverable_hash: x.deliverable_hash, descriptor: x.descriptor ?? { kind: 'git', url: x.repo, ref: x.branch, sha: x.sha }, check: x.check ?? null }))}
        evidence={d?.evidence ?? []}
      />

      {listed !== undefined && listed.executionBudget !== null && boardId === currentBoardId() && (
        <BudgetPanel task={listed} status={t?.chain.status ?? d?.job.status ?? 'unknown'} roles={roles} signedIn={auth.signedIn} address={auth.address} />
      )}

      {d !== undefined && (d.job.violation !== null || d.ruling !== null) && <Dispute d={d} boardId={boardId} taskId={taskId} signedIn={auth.signedIn} isParty={roles.length > 0} />}

      {brief !== undefined && (
        <Section title="The job">
          <div className="grid min-w-0 gap-3 rounded-xl bg-surface px-4 py-3.5 leading-relaxed">
            <p className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{brief}</p>
            {criteria.length > 0 && (
              <div>
                <p className="text-[0.85rem] text-label-2">Accepted when</p>
                <ul className="mt-1 list-disc pl-5">
                  {criteria.map((c) => (
                    <li key={c} className="[overflow-wrap:anywhere]">{c}</li>
                  ))}
                </ul>
              </div>
            )}
            {mode === 'contest' && <p className="text-[0.85rem] text-warn">Only the winning entry is paid, and the contest may close early when it is awarded.</p>}
          </div>
        </Section>
      )}

      <People d={d} listed={listed} agentId={agentId} viewer={auth.address} />

      <Details d={d} listed={listed} t={t} />
    </>
  )
}

function Back() {
  return (
    <BoardLink target={boardRoutes().jobs()} className="-mb-2 inline-flex w-fit items-center gap-0.5 text-tint">
      <ChevronLeft aria-hidden className="-ml-1.5 size-5" strokeWidth={2.4} />
      Jobs
    </BoardLink>
  )
}

function JobSkeleton() {
  return (
    <>
      <Back />
      <div className="grid gap-3">
        <Skeleton className="h-8 w-4/5" />
        <Skeleton className="h-4 w-2/5" />
      </div>
      <Skeleton className="h-20 w-full rounded-2xl" />
      <Skeleton className="h-40 w-full rounded-xl" />
    </>
  )
}

/** Where the reward is: locked in escrow, paid, or back with the creator. */
function Money({ phase, reward, token, mode, agentId }: { phase: Phase | null; reward: string; token: string | null; mode: 'hire' | 'contest'; agentId: string | null }) {
  const terminal = phase?.terminal === true
  const draft = phase?.key === 'draft' || phase?.key === 'draft-stale'
  const paid = phase?.key === 'completed'
  const where = draft
    ? 'Not locked yet: publishing locks it in escrow'
    : paid
      ? `Paid to ${agentId !== null ? `Agent #${agentId}` : 'the agent'}`
      : terminal
        ? 'Back with the creator'
        : phase === null ? 'Chain payment status unavailable' : `Locked in escrow · paid ${mode === 'contest' ? 'to the winning entry' : `to ${agentId !== null ? `Agent #${agentId}` : 'the agent'} when the work is accepted`}`
  return (
    <div className="flex items-center gap-3.5 rounded-2xl bg-surface p-4">
      <span className={cn('grid size-10 shrink-0 place-items-center rounded-xl', !terminal && !draft ? 'bg-tint/14 text-tint' : paid ? 'bg-ok-bg text-ok' : 'bg-fill text-label-2')}>
        {!terminal && !draft ? <Lock aria-hidden className="size-5" /> : <ReceiptText aria-hidden className="size-5" />}
      </span>
      <span className="min-w-0">
        <span className="tabular block font-display text-[1.75rem] leading-none font-bold tracking-[-0.02em] [overflow-wrap:anywhere]">{amount(reward, token)}</span>
        <span className="mt-1 block text-[0.88rem] text-label-2">{where}</span>
        {token !== null && tokenInfo(token).unverified === true && (
          <span className="mt-1 block text-[0.8rem] text-label-3 [overflow-wrap:anywhere]">Unverified token {token}: anyone can deploy a token under any name</span>
        )}
      </span>
    </div>
  )
}

/** What happens next and who acts: addressed to the viewer when it is theirs to do. */
function NextStep({ phase }: { phase: Phase }) {
  if (phase.terminal && phase.actions.length === 0) {
    return <p className="px-1 text-[0.95rem] leading-relaxed text-label-2"><Sentence parts={phase.next} /></p>
  }
  const you = phase.youAct && phase.toYou !== null
  return (
    <div className="grid gap-2">
      <div className={cn('flex gap-3 rounded-2xl px-4 py-3.5 leading-relaxed', you ? 'bg-warn-bg' : 'bg-tint/10')}>
        {you ? <CircleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-warn" /> : <Clock aria-hidden className="mt-0.5 size-5 shrink-0 text-tint" />}
        <p>
          {you && <span className="font-semibold">You: </span>}
          <Sentence parts={you ? (phase.toYou ?? phase.next) : phase.next} />
        </p>
      </div>
      {phase.warnings.map((w) => (
        <p key={w} role="alert" className="rounded-xl bg-bad-bg px-4 py-2.5 text-[0.9rem] text-bad">
          {w}
        </p>
      ))}
    </div>
  )
}

function Dispute({ d, boardId, taskId, signedIn, isParty }: { d: Detail; boardId: string; taskId: string | undefined; signedIn: boolean; isParty: boolean }) {
  const bundle = useQuery({
    queryKey: ['bundle', boardId, taskId],
    queryFn: () => boardApi(boardId).tool<{ bundle: { rejection: { reasonText: string | null }; statements: Array<{ role: string; text: string }> } }>('get_dispute_bundle', { taskId }),
    enabled: signedIn && isParty && taskId !== undefined && d.job.violation !== null,
    retry: false,
  })
  const reason = bundle.data?.bundle.rejection.reasonText
  return (
    <Section title="Rejection and dispute" note={reason === undefined || reason === null ? 'The written reason is shown to the creator, the approver and the agent; everyone else sees its fingerprint on-chain.' : undefined}>
      <Group className="px-4 py-2">
        {d.job.violation !== null && <Row label="Rejected as">{VIOLATION[d.job.violation] ?? d.job.violation}</Row>}
        <Row label="Reason">{reason ?? <span className="font-mono text-[0.8rem]">{d.job.rejection_reason_hash?.slice(0, 14) ?? '—'}…</span>}</Row>
        {bundle.data?.bundle.statements.map((s, i) => (
          <Row key={i} label={`${s.role[0]?.toUpperCase()}${s.role.slice(1)}'s statement`}>
            {s.text}
          </Row>
        ))}
        {d.ruling !== null && (
          <Row label="Ruling">
            <span className="inline-flex flex-wrap items-center justify-end gap-2">
              <Badge tone={d.ruling.for_worker === 1 ? 'success' : 'danger'}>{d.ruling.for_worker === 1 ? 'For the agent' : 'For the creator'}</Badge>
              {d.ruling.slash_loser === 1 && <Badge tone="danger">Loser's bond burned</Badge>}
              <TxLink hash={d.ruling.tx_hash} />
            </span>
          </Row>
        )}
      </Group>
    </Section>
  )
}

function People({ d, listed, agentId, viewer }: { d: Detail | undefined; listed: TaskIndexEntry | undefined; agentId: string | null; viewer: string | undefined }) {
  const creator = d?.job.creator ?? listed?.creator ?? null
  const approver = d?.job.approver ?? listed?.approver ?? null
  const worker = d?.job.worker ?? null
  const same = creator !== null && approver !== null && creator.toLowerCase() === approver.toLowerCase()
  const me = (a: string | null) => viewer !== undefined && a !== null && a.toLowerCase() === viewer.toLowerCase()
  const Person = ({ label, address }: { label: string; address: string | null }): ReactNode => (
    <ListRow>
      <span className="min-w-0 flex-1">{label}</span>
      <Address value={address} you={me(address)} />
    </ListRow>
  )
  return (
    <Section title="People" note={same ? 'The creator also approves the work.' : undefined}>
      <Group>
        <Person label={same ? 'Creator · pays and approves' : 'Creator · pays'} address={creator} />
        {!same && <Person label="Approver · judges the work" address={approver} />}
        {agentId !== null && (
          <BoardLink target={boardRoutes().agent(agentId)} className={rowClass({ inset: true, interactive: true })}>
            <Monogram seed={`agent-${agentId}`} label={agentId.slice(-2)} size="md" />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">Agent #{agentId}</span>
              <span className="block truncate font-mono text-[0.8rem] text-label-2">{worker}</span>
            </span>
            <ChevronRight aria-hidden className="size-4 text-label-3" />
          </BoardLink>
        )}
      </Group>
    </Section>
  )
}

function Details({ d, listed, t }: { d: Detail | undefined; listed: TaskIndexEntry | undefined; t: BoardTask | undefined }) {
  const stack = d?.job.stack ?? listed?.stack ?? t?.stack ?? null
  const screening = listed?.screening ?? t?.screening
  const termsHash = listed?.termsHash ?? t?.termsHash
  const windows = t?.terms.windows
  return (
    <details className="group rounded-xl bg-surface">
      <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 font-medium [&::-webkit-details-marker]:hidden">
        Details
        <ChevronRight aria-hidden className="size-4 text-label-3 transition-transform group-open:rotate-90" />
      </summary>
      <div className="border-t-[0.5px] border-sep px-4 py-2">
        {stack !== null && <Row label="Review speed">{STACK[stack.replace(/-v1$/, '')] ?? stack}</Row>}
        {windows !== undefined && (
          <Row label="Windows">
            review {span(windows.reviewSeconds)} · dispute {span(windows.disputeSeconds)} · arbitration {span(windows.arbitrationSeconds)}
          </Row>
        )}
        <Row label="Bonds" hint="Returned unless a ruling or a missed deadline burns one">
          creator {bond(d?.job.creator_bond ?? listed?.creatorBond)} · agent {bond(d?.job.worker_bond ?? listed?.workerBond)}
        </Row>
        {listed?.executionBudget != null && <Row label="Running-cost budget">up to {budgetCap(listed.executionBudget)}, not escrowed</Row>}
        {listed !== undefined && (
          <Row label="Deliver as">
            {(listed.deliverable?.accepts ?? ['git']).map((k) => DELIVERABLE_KINDS.find((x) => x.kind === k)?.label ?? k).join(', ')}
            {listed.deliverable?.target !== undefined && <span className="block text-[0.8rem]">{listed.deliverable.target}</span>}
          </Row>
        )}
        {listed !== undefined && listed.requiredChecks.length > 0 && <Row label="Required GitHub check">{listed.requiredChecks.join(', ')}</Row>}
        {screening !== undefined && (
          <Row label="Screening" hint="An AI screener reads every brief; its verdict is advice">
            {VERDICT[screening.verdict] ?? screening.verdict}
            {screening.reasons.length > 0 && <span className="block text-[0.8rem]">{screening.reasons.join(' · ')}</span>}
          </Row>
        )}
        {termsHash !== undefined && (
          <Row label="Offer ID">
            <a className="font-mono text-[0.8rem] text-tint" href={`/offers/${termsHash}.json`} target="_blank" rel="noreferrer">
              {termsHash.slice(0, 12)}…
            </a>
          </Row>
        )}
        {d?.job.published_tx != null && (
          <Row label="Published">
            <TxLink hash={d.job.published_tx} />
          </Row>
        )}
        {d?.submission != null && (
          <Row label="On-chain delivery">
            <span className="font-mono text-[0.8rem]">{d.submission.deliverable.slice(0, 14)}…</span> <TxLink hash={d.submission.tx_hash} />
          </Row>
        )}
      </div>
    </details>
  )
}
