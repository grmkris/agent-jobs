import * as sdk from '@agent-jobs/sdk'
import { useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { type Abi, type Address, type Hex, isAddress, zeroAddress } from 'viem'
import { useReadContracts } from 'wagmi'
import type { TxRequest } from '../api.ts'
import { PrivyLogin } from '../components/Privy.tsx'
import { useToast } from '../components/Sheet.tsx'
import { Countdown, When, useNow } from '../components/Time.tsx'
import { TxSteps } from '../components/TxSteps.tsx'
import { Address as AddressText, Badge, Button, EmptyState, ErrorText, Group, Input, ListRow, LoadingRows, PageTitle, Section } from '../components/ui.tsx'
import { useAuth } from '../components/Wallet.tsx'
import { formatNumber } from '../format.ts'
import { resizeProblem, rootProblem, scheduleProposal } from '../admin.ts'
import { type HirelingContracts, hireling } from '../hireling.ts'
import { type Call, calldata, describe, execTransaction, safeAbi } from '../safe.ts'
import { factoryAmount, percent, proposalState } from '../stake.ts'
import { chain, deployment } from '../wallet.ts'

const fmt = (wei: bigint) => `${formatNumber(wei, 18)} FACTORY`
const same = (a: string | undefined, b: string | undefined) => a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase()
const result = <T,>(data: ReadonlyArray<{ status: string; result?: unknown }> | undefined, i: number): T | undefined => (data?.[i]?.status === 'success' ? (data[i]?.result as T) : undefined)

/**
 * Whether `address` owns the Safe that owns Hireling v1: null while unknown (not deployed, not configured, loading or
 * unreadable), so a caller shows nothing rather than guessing.
 */
export function useSafeOwner(address: string | undefined): boolean | null {
  const safe = hireling?.safe ?? null
  const owners = useReadContracts({
    contracts: [{ address: safe ?? zeroAddress, abi: safeAbi, functionName: 'getOwners', chainId: chain.id }],
    query: { enabled: safe !== null && address !== undefined, staleTime: 60_000 },
  })
  const list = result<readonly Address[]>(owners.data, 0)
  if (safe === null || address === undefined || list === undefined) return null
  return list.some((o) => same(o, address))
}

type Via = 'safe' | 'direct'
/** One call, built and decoded before the wallet opens. */
interface Step {
  contract: string
  to: Address
  functionName: string
  args: Array<[string, string]>
  via: Via
  tx: TxRequest
}
/** What the page will send, kept until it is done: one call, or calls that go together in order. */
interface Op {
  title: string
  steps: Step[]
}
const opKey = (me: string) => `hireling.admin-op:${me.toLowerCase()}`
function loadOp(me: string): Op | null {
  try {
    const op = JSON.parse(localStorage.getItem(opKey(me)) ?? 'null') as Op | null
    return op !== null && Array.isArray(op.steps) ? op : null
  } catch {
    return null
  }
}
function saveOp(me: string, op: Op | null) {
  try {
    if (op === null) localStorage.removeItem(opKey(me))
    else localStorage.setItem(opKey(me), JSON.stringify(op))
  } catch {
    // storage blocked: the operation lasts as long as the page
  }
}

/**
 * `act(title, call, via, ...then)`: show a call for review, with any calls that must follow it in the same send (one
 * wallet transaction when the wallet batches, else in order); `busy` while one is under review or being sent.
 */
type Act = (title: string, call: Call, via: Via, ...then: ReadonlyArray<readonly [Call, Via]>) => void

/**
 * The Safe's console (ADR-0011). Shown only to an owner of the Safe that owns Hireling v1; the Safe's threshold is 1,
 * so the owner's wallet calls `execTransaction` itself with a pre-validated signature. Every action shows the exact
 * call, decoded from the calldata that will be sent, before the wallet opens. Permissionless steps (executing a fee
 * schedule, accepting a Holding after its delay) go straight from the wallet.
 */
export function AdminPage() {
  const auth = useAuth()
  const c = hireling
  if (c === null) {
    return (
      <>
        <PageTitle>Admin</PageTitle>
        <EmptyState title={`Hireling v1 is not on ${chain.name} yet`}>The admin console opens once its contracts are deployed on this network.</EmptyState>
      </>
    )
  }
  if (c.safe === null) {
    return (
      <>
        <PageTitle>Admin</PageTitle>
        <EmptyState title="The Safe is not recorded for this network">The deployment config does not name the Safe that owns Hireling v1, so nobody can act as it here.</EmptyState>
      </>
    )
  }
  if (auth.address === undefined) {
    return (
      <>
        <PageTitle>Admin</PageTitle>
        <section className="grid gap-4 rounded-2xl bg-surface p-5 shadow-float">
          <h2 className="font-display text-[1.4rem] leading-tight font-bold tracking-[-0.02em]">Sign in as a Safe owner</h2>
          <div>
            <PrivyLogin />
          </div>
        </section>
      </>
    )
  }
  return <Gate c={c} safe={c.safe} me={auth.address as Address} />
}

function Gate({ c, safe, me }: { c: HirelingContracts; safe: Address; me: Address }) {
  const reads = useReadContracts({
    contracts: [
      { address: safe, abi: safeAbi, functionName: 'getOwners', chainId: chain.id },
      { address: safe, abi: safeAbi, functionName: 'getThreshold', chainId: chain.id },
    ],
    query: { refetchInterval: 30_000 },
  })
  const owners = result<readonly Address[]>(reads.data, 0)
  const threshold = result<bigint>(reads.data, 1)
  if (reads.isLoading) return <><PageTitle>Admin</PageTitle><LoadingRows rows={3} /></>
  if (owners === undefined || threshold === undefined) {
    return (
      <>
        <PageTitle>Admin</PageTitle>
        <div role="status" className="grid gap-2 rounded-xl bg-warn-bg p-4 text-[0.9rem] text-warn">
          <p>The Safe's owners cannot be read from the chain right now.</p>
          <Button variant="tinted" onClick={() => void reads.refetch()}>Retry</Button>
        </div>
      </>
    )
  }
  if (!owners.some((o) => same(o, me))) {
    return (
      <>
        <PageTitle>Admin</PageTitle>
        <EmptyState title="Only the Safe's owners see this">This wallet is not an owner of the Safe that owns Hireling v1.</EmptyState>
      </>
    )
  }
  if (threshold !== 1n) {
    return (
      <>
        <PageTitle>Admin</PageTitle>
        <EmptyState title={`The Safe needs ${threshold} signatures`}>This console sends as a single owner (threshold 1). With a higher threshold, use the Safe's own app.</EmptyState>
      </>
    )
  }
  return <Admin c={c} safe={safe} me={me} />
}

function Admin({ c, safe, me }: { c: HirelingContracts; safe: Address; me: Address }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [op, setOpState] = useState<Op | null>(() => loadOp(me))
  const [dismissable, setDismissable] = useState(true)
  const setOp = (next: Op | null) => {
    saveOp(me, next)
    setOpState(next)
  }
  const step = (call: Call, via: Via): Step => {
    const data = calldata(call)
    const { functionName, args } = describe(call.abi, data)
    const tx: TxRequest = via === 'safe'
      ? { description: `${call.contract}.${functionName} as the Safe`, chainId: chain.id, to: safe, data: execTransaction(me, { to: call.to, data }), value: '0' }
      : { description: `${call.contract}.${functionName}`, chainId: chain.id, to: call.to, data, value: '0' }
    return { contract: call.contract, to: call.to, functionName, args, via, tx }
  }
  const act: Act = (title, call, via, ...then) => {
    setOp({ title, steps: [step(call, via), ...then.map(([next, nextVia]) => step(next, nextVia))] })
    window.scrollTo({ top: 0 })
  }
  const busy = op !== null
  return (
    <>
      <PageTitle sub={<>Acting as the Safe <AddressText value={safe} /> · threshold 1</>}>Admin</PageTitle>
      {op !== null && (
        <Section title="Review and send" note="This is exactly what your wallet will send, decoded from its calldata.">
          <Review op={op} safe={safe} />
          <div className="mt-3">
            <TxSteps
              key={op.steps.map((x) => x.tx.data).join()}
              taskId={`admin:${me.toLowerCase()}`}
              txs={op.steps.map((x) => x.tx)}
              owner={me}
              reportToBoard={false}
              onSafeToRestartChange={setDismissable}
              onDone={() => {
                const title = op.title
                setOp(null)
                void qc.invalidateQueries()
                toast(`${title}: done`)
              }}
            />
          </div>
          {dismissable && (
            <Button variant="plain" size="sm" className="mt-2 justify-self-center" onClick={() => setOp(null)}>
              Not now
            </Button>
          )}
        </Section>
      )}
      <Ownership c={c} safe={safe} act={act} busy={busy} />
      <Core c={c} safe={safe} act={act} busy={busy} />
      <Fees c={c} act={act} busy={busy} />
      <Holdings c={c} act={act} busy={busy} />
      <Mining c={c} act={act} busy={busy} />
    </>
  )
}

function Review({ op, safe }: { op: Op; safe: Address }) {
  return (
    <div className="grid gap-3 rounded-xl bg-surface px-4 py-3.5">
      <p className="font-semibold">{op.title}</p>
      {op.steps.length > 1 && <p className="text-[0.88rem] text-label-2">{op.steps.length} calls, sent together in this order.</p>}
      {op.steps.map((step, i) => (
        <StepReview key={step.tx.data} step={step} safe={safe} n={op.steps.length > 1 ? i + 1 : null} />
      ))}
    </div>
  )
}

function StepReview({ step, safe, n }: { step: Step; safe: Address; n: number | null }) {
  const outer = step.via === 'safe' ? describe(safeAbi as unknown as Abi, step.tx.data as Hex).args.filter(([name]) => name !== 'data') : null
  return (
    <div className="grid gap-3">
      {n !== null && <p className="text-[0.8rem] font-semibold tracking-wide text-label-2 uppercase">Call {n}</p>}
      <Group className="bg-bg">
        <KV k="Contract" stack>
          {step.contract} <code className="font-mono text-[0.82rem] break-all">{step.to}</code>
        </KV>
        <KV k="Function" stack>
          <code className="font-mono text-[0.85rem]">{step.functionName}({step.args.map(([name]) => name).join(', ')})</code>
        </KV>
        {step.args.map(([name, value]) => (
          <KV key={name} k={name} stack>
            <code className="font-mono text-[0.82rem] break-all">{value}</code>
          </KV>
        ))}
      </Group>
      {outer !== null ? (
        <>
          <p className="text-[0.88rem] text-label-2">
            Sent as the Safe <AddressText value={safe} />: your wallet calls its <code className="font-mono">execTransaction</code> with your owner signature (r = you, s = 0, v = 1).
          </p>
          <Group className="bg-bg">
            {outer.map(([name, value]) => (
              <KV key={name} k={name} stack>
                <code className="font-mono text-[0.82rem] break-all">{name === 'operation' && value === '0' ? '0 (call)' : value}</code>
              </KV>
            ))}
          </Group>
        </>
      ) : (
        <p className="text-[0.88rem] text-label-2">Anyone may send this call; it goes straight from your wallet, not through the Safe.</p>
      )}
    </div>
  )
}

/** A labelled value; `stack` puts the label above, for long values (hex, structs) that must stay whole. */
function KV({ k, children, stack = false }: { k: string; children: ReactNode; stack?: boolean }) {
  if (stack) {
    return (
      <ListRow>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="text-[0.8rem] text-label-2">{k}</span>
          <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
        </span>
      </ListRow>
    )
  }
  return (
    <ListRow>
      <span className="w-32 shrink-0 text-[0.85rem] text-label-2">{k}</span>
      <span className="min-w-0 flex-1 text-right [overflow-wrap:anywhere]">{children}</span>
    </ListRow>
  )
}

function Unavailable({ retry }: { retry: () => void }) {
  return (
    <div role="status" className="grid gap-2 rounded-xl bg-warn-bg p-4 text-[0.9rem] text-warn">
      <p>These facts cannot be read from the chain right now.</p>
      <Button variant="tinted" onClick={retry}>Retry</Button>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Ownership: every Ownable2Step contract should be owned by the Safe; right after deploy it is pending and the Safe
// accepts. The first admin smoke test.
// ---------------------------------------------------------------------------------------------------------------

function Ownership({ c, safe, act, busy }: { c: HirelingContracts; safe: Address; act: Act; busy: boolean }) {
  const owned: Array<[string, Address, Abi]> = [
    ['FeeSchedule', c.feeSchedule, sdk.feeScheduleAbi],
    ['StakeVault', c.vault, sdk.stakeVaultAbi],
    ['HirelingHolding', c.holding, sdk.hirelingHoldingAbi],
    ['HirelingEvaluator', c.evaluator, sdk.hirelingEvaluatorAbi],
    ['MiningReserve', c.miningReserve, sdk.miningReserveAbi],
    ['EpochDistributor', c.distributor, sdk.epochDistributorAbi],
  ]
  const reads = useReadContracts({
    contracts: owned.flatMap(([, address, abi]) => [
      { address, abi, functionName: 'owner', chainId: chain.id },
      { address, abi, functionName: 'pendingOwner', chainId: chain.id },
    ]),
    query: { refetchInterval: 30_000 },
  })
  return (
    <Section title="Ownership" note="Each contract is owned by the Safe. After a deploy or a handover, the Safe accepts each one here.">
      {reads.isError ? (
        <Unavailable retry={() => void reads.refetch()} />
      ) : (
        <Group>
          {owned.map(([name, address, abi], i) => {
            const owner = result<Address>(reads.data, i * 2)
            const pending = result<Address>(reads.data, i * 2 + 1)
            return (
              <ListRow key={name}>
                <span className="min-w-0 flex-1">
                  {name}
                  <span className="block text-[0.78rem] text-label-3"><AddressText value={address} /></span>
                </span>
                {owner === undefined ? (
                  <span className="text-label-3">—</span>
                ) : same(owner, safe) ? (
                  <Badge tone="success">Safe owns it</Badge>
                ) : same(pending, safe) ? (
                  <Button size="sm" disabled={busy} onClick={() => act(`Accept ownership of ${name}`, { contract: name, to: address, abi, functionName: 'acceptOwnership' }, 'safe')}>
                    Accept ownership
                  </Button>
                ) : (
                  <span className="grid justify-items-end gap-0.5 text-[0.8rem]">
                    <Badge tone="attention">Not the Safe</Badge>
                    <AddressText value={owner} />
                  </span>
                )}
              </ListRow>
            )
          })}
        </Group>
      )}
    </Section>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Core: pause and unpause (ADMIN_ROLE). On testnet the core is reused and its admin may not be the Safe.
// ---------------------------------------------------------------------------------------------------------------

function Core({ c, safe, act, busy }: { c: HirelingContracts; safe: Address; act: Act; busy: boolean }) {
  const core = deployment.core
  const base = useReadContracts({
    contracts: [
      { address: core, abi: sdk.coreAbi, functionName: 'paused', chainId: chain.id },
      { address: core, abi: sdk.coreAbi, functionName: 'ADMIN_ROLE', chainId: chain.id },
      { address: c.evaluator, abi: sdk.hirelingEvaluatorAbi, functionName: 'pauseCount', chainId: chain.id },
    ],
    query: { refetchInterval: 30_000 },
  })
  const paused = result<boolean>(base.data, 0)
  const role = result<Hex>(base.data, 1)
  const count = result<bigint>(base.data, 2)
  // The Evaluator's pause history is append-only (C9-007): the latest interval is open while its end is 0.
  const latest = useReadContracts({
    contracts: [{ address: c.evaluator, abi: sdk.hirelingEvaluatorAbi, functionName: 'pauseAt', args: [count !== undefined && count > 0n ? count - 1n : 0n], chainId: chain.id }],
    query: { enabled: count !== undefined && count > 0n, refetchInterval: 30_000 },
  })
  const interval = result<{ start: number; end: number }>(latest.data, 0)
  const admin = useReadContracts({
    contracts: [{ address: core, abi: sdk.coreAbi, functionName: 'hasRole', args: [role ?? `0x${'0'.repeat(64)}`, safe], chainId: chain.id }],
    query: { enabled: role !== undefined },
  })
  const safeIsAdmin = result<boolean>(admin.data, 0)
  const call = (functionName: 'pause' | 'unpause'): Call => ({ contract: 'Core', to: core, abi: sdk.coreAbi as unknown as Abi, functionName })
  // D4b: the Evaluator records the pause, so a delivery deadline that falls inside it is never slashed. It goes in the
  // same send as the pause or unpause; anyone may also send it alone when the two have drifted apart.
  const note: Call = { contract: 'HirelingEvaluator', to: c.evaluator, abi: sdk.hirelingEvaluatorAbi as unknown as Abi, functionName: 'notePause' }
  const noted = count === undefined ? undefined : count === 0n ? false : interval === undefined ? undefined : Number(interval.end) === 0
  const drift = paused !== undefined && noted !== undefined && paused !== noted
  return (
    <Section title="Core" note="Pausing stops every call on the job core: nothing can be funded, delivered or paid. The Evaluator notes the pause in the same send, so a delivery deadline inside it is never slashed.">
      {base.isError || admin.isError || latest.isError ? (
        <Unavailable retry={() => void Promise.all([base.refetch(), admin.refetch(), latest.refetch()])} />
      ) : (
        <div className="grid gap-3 rounded-xl bg-surface px-4 py-3.5">
          <p className="flex flex-wrap items-center gap-2">
            {paused === undefined ? '—' : paused ? <Badge tone="danger">Paused</Badge> : <Badge tone="success">Running</Badge>}
            <span className="text-[0.85rem] text-label-2"><AddressText value={core} /></span>
          </p>
          {drift && (
            <div className="grid gap-2 rounded-xl bg-warn-bg p-3 text-[0.88rem] text-warn">
              <p>
                {paused
                  ? 'The Evaluator has not noted this pause: a worker whose delivery deadline falls inside it could be slashed.'
                  : 'The Evaluator still counts the core as paused.'}
              </p>
              <Button variant="tinted" size="sm" disabled={busy} onClick={() => act(paused ? 'Note the pause on the Evaluator' : 'Note the unpause on the Evaluator', note, 'direct')}>
                {paused ? 'Note the pause' : 'Note the unpause'}
              </Button>
            </div>
          )}
          {safeIsAdmin === false ? (
            <p className="text-[0.88rem] text-label-2">The Safe is not the core's admin on this network, so it cannot pause it from here.</p>
          ) : (
            <Button
              variant={paused === true ? 'primary' : 'danger'}
              disabled={busy || paused === undefined || safeIsAdmin !== true}
              onClick={() => act(paused === true ? 'Unpause the core' : 'Pause the core', call(paused === true ? 'unpause' : 'pause'), 'safe', [note, 'safe'])}
            >
              {paused === true ? 'Unpause the core' : 'Pause the core'}
            </Button>
          )}
        </div>
      )}
    </Section>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// FeeSchedule: propose, then anyone executes after the 3-day delay; the Safe can cancel.
// ---------------------------------------------------------------------------------------------------------------

type Schedule = { thresholds: readonly bigint[]; bps: readonly number[]; treasury: Address }

function Fees({ c, act, busy }: { c: HirelingContracts; act: Act; busy: boolean }) {
  const now = useNow()
  const reads = useReadContracts({
    contracts: [
      { address: c.feeSchedule, abi: sdk.feeScheduleAbi, functionName: 'schedule', chainId: chain.id },
      { address: c.feeSchedule, abi: sdk.feeScheduleAbi, functionName: 'pending', chainId: chain.id },
      { address: c.feeSchedule, abi: sdk.feeScheduleAbi, functionName: 'DELAY', chainId: chain.id },
      { address: c.feeSchedule, abi: sdk.feeScheduleAbi, functionName: 'MAX_BPS', chainId: chain.id },
      { address: c.feeSchedule, abi: sdk.feeScheduleAbi, functionName: 'PROPOSAL_GRACE', chainId: chain.id },
    ],
    query: { refetchInterval: 30_000 },
  })
  const current = result<Schedule>(reads.data, 0)
  const pendingRead = result<readonly [Schedule, number]>(reads.data, 1)
  const delay = result<number>(reads.data, 2)
  const maxBps = result<number>(reads.data, 3)
  const feeGrace = result<number>(reads.data, 4)
  const pending = pendingRead !== undefined && Number(pendingRead[1]) !== 0 ? { ...pendingRead[0], eta: Number(pendingRead[1]) } : null
  const [draft, setDraft] = useState<{ thresholds: string[]; rates: string[]; treasury: string } | null>(null)
  const form = draft ?? (current === undefined ? null : {
    thresholds: current.thresholds.map((t) => formatNumber(t, 18).replaceAll(',', '')),
    rates: current.bps.map((b) => String(b / 100)),
    treasury: current.treasury,
  })
  const proposal = form === null || maxBps === undefined ? null : scheduleProposal(form, Number(maxBps))
  const fee = (call: Omit<Call, 'contract' | 'to' | 'abi'>): Call => ({ contract: 'FeeSchedule', to: c.feeSchedule, abi: sdk.feeScheduleAbi, ...call })
  const days = delay === undefined ? '3 days' : `${Number(delay) / 86_400} days`

  return (
    <Section title="Fee schedule" note={`A change takes effect ${days} after it is proposed, when anyone executes it. Jobs keep the rate they were activated with.`}>
      {reads.isError ? (
        <Unavailable retry={() => void reads.refetch()} />
      ) : current === undefined ? (
        <LoadingRows rows={2} />
      ) : (
        <div className="grid gap-3">
          <ScheduleTable title="In force" schedule={current} />
          {pending !== null && (
            <div className="grid gap-2 rounded-xl bg-tint/10 px-4 py-3.5">
              <ScheduleTable title="Proposed" schedule={pending} />
              <Expiry eta={pending.eta} now={now} grace={feeGrace} verb="Executable" />
              <div className="flex flex-wrap gap-2">
                <Button className="flex-1" disabled={busy || feeGrace === undefined || proposalState(pending.eta, now, Number(feeGrace)) !== 'open'} onClick={() => act('Execute the proposed fee schedule', fee({ functionName: 'execute' }), 'direct')}>
                  Execute
                </Button>
                <Button variant="danger" className="flex-1" disabled={busy} onClick={() => act('Cancel the proposed fee schedule', fee({ functionName: 'cancel' }), 'safe')}>
                  Cancel proposal
                </Button>
              </div>
            </div>
          )}
          {form !== null && (
            <form
              className="grid gap-3 rounded-xl bg-surface px-4 py-3.5"
              onSubmit={(e) => {
                e.preventDefault()
                if (proposal === null || typeof proposal === 'string') return
                act('Propose a new fee schedule', fee({ functionName: 'propose', args: [proposal] }), 'safe')
              }}
            >
              <p className="font-semibold">Propose a schedule</p>
              {form.thresholds.map((t, i) => (
                <div key={i} className="grid grid-cols-[1fr_6rem] items-end gap-2">
                  <label className="grid gap-1">
                    <span className="text-[0.8rem] text-label-2">Tier {i + 1} from (FACTORY)</span>
                    <Input aria-label={`Tier ${i + 1} threshold`} value={t} inputMode="decimal" className="tabular" onChange={(e) => setDraft({ ...form, thresholds: form.thresholds.map((x, j) => (j === i ? e.target.value : x)) })} />
                  </label>
                  <label className="grid gap-1">
                    <span className="text-[0.8rem] text-label-2">Fee %</span>
                    <Input aria-label={`Tier ${i + 1} fee`} value={form.rates[i] ?? ''} inputMode="decimal" className="tabular" onChange={(e) => setDraft({ ...form, rates: form.rates.map((x, j) => (j === i ? e.target.value : x)) })} />
                  </label>
                </div>
              ))}
              <label className="grid gap-1">
                <span className="text-[0.8rem] text-label-2">Treasury (receives fees)</span>
                <Input aria-label="Treasury" value={form.treasury} className="font-mono text-[0.85rem]" onChange={(e) => setDraft({ ...form, treasury: e.target.value })} />
              </label>
              {typeof proposal === 'string' && <ErrorText>{proposal}</ErrorText>}
              <Button type="submit" disabled={busy || proposal === null || typeof proposal === 'string'}>
                Review the proposal
              </Button>
            </form>
          )}
        </div>
      )}
    </Section>
  )
}

/** When a timelocked proposal can be executed, and when it lapses (the contract's `PROPOSAL_GRACE()` after its eta). */
function Expiry({ eta, now, grace, verb }: { eta: number; now: number; grace: number | undefined; verb: string }) {
  if (grace === undefined) return <p className="text-[0.88rem] text-label-2">{now < eta ? <>{verb} in <Countdown to={eta} /> · <When at={eta} show="time" />.</> : 'When it lapses cannot be read right now.'}</p>
  const state = proposalState(eta, now, Number(grace))
  const lapses = eta + Number(grace)
  return (
    <p className="text-[0.88rem] text-label-2">
      {state === 'waiting' ? (
        <>{verb} in <Countdown to={eta} /> · <When at={eta} show="time" />. Expires at <When at={lapses} show="time" />.</>
      ) : state === 'open' ? (
        <>{verb} now, by anyone, until <When at={lapses} show="time" /> (<Countdown to={lapses} /> left).</>
      ) : (
        <span className="text-warn">Expired at <When at={lapses} show="time" />: the contract refuses it now. Cancel it, or propose again.</span>
      )}
    </p>
  )
}

function ScheduleTable({ title, schedule }: { title: string; schedule: Schedule }) {
  return (
    <div className="grid gap-1">
      <p className="px-1 text-[0.8rem] text-label-2">{title}</p>
      <Group>
        {schedule.thresholds.map((t, i) => (
          <ListRow key={i}>
            <span className="tabular flex-1">{i === 0 ? 'Any stake' : `From ${fmt(t)}`}</span>
            <span className="tabular">{percent(schedule.bps[i] ?? 0)}</span>
          </ListRow>
        ))}
        <ListRow>
          <span className="flex-1 text-label-2">Treasury</span>
          <AddressText value={schedule.treasury} />
        </ListRow>
      </Group>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// StakeVault Holdings: the Safe proposes, anyone accepts after 8 days (longer than the unstake cooldown), the Safe
// revokes instantly.
// ---------------------------------------------------------------------------------------------------------------

function Holdings({ c, act, busy }: { c: HirelingContracts; act: Act; busy: boolean }) {
  const now = useNow()
  const reads = useReadContracts({
    contracts: [
      { address: c.vault, abi: sdk.stakeVaultAbi, functionName: 'bootstrapped', chainId: chain.id },
      { address: c.vault, abi: sdk.stakeVaultAbi, functionName: 'pendingHolding', chainId: chain.id },
      { address: c.vault, abi: sdk.stakeVaultAbi, functionName: 'HOLDING_DELAY', chainId: chain.id },
      { address: c.vault, abi: sdk.stakeVaultAbi, functionName: 'isHolding', args: [c.holding], chainId: chain.id },
      { address: c.vault, abi: sdk.stakeVaultAbi, functionName: 'PROPOSAL_GRACE', chainId: chain.id },
    ],
    query: { refetchInterval: 30_000 },
  })
  const bootstrapped = result<boolean>(reads.data, 0)
  const pendingRead = result<readonly [Address, number]>(reads.data, 1)
  const delay = result<number>(reads.data, 2)
  const active = result<boolean>(reads.data, 3)
  const vaultGrace = result<number>(reads.data, 4)
  const pending = pendingRead !== undefined && !same(pendingRead[0], zeroAddress) ? { holding: pendingRead[0], eta: Number(pendingRead[1]) } : null
  const [proposed, setProposed] = useState('')
  const [revoked, setRevoked] = useState<string>(c.holding)
  const vault = (call: Omit<Call, 'contract' | 'to' | 'abi'>): Call => ({ contract: 'StakeVault', to: c.vault, abi: sdk.stakeVaultAbi, ...call })
  const days = delay === undefined ? '8 days' : `${Number(delay) / 86_400} days`
  const valid = (a: string) => isAddress(a.trim(), { strict: false }) && !same(a.trim(), zeroAddress)

  return (
    <Section title="Stake vault Holdings" note={`Only an authorized Holding can reserve bonds from stake. A proposed Holding can be accepted ${days} after it is proposed, longer than the unstaking cooldown, so every staker can leave or refuse it first.`}>
      {reads.isError ? (
        <Unavailable retry={() => void reads.refetch()} />
      ) : bootstrapped === undefined ? (
        <LoadingRows rows={2} />
      ) : (
        <div className="grid gap-3">
          <Group>
            <ListRow>
              <span className="min-w-0 flex-1">
                v1 Holding
                <span className="block text-[0.78rem] text-label-3"><AddressText value={c.holding} /></span>
              </span>
              {active === true ? <Badge tone="success">Authorized</Badge> : <Badge tone="attention">Not authorized</Badge>}
            </ListRow>
            <ListRow>
              <span className="flex-1">Staking</span>
              {bootstrapped ? <Badge tone="success">Open</Badge> : <Badge tone="attention">Closed until a first Holding</Badge>}
            </ListRow>
          </Group>
          {pending !== null && (
            <div className="grid gap-2 rounded-xl bg-tint/10 px-4 py-3.5">
              <p className="text-[0.92rem]">Proposed Holding <AddressText value={pending.holding} /></p>
              <Expiry eta={pending.eta} now={now} grace={vaultGrace} verb="Acceptable" />
              <div className="flex flex-wrap gap-2">
                <Button className="flex-1" disabled={busy || vaultGrace === undefined || proposalState(pending.eta, now, Number(vaultGrace)) !== 'open'} onClick={() => act('Accept the proposed Holding', vault({ functionName: 'acceptHolding' }), 'direct')}>
                  Accept
                </Button>
                <Button variant="danger" className="flex-1" disabled={busy} onClick={() => act('Cancel the Holding proposal', vault({ functionName: 'cancelHoldingProposal' }), 'safe')}>
                  Cancel proposal
                </Button>
              </div>
            </div>
          )}
          <form
            className="grid gap-2 rounded-xl bg-surface px-4 py-3.5"
            onSubmit={(e) => {
              e.preventDefault()
              if (valid(proposed)) act('Propose a Holding', vault({ functionName: 'proposeHolding', args: [proposed.trim()] }), 'safe')
            }}
          >
            <label className="grid gap-1">
              <span className="text-[0.85rem] font-semibold">Propose a Holding</span>
              <Input aria-label="Holding to propose" value={proposed} placeholder="0x… Holding contract" className="font-mono text-[0.85rem]" onChange={(e) => setProposed(e.target.value)} />
            </label>
            <Button type="submit" disabled={busy || !valid(proposed)}>Review the proposal</Button>
          </form>
          <form
            className="grid gap-2 rounded-xl bg-surface px-4 py-3.5"
            onSubmit={(e) => {
              e.preventDefault()
              if (valid(revoked)) act('Revoke a Holding', vault({ functionName: 'revokeHolding', args: [revoked.trim()] }), 'safe')
            }}
          >
            <label className="grid gap-1">
              <span className="text-[0.85rem] font-semibold">Revoke a Holding</span>
              <span className="text-[0.82rem] text-label-2">Instant. It can no longer reserve bonds; its live jobs still release and slash what they reserved.</span>
              <Input aria-label="Holding to revoke" value={revoked} className="font-mono text-[0.85rem]" onChange={(e) => setRevoked(e.target.value)} />
            </label>
            <Button type="submit" variant="danger" disabled={busy || !valid(revoked)}>Review the revocation</Button>
          </form>
        </div>
      )}
    </Section>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Mining: after an epoch ends, the Safe posts its Merkle root and funds it from the reserve.
// ---------------------------------------------------------------------------------------------------------------

type EpochRoot = { root: Hex; total: bigint; claimed: bigint; dataHash: Hex }

function Mining({ c, act, busy }: { c: HirelingContracts; act: Act; busy: boolean }) {
  const now = useNow()
  const base = useReadContracts({
    contracts: [
      { address: c.miningReserve, abi: sdk.miningReserveAbi, functionName: 'currentEpoch', chainId: chain.id },
      { address: c.miningReserve, abi: sdk.miningReserveAbi, functionName: 'totalFunded', chainId: chain.id },
      { address: c.distributor, abi: sdk.epochDistributorAbi, functionName: 'available', chainId: chain.id },
      { address: c.distributor, abi: sdk.epochDistributorAbi, functionName: 'outstanding', chainId: chain.id },
    ],
    query: { refetchInterval: 30_000 },
  })
  const currentEpoch = result<bigint>(base.data, 0)
  const [picked, setPicked] = useState<string | null>(null)
  // The epoch to close: the last one that has ended.
  const epochText = picked ?? (currentEpoch === undefined ? '' : String(currentEpoch > 0n ? currentEpoch - 1n : 0n))
  const epoch = /^\d+$/.test(epochText) ? BigInt(epochText) : null
  const detail = useReadContracts({
    contracts: [
      { address: c.miningReserve, abi: sdk.miningReserveAbi, functionName: 'budget', args: [epoch ?? 0n], chainId: chain.id },
      { address: c.miningReserve, abi: sdk.miningReserveAbi, functionName: 'cumulativeBudget', args: [epoch ?? 0n], chainId: chain.id },
      { address: c.miningReserve, abi: sdk.miningReserveAbi, functionName: 'epochEnd', args: [epoch ?? 0n], chainId: chain.id },
      { address: c.distributor, abi: sdk.epochDistributorAbi, functionName: 'rootOf', args: [epoch ?? 0n], chainId: chain.id },
    ],
    query: { enabled: epoch !== null },
  })
  const budget = result<bigint>(detail.data, 0)
  const cumulative = result<bigint>(detail.data, 1)
  const end = result<bigint>(detail.data, 2)
  const root = result<EpochRoot>(detail.data, 3)
  const [form, setForm] = useState({ root: '', total: '', dataHash: '', fund: '', resize: '' })
  const problem = epoch === null ? 'Enter the epoch number.' : rootProblem({ epoch: epochText, ...form })
  const fundAmount = factoryAmount(form.fund)
  const ended = end !== undefined && Number(end) <= now
  const hasRoot = root !== undefined && root.root !== `0x${'0'.repeat(64)}`

  return (
    <Section title="Mining" note="After an epoch ends, the Safe posts its Merkle root (from the epoch's published data) and funds it from the reserve; then anyone claims, and claims are staked.">
      {base.isError || detail.isError ? (
        <Unavailable retry={() => void Promise.all([base.refetch(), detail.refetch()])} />
      ) : currentEpoch === undefined ? (
        <LoadingRows rows={2} />
      ) : (
        <div className="grid gap-3">
          <Group>
            <KV k="Current epoch">{String(currentEpoch)}</KV>
            <KV k="Funded so far">{fmt(result<bigint>(base.data, 1) ?? 0n)}</KV>
            <KV k="Distributor">{fmt(result<bigint>(base.data, 2) ?? 0n)} available · {fmt(result<bigint>(base.data, 3) ?? 0n)} owed</KV>
          </Group>
          <div className="grid gap-3 rounded-xl bg-surface px-4 py-3.5">
            <label className="grid gap-1">
              <span className="text-[0.85rem] font-semibold">Epoch</span>
              <Input aria-label="Epoch" value={epochText} inputMode="numeric" className="tabular w-28" onChange={(e) => setPicked(e.target.value)} />
            </label>
            {epoch !== null && (
              <Group className="bg-bg">
                <KV k="Ends">{end === undefined ? '—' : <When at={Number(end)} />}</KV>
                <KV k="Budget">{budget === undefined ? '—' : fmt(budget)}</KV>
                <KV k="Budget so far">{cumulative === undefined ? '—' : `${fmt(cumulative)} (unspent budget rolls over)`}</KV>
                <KV k="Root">{root === undefined ? '—' : hasRoot ? <code className="font-mono text-[0.8rem] break-all">{root.root}</code> : 'Not posted'}</KV>
                {hasRoot && <KV k="Claimed">{`${fmt(root.claimed)} of ${fmt(root.total)}`}</KV>}
              </Group>
            )}
            {epoch !== null && hasRoot && (
              <div className="grid gap-2 rounded-lg bg-fill px-3 py-2.5">
                <p className="text-[0.85rem] font-semibold">Correct the total</p>
                <p className="text-[0.82rem] text-label-2">
                  If the posted total is more than the root’s leaves add up to, the difference stays locked. Shrink it to the leaf sum from the epoch’s data; it can never go below what is already claimed.
                </p>
                <Input aria-label="New epoch total" value={form.resize} placeholder="Leaf sum, FACTORY" inputMode="decimal" className="tabular" onChange={(e) => setForm({ ...form, resize: e.target.value })} />
                {form.resize !== '' && resizeProblem(form.resize, root) !== null && <ErrorText>{resizeProblem(form.resize, root)}</ErrorText>}
                <Button
                  variant="tinted"
                  disabled={busy || resizeProblem(form.resize, root) !== null}
                  onClick={() => {
                    const total = factoryAmount(form.resize) ?? 0n
                    if (resizeProblem(form.resize, root) !== null) return
                    act(`Shrink the total of epoch ${epoch}`, { contract: 'EpochDistributor', to: c.distributor, abi: sdk.epochDistributorAbi, functionName: 'resizeRoot', args: [epoch, total] }, 'safe')
                  }}
                >
                  Review the new total
                </Button>
              </div>
            )}
            <p className="rounded-lg bg-fill px-3 py-2 text-[0.85rem] text-label-2">
              The epoch's price list, root, total and data hash come from the mining tool (<code className="font-mono">pnpm mining:epoch</code>), which is not wired into this page yet. Paste its output here.
            </p>
            <Input aria-label="Merkle root" value={form.root} placeholder="0x… root" className="font-mono text-[0.85rem]" onChange={(e) => setForm({ ...form, root: e.target.value })} />
            <Input aria-label="Epoch total" value={form.total} placeholder="Total, FACTORY" inputMode="decimal" className="tabular" onChange={(e) => setForm({ ...form, total: e.target.value })} />
            <Input aria-label="Data hash" value={form.dataHash} placeholder="0x… data hash" className="font-mono text-[0.85rem]" onChange={(e) => setForm({ ...form, dataHash: e.target.value })} />
            {form.root !== '' && problem !== null && <ErrorText>{problem}</ErrorText>}
            {!ended && epoch !== null && end !== undefined && <p className="text-[0.85rem] text-label-2">This epoch has not ended: the distributor refuses its root until it does.</p>}
            <Button
              disabled={busy || problem !== null || epoch === null || hasRoot}
              onClick={() => {
                const total = factoryAmount(form.total)
                if (epoch === null || total === null || problem !== null) return
                act(`Post the root of epoch ${epoch}`, { contract: 'EpochDistributor', to: c.distributor, abi: sdk.epochDistributorAbi, functionName: 'setRoot', args: [epoch, form.root.trim(), total, form.dataHash.trim()] }, 'safe')
              }}
            >
              {hasRoot ? 'Root posted' : 'Review the root'}
            </Button>
            <div className="flex gap-2">
              <Input aria-label="Amount to fund" value={form.fund} placeholder="Fund, FACTORY" inputMode="decimal" className="tabular flex-1" onChange={(e) => setForm({ ...form, fund: e.target.value })} />
              <Button
                variant="tinted"
                disabled={busy || epoch === null || fundAmount === null}
                onClick={() => {
                  if (epoch === null || fundAmount === null) return
                  act(`Fund epoch ${epoch}`, { contract: 'MiningReserve', to: c.miningReserve, abi: sdk.miningReserveAbi, functionName: 'fund', args: [epoch, fundAmount] }, 'safe')
                }}
              >
                Review funding
              </Button>
            </div>
          </div>
        </div>
      )}
    </Section>
  )
}
