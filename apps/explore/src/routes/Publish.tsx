import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { type TxRequest, tool } from '../api.ts'
import { TxSteps } from '../components/TxSteps.tsx'
import { Badge, Button, Card } from '../components/ui.tsx'
import type { useSignedIn } from '../components/Wallet.tsx'
import { TOKENS } from '../format.ts'
import { isMainnet } from '../wallet.ts'

type Auth = ReturnType<typeof useSignedIn>
interface Created {
  taskId: string
  termsHash: string
  manifestUrl: string
  screening: { verdict: string; reasons: string[] } | null
  transactions: TxRequest[]
}

const rewardTokens = Object.entries(TOKENS).filter(([, t]) => t.symbol !== 'FACTORY')
const input = 'w-full rounded border border-neutral-300 px-2 py-1 text-sm'

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint !== undefined && <span className="block text-xs text-neutral-500">{hint}</span>}
    </label>
  )
}

/**
 * Publish an offer from the browser wallet: the board freezes the offer and returns the approvals and the publish
 * transaction; Jev's advisory screening is shown before anything is signed. The reward is escrowed only when the
 * publish transaction confirms.
 */
export function PublishPage({ auth }: { auth: Auth }) {
  const navigate = useNavigate()
  const [mode, setMode] = useState<'hire' | 'contest'>('hire')
  const [title, setTitle] = useState('')
  const [brief, setBrief] = useState('')
  const [criteria, setCriteria] = useState('A GitHub check run named "test" completes with conclusion "success" on the submitted SHA.')
  const [token, setToken] = useState(rewardTokens[0]?.[0] ?? '')
  const [reward, setReward] = useState('10')
  const [creatorBond, setCreatorBond] = useState(isMainnet ? '0' : '2')
  const [workerBond, setWorkerBond] = useState(isMainnet ? '0' : '1')
  const [deliveryHours, setDeliveryHours] = useState('48')
  const [selectionHours, setSelectionHours] = useState('24')
  const [check, setCheck] = useState('test')
  const [stack, setStack] = useState<'main' | 'demo'>('main')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<Created | null>(null)

  if (!auth.signedIn) return <Card title="Publish"><p className="text-sm text-neutral-600">Connect a wallet and sign in to publish an offer.</p></Card>

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const now = Math.floor(Date.now() / 1000)
      const c = await tool<Created>('create_task', {
        title,
        brief,
        acceptanceCriteria: criteria.split('\n').map((l) => l.trim()).filter((l) => l !== ''),
        token,
        reward,
        creatorBond,
        workerBond: mode === 'contest' ? '0' : workerBond,
        deliveryDeadline: now + Math.round(Number(deliveryHours) * 3600),
        mode,
        ...(mode === 'contest' ? { selectionDeadline: now + Math.round(Number(selectionHours) * 3600) } : {}),
        ...(check.trim() === '' ? {} : { requiredChecks: [check.trim()] }),
        stack,
      })
      setCreated(c)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (created !== null) {
    return (
      <Card title="Review and publish">
        <div className="space-y-3 text-sm">
          <p>
            Offer frozen: terms <span className="font-mono text-xs">{created.termsHash.slice(0, 14)}…</span>,{' '}
            <a href={created.manifestUrl} className="underline" target="_blank" rel="noreferrer">manifest</a>.
          </p>
          {created.screening !== null && (
            <div className="rounded border border-neutral-200 p-2">
              <Badge tone={created.screening.verdict === 'clean' ? 'green' : created.screening.verdict === 'reject' ? 'red' : 'amber'}>Jev: {created.screening.verdict}</Badge>
              <ul className="mt-1 list-disc pl-5 text-xs text-neutral-600">{created.screening.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
              <p className="mt-1 text-xs text-neutral-400">Advisory only: Jev never blocks a publish.</p>
            </div>
          )}
          <TxSteps
            taskId={created.taskId}
            txs={created.transactions}
            onDone={async () => {
              const t = await tool<{ jobId: string | null }>('get_task', { taskId: created.taskId })
              if (t.jobId !== null) await navigate({ to: '/job/$jobId', params: { jobId: t.jobId } })
            }}
          />
        </div>
      </Card>
    )
  }

  return (
    <Card title="Publish an offer">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Mode" hint={mode === 'hire' ? 'You pick one applicant; they activate and deliver.' : 'Entrants deliver first; you award one by the selection deadline.'}>
          <select value={mode} onChange={(e) => setMode(e.target.value as 'hire' | 'contest')} className={input}>
            <option value="hire">hire</option>
            <option value="contest">contest</option>
          </select>
        </Field>
        {!isMainnet && (
          <Field label="Board" hint="demo: minute-long review and dispute windows for trying things out.">
            <select value={stack} onChange={(e) => setStack(e.target.value as 'main' | 'demo')} className={input}>
              <option value="main">main</option>
              <option value="demo">demo</option>
            </select>
          </Field>
        )}
        <div className="sm:col-span-2"><Field label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} className={input} /></Field></div>
        <div className="sm:col-span-2"><Field label="Brief" hint="What needs doing, with the repository URL."><textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={4} className={input} /></Field></div>
        <div className="sm:col-span-2"><Field label="Acceptance criteria" hint="One per line; the approver checks exactly these."><textarea value={criteria} onChange={(e) => setCriteria(e.target.value)} rows={3} className={input} /></Field></div>
        <Field label="Reward token">
          <select value={token} onChange={(e) => setToken(e.target.value)} className={input}>
            {rewardTokens.map(([address, t]) => <option key={address} value={address}>{t.symbol}</option>)}
          </select>
        </Field>
        <Field label="Reward"><input value={reward} onChange={(e) => setReward(e.target.value)} className={input} inputMode="decimal" /></Field>
        <Field label="Your bond (FACTORY)"><input value={creatorBond} onChange={(e) => setCreatorBond(e.target.value)} className={input} inputMode="decimal" /></Field>
        {mode === 'hire' && <Field label="Worker bond (FACTORY)"><input value={workerBond} onChange={(e) => setWorkerBond(e.target.value)} className={input} inputMode="decimal" /></Field>}
        <Field label="Delivery within (hours)"><input value={deliveryHours} onChange={(e) => setDeliveryHours(e.target.value)} className={input} inputMode="decimal" /></Field>
        {mode === 'contest' && <Field label="Award within (hours)" hint="Must end before the delivery window; unawarded, the prize and your bond come back."><input value={selectionHours} onChange={(e) => setSelectionHours(e.target.value)} className={input} inputMode="decimal" /></Field>}
        <Field label="Required GitHub check" hint="Evidence must cover this check on the submitted SHA."><input value={check} onChange={(e) => setCheck(e.target.value)} className={input} /></Field>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Button busy={busy} disabled={title.trim() === '' || brief.trim() === ''} onClick={submit}>Freeze offer and screen</Button>
        {error !== null && <span className="text-xs text-red-600">{error}</span>}
      </div>
    </Card>
  )
}
