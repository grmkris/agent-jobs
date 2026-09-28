import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { useState } from 'react'
import { useSignTypedData } from 'wagmi'
import { type TxRequest, data, tool } from '../api.ts'
import { BudgetPanel } from '../components/BudgetPanel.tsx'
import { TxSteps } from '../components/TxSteps.tsx'
import { Address, Badge, Button, Card, Row, TxLink, statusTone } from '../components/ui.tsx'
import type { useSignedIn } from '../components/Wallet.tsx'
import { amount, bond, when } from '../format.ts'
import { Jev, useJobs } from './Jobs.tsx'

interface Detail {
  job: { status: string; mode: string | null; stack: string | null; worker: string | null; agent_id: string | null; deliverable: string | null; violation: string | null; rejection_reason_hash: string | null; creator: string | null; approver: string | null; token: string | null; reward: string | null; creator_bond: string | null; worker_bond: string | null; delivery_deadline: number | null; selection_deadline: number | null; published_tx: string | null }
  submission: { deliverable: string; provider: string; tx_hash: string } | null
  evidence: Array<{ verifier: string; submission_hash: string; tested_sha: string; conclusion: string; expired: boolean; onchainMatch: boolean; tx_hash: string }>
  ruling: { for_worker: number; slash_loser: number; reason_hash: string; tx_hash: string } | null
  rewards: Array<{ kind: string; recipient: string; amount: string; tx_hash: string }>
  bonds: Array<{ side: string; outcome: string; recipient: string | null; amount: string; tx_hash: string }>
  feedback: { agent_id: string; value: string | null; tag: string | null; recorded: number; tx_hash: string } | null
}

type Auth = ReturnType<typeof useSignedIn>

export function JobPage({ auth }: { auth: Auth }) {
  const { jobId } = useParams({ from: '/job/$jobId' })
  const { items } = useJobs()
  const task = items.find((i) => i.jobId === jobId)?.task
  const chain = useQuery({ queryKey: ['job', jobId], queryFn: () => data<Detail>(`jobs/${jobId}`), refetchInterval: 15_000 })
  const board = useQuery({
    queryKey: ['get_task', task?.taskId, auth.signedIn],
    queryFn: () => tool('get_task', { taskId: task?.taskId }),
    enabled: task !== undefined,
    refetchInterval: 15_000,
  })
  const d = chain.data
  const status: string = board.data?.chain?.status ?? d?.job.status ?? 'unknown'
  const roles: string[] = board.data?.you ?? []
  const boardLabel = (submissionHash: string) =>
    (board.data?.evidence as Array<{ submissionHash: string; label: string }> | undefined)?.find((e) => e.submissionHash.toLowerCase() === submissionHash.toLowerCase())?.label

  return (
    <div className="space-y-4">
      <Link to="/" className="text-sm text-neutral-500 hover:underline">← all jobs</Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">#{jobId} {task?.title ?? ''}</h1>
        <Badge tone={statusTone(status)}>{status}</Badge>
        <Jev verdict={task?.screening.verdict} />
        {roles.map((r) => <Badge key={r} tone="blue">you: {r}</Badge>)}
      </div>
      {chain.error !== null && <p className="text-sm text-amber-700">Chain facts: {(chain.error as Error).message}</p>}

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Offer">
          {task !== undefined && <p className="mb-2 whitespace-pre-wrap text-sm">{task.brief}</p>}
          {task !== undefined && task.acceptanceCriteria.length > 0 && (
            <ul className="mb-3 list-disc pl-5 text-sm">{task.acceptanceCriteria.map((c) => <li key={c}>{c}</li>)}</ul>
          )}
          <Row label="Mode">{d?.job.mode ?? task?.mode}{task?.quoted === true ? ' (from a picked quote)' : ''}</Row>
          <Row label="Reward">{amount(d?.job.reward ?? task?.reward, d?.job.token ?? task?.token)}</Row>
          {task?.executionBudget != null && <Row label="Execution budget">up to {amount(task.executionBudget.cap, task.executionBudget.token)}, not escrowed</Row>}
          <Row label="Creator bond">{bond(d?.job.creator_bond ?? task?.creatorBond)}</Row>
          <Row label="Worker bond">{bond(d?.job.worker_bond ?? task?.workerBond)}</Row>
          <Row label="Creator"><Address value={d?.job.creator ?? task?.creator} /></Row>
          <Row label="Approver"><Address value={d?.job.approver ?? task?.approver} /></Row>
          <Row label="Delivery deadline">{when(d?.job.delivery_deadline ?? task?.deliveryDeadline)}</Row>
          {(d?.job.mode ?? task?.mode) === 'contest' && <Row label="Selection deadline">{when(d?.job.selection_deadline ?? task?.selectionDeadline)}</Row>}
          {task !== undefined && <Row label="Required checks">{task.requiredChecks.join(', ') || '—'}</Row>}
          {task !== undefined && <Row label="Manifest"><a className="text-xs text-sky-700 hover:underline" href={`/offers/${task.termsHash}.json`}>{task.termsHash.slice(0, 12)}…</a></Row>}
          <Row label="Published"><TxLink hash={d?.job.published_tx} /></Row>
          {(d?.job.mode ?? task?.mode) === 'contest' && (
            <p className="mt-2 text-xs text-amber-700">May close early when a winner is paid. Only the selected entry is paid.</p>
          )}
          {task !== undefined && task.screening.reasons.length > 0 && (
            <p className="mt-2 text-xs text-neutral-500">Jev (advisory): {task.screening.reasons.join('; ')}</p>
          )}
        </Card>

        <Card title="Work">
          <Row label="Worker"><Address value={d?.job.worker} /></Row>
          <Row label="ERC-8004 agent">{d?.job.agent_id == null ? '—' : <Link to="/agent/$agentId" params={{ agentId: d.job.agent_id }} className="underline">{d.job.agent_id}</Link>}</Row>
          <Row label="On-chain deliverable"><span className="font-mono text-xs">{d?.submission?.deliverable.slice(0, 14) ?? '—'}</span> <TxLink hash={d?.submission?.tx_hash} /></Row>
          {(board.data?.deliverables as Array<{ repo: string; branch: string; sha: string; deliverable_hash: string }> | undefined)?.map((x) => (
            <Row key={x.deliverable_hash} label="Declared">
              <a className="text-xs text-sky-700 hover:underline" href={`${x.repo}/tree/${x.sha}`} target="_blank" rel="noreferrer">{x.branch} @ {x.sha.slice(0, 7)}</a>
            </Row>
          ))}
          <h3 className="mb-1 mt-3 text-xs font-semibold uppercase text-neutral-500">Evidence</h3>
          {(d?.evidence ?? []).length === 0 && <p className="text-sm text-neutral-400">none attached</p>}
          {d?.evidence.map((e) => {
            const label = e.onchainMatch ? 'matches the awarded on-chain deliverable' : e.expired ? 'expired' : boardLabel(e.submission_hash) ?? 'does not match the on-chain deliverable'
            return (
              <div key={e.tx_hash} className="mb-2 rounded border border-neutral-100 p-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={e.conclusion === 'success' ? 'green' : 'red'}>{e.conclusion}</Badge>
                  <Badge tone={e.onchainMatch ? 'green' : label === 'matches this submitted candidate' ? 'blue' : 'gray'}>{label}</Badge>
                  <TxLink hash={e.tx_hash} />
                </div>
                <div className="mt-1 text-xs text-neutral-500">verifier <Address value={e.verifier} /> · tested {`0x${e.tested_sha.slice(-40, -33)}`}</div>
              </div>
            )
          })}
        </Card>
      </div>

      {task !== undefined && task.executionBudget !== null && (
        <BudgetPanel task={task} roles={roles} signedIn={auth.signedIn} address={auth.address} />
      )}

      {d !== undefined && (d.job.violation !== null || d.ruling !== null || d.bonds.length > 0 || d.rewards.length > 0) && (
        <DisputePanel d={d} taskId={task?.taskId} signedIn={auth.signedIn} roles={roles} />
      )}

      {auth.signedIn && task !== undefined && (
        <Actions taskId={task.taskId} status={status} mode={d?.job.mode ?? task.mode} roles={roles} />
      )}
      {!auth.signedIn && <p className="text-sm text-neutral-500">Connect a wallet and sign in to act on this job (award, approve, reject, dispute, settle).</p>}
    </div>
  )
}

function DisputePanel({ d, taskId, signedIn, roles }: { d: Detail; taskId: string | undefined; signedIn: boolean; roles: string[] }) {
  const bundle = useQuery({
    queryKey: ['bundle', taskId],
    queryFn: () => tool<{ bundle: { rejection: { reasonText: string | null }; statements: Array<{ role: string; text: string }> } }>('get_dispute_bundle', { taskId }),
    enabled: signedIn && taskId !== undefined && roles.length > 0 && d.job.violation !== null,
    retry: false,
  })
  return (
    <Card title={d.job.violation === null && d.ruling === null ? 'Outcome' : 'Rejection, dispute and outcome'}>
      {d.job.violation !== null && (
        <>
          <Row label="Violation named">{d.job.violation}</Row>
          <Row label="Rejection reason">
            {bundle.data?.bundle.rejection.reasonText ?? <span className="font-mono text-xs">{d.job.rejection_reason_hash?.slice(0, 14) ?? '—'}</span>}
          </Row>
        </>
      )}
      {bundle.data?.bundle.statements.map((s, i) => <Row key={i} label={`Statement (${s.role})`}><span className="text-xs">{s.text}</span></Row>)}
      {d.ruling !== null && <Row label="Ruling">
        {(
          <span className="flex items-center gap-2">
            <Badge tone={d.ruling.for_worker === 1 ? 'green' : 'red'}>{d.ruling.for_worker === 1 ? 'for the worker' : 'for the creator'}</Badge>
            {d.ruling.slash_loser === 1 && <Badge tone="red">loser slashed</Badge>}
            <TxLink hash={d.ruling.tx_hash} />
          </span>
        )}
      </Row>}
      {d.bonds.map((b) => (
        <Row key={b.tx_hash + b.side} label={`${b.side} bond`}>
          <span className="flex items-center gap-2"><Badge tone={b.outcome === 'burned' ? 'red' : 'green'}>{b.outcome}</Badge>{bond(b.amount)} <TxLink hash={b.tx_hash} /></span>
        </Row>
      ))}
      {d.rewards.map((r) => (
        <Row key={r.tx_hash + r.kind} label={`reward ${r.kind}`}><span className="flex items-center gap-2"><Address value={r.recipient} /> {amount(r.amount, d.job.token)} <TxLink hash={r.tx_hash} /></span></Row>
      ))}
      {d.feedback !== null && <Row label="ERC-8004 feedback">{d.feedback.recorded === 1 ? `${d.feedback.tag} (${d.feedback.value})` : 'failed (payout unaffected)'}</Row>}
    </Card>
  )
}

function Actions({ taskId, status, mode, roles }: { taskId: string; status: string; mode: string | null; roles: string[] }) {
  const qc = useQueryClient()
  const [txs, setTxs] = useState<TxRequest[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [violation, setViolation] = useState('Quality')
  const [reason, setReason] = useState('')
  const [statement, setStatement] = useState('')
  const approver = roles.includes('approver')
  const worker = roles.includes('worker')
  const creator = roles.includes('creator')
  const { signTypedDataAsync } = useSignTypedData()
  const [selected, setSelected] = useState<string | null>(null)
  const applications = useQuery({
    queryKey: ['applications', taskId],
    queryFn: () => tool<Array<{ id: string; worker: string; agent_id: string; note: string }>>('list_applications', { taskId }),
    enabled: creator && mode === 'hire' && status === 'open',
    refetchInterval: 15_000,
  })
  /** The creator's pick is an EIP-712 Selection signed off-chain; nothing is on-chain until the worker activates. */
  const select = (applicationId: string) => async () => {
    setBusy(`select-${applicationId}`)
    setError(null)
    try {
      const sel = await tool<{ nonce: string; sign: { typedData: string } }>('select_worker', { taskId, applicationId })
      const parsed = JSON.parse(sel.sign.typedData) as { types: Record<string, Array<{ name: string; type: string }>>; primaryType: string; domain: Record<string, unknown>; message: Record<string, unknown> }
      const { EIP712Domain: _d, ...types } = parsed.types
      const message = { ...parsed.message }
      for (const f of types[parsed.primaryType] ?? []) {
        if (/^u?int\d*$/.test(f.type) && typeof message[f.name] === 'string') message[f.name] = BigInt(message[f.name] as string)
      }
      const signature = await signTypedDataAsync({ domain: parsed.domain, types, primaryType: parsed.primaryType, message } as never)
      await tool('submit_selection', { taskId, nonce: sel.nonce, signature })
      setSelected(applicationId)
    } catch (e) {
      setError((e as Error).message.split('\n')[0] ?? 'failed')
    } finally {
      setBusy(null)
    }
  }
  const candidates = useQuery({
    queryKey: ['candidates', taskId],
    queryFn: () => tool<Array<{ candidateId: string; worker: string; agentId: string; repo: string; branch: string; sha: string }>>('list_candidates', { taskId }),
    enabled: approver && mode === 'contest' && status === 'open',
  })
  const run = (key: string, name: string, args: Record<string, unknown>) => async () => {
    setBusy(key)
    setError(null)
    try {
      const r = await tool<{ transactions: TxRequest[] }>(name, { taskId, ...args })
      setTxs(r.transactions)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const done = () => {
    setTxs(null)
    void qc.invalidateQueries()
  }
  if (txs !== null) {
    return (
      <Card title="Send from your wallet">
        {txs.length === 0 ? <p className="text-sm text-neutral-500">Nothing to send right now.</p> : <TxSteps taskId={taskId} txs={txs} onDone={done} />}
        <Button variant="outline" className="mt-3" onClick={() => setTxs(null)}>Close</Button>
      </Card>
    )
  }
  return (
    <Card title="Actions">
      <div className="space-y-4">
        {creator && mode === 'hire' && status === 'open' && (
          <div>
            <h3 className="mb-2 text-sm font-medium">Applications (select one: you sign a Selection, no transaction; the worker's own activate binds them)</h3>
            {(applications.data ?? []).length === 0 && <p className="text-sm text-neutral-400">No applications yet.</p>}
            {applications.data?.map((a) => (
              <div key={a.id} className="flex flex-wrap items-center gap-3 py-1 text-sm">
                <Address value={a.worker} />
                <Link to="/agent/$agentId" params={{ agentId: a.agent_id }} className="underline">agent {a.agent_id}</Link>
                <span className="text-xs text-neutral-600">{a.note}</span>
                {selected === a.id ? <Badge tone="green">selected; waiting for activation</Badge> : <Button busy={busy === `select-${a.id}`} onClick={select(a.id)}>Select</Button>}
              </div>
            ))}
          </div>
        )}
        {creator && mode === 'hire' && (status === 'open' || status === 'lapsed') && (
          <div>
            <Button variant="outline" busy={busy === 'cancel'} onClick={run('cancel', 'cancel_task', {})}>Cancel the offer (reward and bond back)</Button>
          </div>
        )}
        {approver && mode === 'contest' && status === 'open' && (
          <div>
            <h3 className="mb-2 text-sm font-medium">Entries (award one early: one transaction pays it and closes the contest)</h3>
            {(candidates.data ?? []).length === 0 && <p className="text-sm text-neutral-400">No complete entries yet.</p>}
            {candidates.data?.map((c) => (
              <div key={c.candidateId} className="flex flex-wrap items-center gap-3 py-1 text-sm">
                <Address value={c.worker} /> <span>agent {c.agentId}</span>
                <a className="text-xs text-sky-700 hover:underline" href={`${c.repo}/tree/${c.sha}`} target="_blank" rel="noreferrer">{c.branch} @ {c.sha.slice(0, 7)}</a>
                <Button busy={busy === `award-${c.candidateId}`} onClick={run(`award-${c.candidateId}`, 'award', { candidateId: c.candidateId })}>Award</Button>
              </div>
            ))}
          </div>
        )}
        {approver && status === 'submitted' && (
          <div className="space-y-2">
            <Button busy={busy === 'approve'} onClick={run('approve', 'approve_work', {})}>Approve and pay</Button>
            <div className="flex flex-wrap items-center gap-2">
              <select value={violation} onChange={(e) => setViolation(e.target.value)} className="rounded border border-neutral-300 px-2 py-1 text-sm">
                <option>None</option><option>Quality</option><option>Falsified</option>
              </select>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (published; its hash goes on-chain)" className="min-w-64 flex-1 rounded border border-neutral-300 px-2 py-1 text-sm" />
              <Button variant="danger" disabled={reason.trim().length < 10} busy={busy === 'reject'} onClick={run('reject', 'reject_work', { violation, reason })}>Reject</Button>
            </div>
            <p className="text-xs text-neutral-500">A rejection moves nothing; the worker may dispute. Quality or Falsified burns the worker bond only if undisputed or upheld.</p>
          </div>
        )}
        {worker && status === 'rejected-pending' && (
          <div className="flex flex-wrap items-center gap-2">
            <input value={statement} onChange={(e) => setStatement(e.target.value)} placeholder="Your case for the arbitrator" className="min-w-64 flex-1 rounded border border-neutral-300 px-2 py-1 text-sm" />
            <Button busy={busy === 'dispute'} onClick={run('dispute', 'dispute', statement.trim() === '' ? {} : { statement })}>Dispute</Button>
          </div>
        )}
        <div>
          <Button variant="outline" busy={busy === 'settle'} onClick={run('settle', 'settlement_actions', {})}>Timeouts and settlement anyone may send</Button>
        </div>
        {error !== null && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </Card>
  )
}
