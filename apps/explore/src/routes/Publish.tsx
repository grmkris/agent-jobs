import { useState } from 'react'
import { DELIVERABLE_KINDS, type DeliverableKind, type TxRequest, tool } from '../api.ts'
import { boardRoutes, useBoardNavigate } from '../components/BoardLink.tsx'
import { TxSteps } from '../components/TxSteps.tsx'
import { Badge, Button, Card } from '../components/ui.tsx'
import type { useSignedIn } from '../components/Wallet.tsx'
import { TOKENS } from '../format.ts'
import { deployment, isMainnet } from '../wallet.ts'

type Auth = ReturnType<typeof useSignedIn>
interface Created {
  taskId: string
  termsHash: string
  manifestUrl: string
  screening: { verdict: string; reasons: string[] } | null
  transactions: TxRequest[]
}

const rewardTokens = Object.entries(TOKENS).filter(([, t]) => t.symbol !== 'FACTORY')

/** nad.fun's launch call on Monad testnet: a call budget for it makes the creator the token's creator (ADR-0005). */
const NADFUN_TESTNET = {
  target: '0x865054F0F6A288adaAc30261731361EA7E908003',
  function: 'function create((string name,string symbol,string tokenURI,uint256 amountOut,bytes32 salt,uint8 actionId) params) payable',
  cap: '12',
}
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
 * Publish an offer from the signed-in Privy wallet: the board freezes the offer and returns the approvals and the publish
 * transaction; Jev's advisory screening is shown before anything is signed. The reward is escrowed only when the
 * publish transaction confirms. Or ask for quotes: nothing is escrowed until a quote is picked.
 *
 * A hire may carry an execution budget (ADR-0005): what the worker may spend from your wallet on running costs,
 * apart from the reward. It is bound into the offer; you grant it on the job page (Privy email/Google wallet).
 */
export interface Published {
  taskId: string
  jobId: string | null
  txHash: string | null
}

export function PublishPage({ auth, prefill = {}, onPublished }: { auth: Auth; prefill?: Record<string, string>; onPublished?: (p: Published) => void }) {
  const navigate = useBoardNavigate()
  const [mode, setMode] = useState<'hire' | 'contest' | 'quotes'>(prefill.mode === 'contest' || prefill.mode === 'quotes' ? prefill.mode : 'hire')
  const [quoteTokens, setQuoteTokens] = useState<string[]>(rewardTokens.map(([a]) => a))
  const [quoteHours, setQuoteHours] = useState('6')
  const [budgetOn, setBudgetOn] = useState(false)
  const [budgetToken, setBudgetToken] = useState(rewardTokens[0]?.[0] ?? '')
  const [budgetCap, setBudgetCap] = useState('2')
  const [budgetKind, setBudgetKind] = useState<'token' | 'call' | 'x402'>('token')
  const [x402Cap, setX402Cap] = useState('1')
  const [x402PerCall, setX402PerCall] = useState('0.1')
  const [callTarget, setCallTarget] = useState(isMainnet ? '' : NADFUN_TESTNET.target)
  const [callFunction, setCallFunction] = useState(isMainnet ? '' : NADFUN_TESTNET.function)
  const [callCap, setCallCap] = useState(NADFUN_TESTNET.cap)
  const [title, setTitle] = useState(prefill.title ?? '')
  const [brief, setBrief] = useState(prefill.brief ?? '')
  const [criteria, setCriteria] = useState('A GitHub check run named "test" completes with conclusion "success" on the submitted SHA.')
  const [token, setToken] = useState(rewardTokens.find(([a, t]) => prefill.token !== undefined && (t.symbol.toLowerCase() === prefill.token.toLowerCase() || a === prefill.token.toLowerCase()))?.[0] ?? rewardTokens[0]?.[0] ?? '')
  const [reward, setReward] = useState(prefill.reward ?? '10')
  const [creatorBond, setCreatorBond] = useState(isMainnet ? '0' : '2')
  const [workerBond, setWorkerBond] = useState(isMainnet ? '0' : '1')
  const [deliveryHours, setDeliveryHours] = useState('48')
  const [selectionHours, setSelectionHours] = useState('24')
  const [check, setCheck] = useState('test')
  const [accepts, setAccepts] = useState<DeliverableKind[]>(['git'])
  const [target, setTarget] = useState('')
  const [stack, setStack] = useState<'main' | 'demo' | 'fast'>('main')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<Created | null>(null)

  if (!auth.signedIn) return <Card title="Publish"><p className="text-sm text-neutral-600">Log in and sign in to publish an offer.</p></Card>

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const now = Math.floor(Date.now() / 1000)
      const acceptanceCriteria = criteria.split('\n').map((l) => l.trim()).filter((l) => l !== '')
      // Git only with no target is the default: leave the field out so the terms stay as before (ADR-0006).
      const deliverable = accepts.length === 1 && accepts[0] === 'git' && target.trim() === '' ? {} : { deliverable: { accepts, ...(target.trim() === '' ? {} : { target: target.trim() }) } }
      const checks = check.trim() === '' || !accepts.includes('git') ? {} : { requiredChecks: [check.trim()] }
      if (mode === 'quotes') {
        const r = await tool<{ requestId: string }>('request_quotes', {
          title,
          brief,
          acceptanceCriteria,
          tokens: quoteTokens,
          creatorBond,
          workerBond,
          deliveryDeadline: now + Math.round(Number(deliveryHours) * 3600),
          quoteDeadline: now + Math.round(Number(quoteHours) * 3600),
          ...checks,
          ...deliverable,
          stack,
        })
        await navigate(boardRoutes().quoteRequest(r.requestId))
        return
      }
      const c = await tool<Created>('create_task', {
        title,
        brief,
        acceptanceCriteria,
        token,
        reward,
        creatorBond,
        workerBond: mode === 'contest' ? '0' : workerBond,
        deliveryDeadline: now + Math.round(Number(deliveryHours) * 3600),
        mode,
        ...(mode === 'contest' ? { selectionDeadline: now + Math.round(Number(selectionHours) * 3600) } : {}),
        ...checks,
        ...deliverable,
        ...(mode === 'hire' && budgetOn
          ? {
              executionBudget:
                budgetKind === 'call'
                  ? { kind: 'call', target: callTarget.trim(), function: callFunction.trim(), cap: callCap }
                  : budgetKind === 'x402'
                    ? { kind: 'x402', cap: x402Cap, perCall: x402PerCall }
                    : { token: budgetToken, cap: budgetCap },
            }
          : {}),
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
            onDone={async (hashes) => {
              const t = await tool<{ jobId: string | null }>('get_task', { taskId: created.taskId })
              if (onPublished !== undefined) onPublished({ taskId: created.taskId, jobId: t.jobId, txHash: hashes.at(-1) ?? null })
              else if (t.jobId !== null) await navigate(boardRoutes().job(t.jobId))
            }}
          />
        </div>
      </Card>
    )
  }

  return (
    <Card title="Publish an offer">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Mode"
          hint={
            mode === 'hire'
              ? 'You pick one applicant; they activate and deliver.'
              : mode === 'contest'
                ? 'Entrants deliver first; you award one by the selection deadline.'
                : 'Workers quote a price (and may declare running costs); you pick one. Nothing is escrowed until then.'
          }
        >
          <select value={mode} onChange={(e) => setMode(e.target.value as 'hire' | 'contest' | 'quotes')} className={input}>
            <option value="hire">hire</option>
            <option value="contest">contest</option>
            <option value="quotes">hire, ask for quotes</option>
          </select>
        </Field>
        {!isMainnet && (
          <Field label="Board" hint="demo: minute-long review and dispute windows for trying things out.">
            <select value={stack} onChange={(e) => setStack(e.target.value as 'main' | 'demo' | 'fast')} className={input}>
              {Object.keys(deployment.stacks).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
        )}
        <div className="sm:col-span-2"><Field label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} className={input} /></Field></div>
        <div className="sm:col-span-2"><Field label="Brief" hint="What needs doing, with the repository URL."><textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={4} className={input} /></Field></div>
        <div className="sm:col-span-2"><Field label="Acceptance criteria" hint="One per line; the approver checks exactly these."><textarea value={criteria} onChange={(e) => setCriteria(e.target.value)} rows={3} className={input} /></Field></div>
        {mode === 'quotes' ? (
          <>
            <Field label="Accepted tokens" hint="Each quote names one of these and an exact amount.">
              <div className="flex gap-3 text-sm">
                {rewardTokens.map(([address, t]) => (
                  <label key={address} className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={quoteTokens.includes(address)}
                      onChange={(e) => setQuoteTokens((q) => (e.target.checked ? [...q, address] : q.filter((x) => x !== address)))}
                    />
                    {t.symbol}
                  </label>
                ))}
              </div>
            </Field>
            <Field label="Quotes close in (hours)"><input value={quoteHours} onChange={(e) => setQuoteHours(e.target.value)} className={input} inputMode="decimal" /></Field>
          </>
        ) : (
          <>
            <Field label="Reward token">
              <select value={token} onChange={(e) => setToken(e.target.value)} className={input}>
                {rewardTokens.map(([address, t]) => <option key={address} value={address}>{t.symbol}</option>)}
              </select>
            </Field>
            <Field label="Reward"><input value={reward} onChange={(e) => setReward(e.target.value)} className={input} inputMode="decimal" /></Field>
          </>
        )}
        <Field label="Your bond (FACTORY)"><input value={creatorBond} onChange={(e) => setCreatorBond(e.target.value)} className={input} inputMode="decimal" /></Field>
        {mode !== 'contest' && <Field label="Worker bond (FACTORY)"><input value={workerBond} onChange={(e) => setWorkerBond(e.target.value)} className={input} inputMode="decimal" /></Field>}
        <Field label="Delivery within (hours)"><input value={deliveryHours} onChange={(e) => setDeliveryHours(e.target.value)} className={input} inputMode="decimal" /></Field>
        {mode === 'contest' && <Field label="Award within (hours)" hint="Must end before the delivery window; unawarded, the prize and your bond come back."><input value={selectionHours} onChange={(e) => setSelectionHours(e.target.value)} className={input} inputMode="decimal" /></Field>}
        <div className="rounded border border-neutral-200 p-3 sm:col-span-2">
          <span className="text-sm font-medium">Accepted deliverables</span>
          <p className="mt-1 text-xs text-neutral-500">
            Workers host the work themselves (their own fork on any git host, IPFS, a server, the chain); the board only records where it is and checks it once.
          </p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {DELIVERABLE_KINDS.map(({ kind, label }) => (
              <label key={kind} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={accepts.includes(kind)}
                  onChange={(e) =>
                    setAccepts((a) => DELIVERABLE_KINDS.map((k) => k.kind).filter((k) => (k === kind ? e.target.checked : a.includes(k))))
                  }
                />
                {label}
              </label>
            ))}
          </div>
          <div className="mt-2">
            <Field label="Where you want it (optional)" hint='e.g. "PR-able against github.com/o/r at main" or "an mp4 on IPFS".'>
              <input value={target} onChange={(e) => setTarget(e.target.value)} className={input} />
            </Field>
          </div>
        </div>
        {accepts.includes('git') && (
          <Field label="Required GitHub check" hint="Evidence must cover this check on the submitted SHA."><input value={check} onChange={(e) => setCheck(e.target.value)} className={input} /></Field>
        )}
        {mode === 'hire' && (
          <div className="rounded border border-neutral-200 p-3 sm:col-span-2">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" checked={budgetOn} onChange={(e) => setBudgetOn(e.target.checked)} />
              Execution budget for running costs (optional)
            </label>
            <p className="mt-1 text-xs text-neutral-500">
              Apart from the reward, the worker may spend up to this much from your wallet (model calls, compute), until the delivery deadline. Nothing is escrowed; you grant it on the job page with an email/Google (Privy) wallet and can revoke it any time.
            </p>
            {budgetOn && (
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <Field
                    label="Kind"
                    hint={
                      budgetKind === 'x402'
                        ? 'The worker pays x402 endpoints (paid APIs, data, tools) in USDC from your wallet; the board signs each payment only within the caps and the facilitator pays the gas.'
                        : budgetKind === 'call'
                        ? 'The worker calls one contract function from your wallet, so you are the sender and own what it makes (e.g. a nad.fun token). The cap bounds the MON it may send in total; you pay the gas.'
                        : 'The worker pays running costs in a token, to anyone.'
                    }
                  >
                    <select value={budgetKind} onChange={(e) => setBudgetKind(e.target.value as 'token' | 'call' | 'x402')} className={input}>
                      <option value="token">running costs (token transfers)</option>
                      {deployment.x402 !== null && <option value="x402">paid APIs and tools (x402, USDC)</option>}
                      <option value="call">{isMainnet ? 'one contract call from my wallet' : 'launch on nad.fun from my wallet (contract call)'}</option>
                    </select>
                  </Field>
                </div>
              </div>
            )}
            {budgetOn && budgetKind === 'call' && (
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <Field label="Contract"><input value={callTarget} onChange={(e) => setCallTarget(e.target.value)} className={`${input} font-mono`} /></Field>
                <Field label="Cap (MON)" hint={isMainnet ? 'The total MON the calls may send.' : 'nad.fun charges a 10 MON deploy fee on testnet.'}>
                  <input value={callCap} onChange={(e) => setCallCap(e.target.value)} className={input} inputMode="decimal" />
                </Field>
                <div className="sm:col-span-2">
                  <Field label="Allowed function" hint="Exactly one function, in human-readable ABI form.">
                    <input value={callFunction} onChange={(e) => setCallFunction(e.target.value)} className={`${input} font-mono text-xs`} />
                  </Field>
                </div>
              </div>
            )}
            {budgetOn && budgetKind === 'x402' && (
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <Field label="Total (USDC)"><input value={x402Cap} onChange={(e) => setX402Cap(e.target.value)} className={input} inputMode="decimal" /></Field>
                <Field label="Per payment (USDC)" hint="The most one x402 payment may be."><input value={x402PerCall} onChange={(e) => setX402PerCall(e.target.value)} className={input} inputMode="decimal" /></Field>
              </div>
            )}
            {budgetOn && budgetKind === 'token' && (
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <Field label="Budget token">
                  <select value={budgetToken} onChange={(e) => setBudgetToken(e.target.value)} className={input}>
                    {rewardTokens.map(([address, t]) => <option key={address} value={address}>{t.symbol}</option>)}
                  </select>
                </Field>
                <Field label="Cap"><input value={budgetCap} onChange={(e) => setBudgetCap(e.target.value)} className={input} inputMode="decimal" /></Field>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Button busy={busy} disabled={title.trim() === '' || brief.trim() === '' || (mode === 'quotes' && quoteTokens.length === 0) || accepts.length === 0} onClick={submit}>
          {mode === 'quotes' ? 'Ask for quotes' : 'Freeze offer and screen'}
        </Button>
        {error !== null && <span className="text-xs text-red-600">{error}</span>}
      </div>
    </Card>
  )
}
