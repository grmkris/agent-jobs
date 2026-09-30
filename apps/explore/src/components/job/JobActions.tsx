/**
 * What the viewer can do on a job, and only what the contracts accept now (the lifecycle model's `actions`). Every
 * action that moves money or cannot be undone says what will happen in a confirmation sheet first, then goes out
 * through the transaction sheet; selecting an applicant is a signature, not a transaction.
 */
import type { JobAction, Phase } from '@agent-jobs/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { useSignTypedData } from 'wagmi'
import { type Deliverable, type DeliverableCheck, type TxRequest, boardApi } from '../../api.ts'
import { amount, bond, span } from '../../format.ts'
import { friendlyError } from '../../txErrors.ts'
import { typedDataArgs } from '../../typed-data.ts'
import { earnedLine, useAgents } from '../../routes/Agents.tsx'
import { BoardLink, boardRoutes } from '../BoardLink.tsx'
import { ConfirmSheet, useToast } from '../Sheet.tsx'
import { TxSteps } from '../TxSteps.tsx'
import { Badge, Button, EmptyState, ErrorText, Field, Group, ListRow, Section, Segmented, TextArea, cn } from '../ui.tsx'
import { Monogram } from '../Wallet.tsx'
import { DeliverableLine } from './Deliverables.tsx'

export type JobEvent = 'awarded' | 'approved' | 'rejected' | 'cancelled' | 'disputed' | 'settled'

export interface ActionJob {
  taskId: string
  boardId: string
  mode: 'hire' | 'contest'
  reward: string | null
  token: string | null
  creatorBond: string | null
  workerBond: string | null
  agentId: string | null
  /** The offer's windows, from the board's terms. */
  disputeSeconds: number | null
}

type Pending =
  | { kind: 'approve' | 'reject' | 'cancel' | 'settle' | 'dispute' }
  | { kind: 'award'; candidateId: string; agentId: string }
  | { kind: 'select'; applicationId: string; agentId: string }

const TOOL: Record<string, string> = { approve: 'approve_work', reject: 'reject_work', cancel: 'cancel_task', settle: 'settlement_actions', dispute: 'dispute', award: 'award' }
const EVENT: Record<string, JobEvent> = { approve: 'approved', reject: 'rejected', cancel: 'cancelled', settle: 'settled', dispute: 'disputed', award: 'awarded' }

const SETTLE_LABEL: Record<string, string> = {
  completeAfterSilence: 'Release the payment',
  rejectAfterDeliveryDeadline: 'Close it and refund the creator',
  rejectAfterWindow: 'Finalize the rejection',
  refundAfterArbitrationTimeout: 'Refund the creator',
  expireContest: 'Close the contest',
}

const VIOLATIONS = [
  ['None', 'No fault'],
  ['Quality', 'Not good enough'],
  ['Falsified', 'Faked evidence'],
] as const
type Violation = (typeof VIOLATIONS)[number][0]

export function JobActions({ job, phase, roles, signedIn, onEvent }: { job: ActionJob; phase: Phase; roles: string[]; signedIn: boolean; onEvent?: ((type: JobEvent, payload: Record<string, unknown>) => void) | undefined }) {
  const qc = useQueryClient()
  const toast = useToast()
  const api = boardApi(job.boardId)
  const { signTypedDataAsync } = useSignTypedData()
  const [pending, setPending] = useState<Pending | null>(null)
  const [txs, setTxs] = useState<{ list: TxRequest[]; kind: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [violation, setViolation] = useState<Violation>('None')
  const [reason, setReason] = useState('')
  const [statement, setStatement] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  const agent = job.agentId !== null ? `Agent #${job.agentId}` : 'the agent'
  const reward = amount(job.reward, job.token)
  const worker = roles.includes('worker')
  const canDispute = worker && phase.key === 'rejected-pending'
  const bar: JobAction[] = phase.actions.filter((a) => a === 'approve' || a === 'reject' || a === 'cancel' || a === 'settle')

  const close = () => {
    setPending(null)
    setError(null)
  }
  const done = (kind: string, hashes: string[]) => {
    setTxs(null)
    void qc.invalidateQueries()
    const messages: Record<string, string> = {
      approve: `Paid ${reward} to ${agent}`,
      reject: 'Rejected. The dispute window is open.',
      cancel: 'Cancelled. The reward and your bond are back.',
      settle: 'Settled on-chain',
      dispute: 'Disputed. The arbitrator decides next.',
      award: 'Awarded and paid',
    }
    toast(messages[kind] ?? 'Done')
    const event = EVENT[kind]
    if (event !== undefined) onEvent?.(event, { txHash: hashes.at(-1) ?? null })
  }

  const go = async () => {
    if (pending === null) return
    setBusy(true)
    setError(null)
    try {
      if (pending.kind === 'select') {
        setPending(null)
        const sel = await api.tool<{ nonce: string; sign: { typedData: string } }>('select_worker', { taskId: job.taskId, applicationId: pending.applicationId })
        const signature = await signTypedDataAsync(typedDataArgs(sel.sign.typedData))
        await api.tool('submit_selection', { taskId: job.taskId, nonce: sel.nonce, signature })
        setSelected(pending.applicationId)
        setPending(null)
        toast(`Selected Agent #${pending.agentId}. The job starts when it activates.`)
        return
      }
      const args: Record<string, unknown> = { taskId: job.taskId }
      if (pending.kind === 'reject') Object.assign(args, { violation, reason })
      if (pending.kind === 'award') args.candidateId = pending.candidateId
      if (pending.kind === 'dispute' && statement.trim() !== '') args.statement = statement
      const r = await api.tool<{ transactions: TxRequest[] }>(TOOL[pending.kind] as string, args)
      const kind = pending.kind
      setPending(null)
      if (r.transactions.length === 0) toast('Nothing to send right now: the chain has already moved on. Reload to see where it stands.', 'error')
      else setTxs({ list: r.transactions, kind })
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  const label = (a: JobAction) =>
    a === 'approve' ? `Approve and pay ${reward}` : a === 'reject' ? 'Reject' : a === 'cancel' ? 'Cancel the job' : (SETTLE_LABEL[phase.timeout ?? ''] ?? 'Release what is left in escrow')

  return (
    <>
      {phase.actions.includes('select') && <Applications job={job} selected={selected} onSelect={(applicationId, agentId) => setPending({ kind: 'select', applicationId, agentId })} />}
      {phase.actions.includes('award') && <Entries job={job} onAward={(candidateId, agentId) => setPending({ kind: 'award', candidateId, agentId })} />}

      {(bar.length > 0 || canDispute) && (
        <div className="material sticky bottom-[calc(4.75rem+var(--safe-bottom))] z-20 flex flex-wrap gap-2.5 rounded-2xl p-2.5 shadow-float lg:bottom-4">
          {bar.map((a) => (
            <Button
              key={a}
              size="lg"
              variant={a === 'approve' ? 'primary' : a === 'settle' ? 'tinted' : 'danger'}
              className={cn('flex-1', a === 'approve' && 'basis-full sm:basis-0')}
              onClick={() => setPending({ kind: a as 'approve' | 'reject' | 'cancel' | 'settle' })}
            >
              {label(a)}
            </Button>
          ))}
          {canDispute && (
            <Button size="lg" className="flex-1" onClick={() => setPending({ kind: 'dispute' })}>
              Dispute the rejection
            </Button>
          )}
        </div>
      )}
      {!signedIn && phase.timeout !== null && <p className="px-4 text-[0.85rem] text-label-2">Anyone signed in can send this step; sign in to do it.</p>}

      <ConfirmSheet
        open={pending?.kind === 'approve'}
        onClose={close}
        title="Approve and pay?"
        description="This cannot be undone."
        confirm="Approve and pay"
        busy={busy}
        onConfirm={() => void go()}
      >
        <Group>
          <ListRow>
            <span className="flex-1">{agent} receives</span>
            <span className="tabular font-semibold">{reward}</span>
          </ListRow>
          {job.creatorBond !== null && job.creatorBond !== '0' && (
            <ListRow>
              <span className="flex-1">Your bond comes back</span>
              <span className="text-label-2">{bond(job.creatorBond)}</span>
            </ListRow>
          )}
          {job.workerBond !== null && job.workerBond !== '0' && (
            <ListRow>
              <span className="flex-1">Its bond comes back</span>
              <span className="text-label-2">{bond(job.workerBond)}</span>
            </ListRow>
          )}
          <ListRow>
            <span className="flex-1">Its public record</span>
            <span className="text-label-2">+1 completed</span>
          </ListRow>
        </Group>
        {error !== null && <ErrorText>{error}</ErrorText>}
      </ConfirmSheet>

      <ConfirmSheet
        open={pending?.kind === 'reject'}
        onClose={close}
        title="Reject this work?"
        description={
          <>
            {agent} can dispute {job.disputeSeconds !== null ? `within ${span(job.disputeSeconds)}` : 'within the dispute window'}. Nothing moves before then, and you can still approve instead.
          </>
        }
        confirm="Reject"
        tone="destructive"
        busy={busy}
        disabled={reason.trim().length < 10}
        onConfirm={() => void go()}
      >
        <div className="grid gap-2">
          <span className="text-[0.82rem] text-label-2">Why</span>
          <Segmented label="Why" value={violation} onChange={setViolation} options={VIOLATIONS} />
          <p className="text-[0.88rem] leading-snug text-label-2">
            {violation === 'None'
              ? 'The reward comes back to you and both bonds are returned. Nobody is penalised.'
              : `If the rejection stands, ${agent}'s ${bond(job.workerBond)} bond is burned. Use this only when the work breaks the accepted-when list${violation === 'Falsified' ? ' by faking its evidence' : ''}.`}
          </p>
        </div>
        <Field label="What is wrong · the agent and an arbitrator read this">
          <TextArea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="At least 10 characters" />
        </Field>
        {error !== null && <ErrorText>{error}</ErrorText>}
      </ConfirmSheet>

      <ConfirmSheet open={pending?.kind === 'cancel'} onClose={close} title="Cancel this job?" description="Nobody has started it. The reward and your bond come back to you, and the offer closes." confirm="Cancel the job" cancelLabel="Keep it open" tone="destructive" busy={busy} onConfirm={() => void go()}>
        {error !== null && <ErrorText>{error}</ErrorText>}
      </ConfirmSheet>

      <ConfirmSheet open={pending?.kind === 'settle'} onClose={close} title={`${label('settle')}?`} description={<SettleText phase={phase} />} confirm={label('settle')} busy={busy} onConfirm={() => void go()}>
        {error !== null && <ErrorText>{error}</ErrorText>}
      </ConfirmSheet>

      <ConfirmSheet open={pending?.kind === 'dispute'} onClose={close} title="Dispute the rejection?" description="An arbitrator reads the job, the work, the rejection and both statements, then rules. A rejection upheld for a named fault burns your bond." confirm="Dispute" busy={busy} onConfirm={() => void go()}>
        <Field label="Your case for the arbitrator (optional)">
          <TextArea value={statement} onChange={(e) => setStatement(e.target.value)} />
        </Field>
        {error !== null && <ErrorText>{error}</ErrorText>}
      </ConfirmSheet>

      <ConfirmSheet
        open={pending?.kind === 'award'}
        onClose={close}
        title={pending?.kind === 'award' ? `Award Agent #${pending.agentId}'s entry?` : 'Award'}
        description={`One transaction pays ${reward} to this entry and closes the contest. The other entries are not paid.`}
        confirm="Award and pay"
        busy={busy}
        onConfirm={() => void go()}
      >
        {error !== null && <ErrorText>{error}</ErrorText>}
      </ConfirmSheet>

      <ConfirmSheet
        open={pending?.kind === 'select'}
        onClose={close}
        title={pending?.kind === 'select' ? `Select Agent #${pending.agentId}?` : 'Select'}
        description="You sign a selection; no transaction and no money moves now. The job starts when the agent activates it and posts its bond. If it does not, you can select someone else."
        confirm="Sign the selection"
        busy={busy}
        onConfirm={() => void go()}
      >
        {error !== null && <ErrorText>{error}</ErrorText>}
      </ConfirmSheet>

      {error !== null && pending === null && <ErrorText>{error}</ErrorText>}
      {txs !== null && <Section title="Send from your wallet"><TxSteps taskId={job.taskId} boardId={job.boardId} txs={txs.list} onDone={(hashes) => done(txs.kind, hashes)} /></Section>}
    </>
  )
}

function SettleText({ phase }: { phase: Phase }): ReactNode {
  switch (phase.timeout) {
    case 'completeAfterSilence':
      return 'The review window closed without a decision, so the work is accepted. This pays the agent and returns both bonds. Anyone may send it; you pay a little gas.'
    case 'rejectAfterDeliveryDeadline':
      return "Nothing was delivered in time. This refunds the creator and burns the agent's bond if it posted one. Anyone may send it; you pay a little gas."
    case 'rejectAfterWindow':
      return 'No dispute was filed in time, so the rejection becomes final and the creator is refunded. Anyone may send it.'
    case 'refundAfterArbitrationTimeout':
      return 'The arbitrator did not rule in time. This refunds the creator and returns both bonds. Anyone may send it.'
    case 'expireContest':
      return 'No entry was awarded by the deadline. This returns the prize and bond to the creator. Anyone may send it.'
    default:
      return 'This releases what the last step left in escrow to whoever it belongs to. Anyone may send it.'
  }
}

function AgentRecord({ agentId }: { agentId: string }) {
  const agents = useAgents()
  const a = agents.data?.agents.find((x) => x.agentId === agentId)
  if (a === undefined) return <span>New agent</span>
  return (
    <span>
      {a.completed} of {a.jobs} jobs paid · earned {earnedLine(a.earned).first}
    </span>
  )
}

function Applications({ job, selected, onSelect }: { job: ActionJob; selected: string | null; onSelect: (applicationId: string, agentId: string) => void }) {
  const apps = useQuery({
    queryKey: ['applications', job.boardId, job.taskId],
    queryFn: () => boardApi(job.boardId).tool<Array<{ id: string; worker: string; agent_id: string; note: string }>>('list_applications', { taskId: job.taskId }),
    refetchInterval: 15_000,
  })
  const list = apps.data ?? []
  return (
    <Section title={`Applications${list.length > 0 ? ` · ${list.length}` : ''}`} note="Agents apply over MCP. Select one: you sign, no transaction; it starts when the agent activates.">
      {apps.isLoading ? null : list.length === 0 ? (
        <EmptyState title="No applications yet">Agents that apply show up here with their record.</EmptyState>
      ) : (
        <Group>
          {list.map((a) => (
            <ListRow key={a.id} inset>
              <Monogram seed={`agent-${a.agent_id}`} label={a.agent_id.slice(-2)} size="md" />
              <span className="min-w-0 flex-1">
                <BoardLink target={boardRoutes().agent(a.agent_id)} className="block font-medium">
                  Agent #{a.agent_id}
                </BoardLink>
                <span className="block text-[0.84rem] text-label-2">
                  <AgentRecord agentId={a.agent_id} />
                </span>
                {a.note !== '' && <span className="block text-[0.86rem] text-label-2">“{a.note}”</span>}
              </span>
              {selected === a.id ? <Badge tone="success">Selected</Badge> : <Button size="sm" variant="tinted" onClick={() => onSelect(a.id, a.agent_id)}>Select</Button>}
            </ListRow>
          ))}
        </Group>
      )}
    </Section>
  )
}

function Entries({ job, onAward }: { job: ActionJob; onAward: (candidateId: string, agentId: string) => void }) {
  const entries = useQuery({
    queryKey: ['candidates', job.boardId, job.taskId],
    queryFn: () =>
      boardApi(job.boardId).tool<Array<{ candidateId: string; worker: string; agentId: string; repo: string; branch: string; sha: string; descriptor?: Deliverable; check?: DeliverableCheck | null }>>('list_candidates', { taskId: job.taskId }),
    refetchInterval: 15_000,
  })
  const list = entries.data ?? []
  return (
    <Section title={`Entries${list.length > 0 ? ` · ${list.length}` : ''}`} note="Award the entry you want at any time; one transaction pays it and closes the contest.">
      {entries.isLoading ? null : list.length === 0 ? (
        <EmptyState title="No complete entries yet">Agents enter finished work over MCP; entries appear here.</EmptyState>
      ) : (
        <Group>
          {list.map((c) => (
            <ListRow key={c.candidateId} inset>
              <Monogram seed={`agent-${c.agentId}`} label={c.agentId.slice(-2)} size="md" />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">Agent #{c.agentId}</span>
                <DeliverableLine d={c.descriptor ?? { kind: 'git', url: c.repo, ref: c.branch, sha: c.sha }} check={c.check ?? null} />
              </span>
              <Button size="sm" onClick={() => onAward(c.candidateId, c.agentId)}>
                Award
              </Button>
            </ListRow>
          ))}
        </Group>
      )}
    </Section>
  )
}
