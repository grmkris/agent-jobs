import * as sdk from '@agent-jobs/sdk'
import { Link } from '@tanstack/react-router'
import { ChevronLeft, Hourglass, Layers, Lock } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { type Address, type Hex, encodeFunctionData, parseSignature } from 'viem'
import { useReadContracts, useSignTypedData } from 'wagmi'
import type { TxRequest } from '../api.ts'
import { PrivyLogin } from '../components/Privy.tsx'
import { useToast } from '../components/Sheet.tsx'
import { Countdown, When, useNow } from '../components/Time.tsx'
import { TxSteps } from '../components/TxSteps.tsx'
import { Badge, Button, EmptyState, ErrorText, Group, Input, ListRow, PageTitle, Section, Segmented, cn } from '../components/ui.tsx'
import { useAuth } from '../components/Wallet.tsx'
import { formatNumber, span } from '../format.ts'
import { type HirelingContracts, hireling } from '../hireling.ts'
import { amountProblem, factoryAmount, percent, tierOf } from '../stake.ts'
import { friendlyError } from '../txErrors.ts'
import { chain } from '../wallet.ts'

const fmt = (wei: bigint) => `${formatNumber(wei, 18)} FACTORY`

/** Everything the page shows, read in one batch from the vault, the fee schedule and FACTORY v2. */
interface Facts {
  /** The vault takes stake once its first Holding is authorized, at launch (`bootstrapped`). */
  open: boolean
  staked: bigint
  reserved: bigint
  available: bigint
  unstaking: bigint
  unlockAt: number
  cooldown: number
  schedule: { thresholds: readonly bigint[]; bps: readonly number[] }
  pending: { thresholds: readonly bigint[]; bps: readonly number[]; eta: number } | null
  wallet: bigint
  nonce: bigint
  domain: { name: string; version: string; chainId: bigint; verifyingContract: Address }
}

type Op = { kind: 'stake' | 'unstake' | 'cancel' | 'withdraw'; txs: TxRequest[] }
const DONE: Record<Op['kind'], string> = {
  stake: 'Staked. Your fee tier counts it now.',
  unstake: 'Unstaking started. The cooldown is running.',
  cancel: 'Unstaking cancelled. It is staked again.',
  withdraw: 'Withdrawn to your wallet.',
}

/** The operation handed to TxSteps, kept until it is done so a reload resumes it instead of preparing it again. */
const opKey = (address: string) => `hireling.stake-op:${address.toLowerCase()}`
function loadOp(address: string): Op | null {
  try {
    return JSON.parse(localStorage.getItem(opKey(address)) ?? 'null') as Op | null
  } catch {
    return null
  }
}
function saveOp(address: string, op: Op | null) {
  try {
    if (op === null) localStorage.removeItem(opKey(address))
    else localStorage.setItem(opKey(address), JSON.stringify(op))
  } catch {
    // storage blocked: the operation lasts as long as the page
  }
}

/**
 * Stake FACTORY (ADR-0011): what is staked, what bonds on live jobs hold (reserved), what can be unstaked, the 7-day
 * cooldown, and the fee tier the stake earns as a worker, with what the next tier takes. Every number is read from
 * the chain; the tiers come from the FeeSchedule. Staking is one transaction with a permit signature; unstaking
 * starts a cooldown that can be cancelled, then a withdrawal.
 */
export function StakePage() {
  const auth = useAuth()
  if (hireling === null) {
    return (
      <>
        <PageTitle sub="FACTORY staked here sets your fee as a worker and backs your bonds.">Stake</PageTitle>
        <EmptyState title={`Staking is not on ${chain.name} yet`}>It opens when Hireling v1's stake vault is deployed on this network.</EmptyState>
      </>
    )
  }
  if (auth.address === undefined) {
    return (
      <>
        <PageTitle sub="FACTORY staked here sets your fee as a worker and backs your bonds.">Stake</PageTitle>
        <section className="grid gap-4 rounded-2xl bg-surface p-5 shadow-float">
          <h2 className="font-display text-[1.4rem] leading-tight font-bold tracking-[-0.02em]">Sign in to stake</h2>
          <p className="leading-relaxed text-label-2">Your stake belongs to your wallet. Sign in with your email or Google to see it.</p>
          <div>
            <PrivyLogin />
          </div>
        </section>
      </>
    )
  }
  return <Stake c={hireling} address={auth.address} />
}

function Stake({ c, address }: { c: HirelingContracts; address: Address }) {
  const toast = useToast()
  const now = useNow()
  const { signTypedDataAsync } = useSignTypedData()
  const reads = useReadContracts({
    contracts: [
      { address: c.vault, abi: sdk.stakeVaultAbi, functionName: 'stakeOf', args: [address], chainId: chain.id },
      { address: c.vault, abi: sdk.stakeVaultAbi, functionName: 'reservedOf', args: [address], chainId: chain.id },
      { address: c.vault, abi: sdk.stakeVaultAbi, functionName: 'availableOf', args: [address], chainId: chain.id },
      { address: c.vault, abi: sdk.stakeVaultAbi, functionName: 'unstakeOf', args: [address], chainId: chain.id },
      { address: c.vault, abi: sdk.stakeVaultAbi, functionName: 'UNSTAKE_DELAY', chainId: chain.id },
      { address: c.feeSchedule, abi: sdk.feeScheduleAbi, functionName: 'schedule', chainId: chain.id },
      { address: c.feeSchedule, abi: sdk.feeScheduleAbi, functionName: 'pending', chainId: chain.id },
      { address: c.factory, abi: sdk.factoryV2Abi, functionName: 'balanceOf', args: [address], chainId: chain.id },
      { address: c.factory, abi: sdk.factoryV2Abi, functionName: 'nonces', args: [address], chainId: chain.id },
      { address: c.factory, abi: sdk.factoryV2Abi, functionName: 'eip712Domain', chainId: chain.id },
      { address: c.vault, abi: sdk.stakeVaultAbi, functionName: 'bootstrapped', chainId: chain.id },
    ],
    query: { refetchInterval: 15_000 },
  })
  const parse = (data: typeof reads.data): Facts | null => {
    if (data === undefined || data.some((r) => r.status !== 'success')) return null
    const [staked, reserved, available, unstake, cooldown, schedule, pending, wallet, nonce, domain, open] = data.map((r) => r.result) as [
      bigint, bigint, bigint, readonly [bigint, number], number,
      { thresholds: readonly bigint[]; bps: readonly number[] },
      readonly [{ thresholds: readonly bigint[]; bps: readonly number[] }, number],
      bigint, bigint, readonly [Hex, string, string, bigint, Address, Hex, readonly bigint[]], boolean,
    ]
    return {
      open, staked, reserved, available, wallet, nonce, cooldown: Number(cooldown),
      unstaking: unstake[0], unlockAt: Number(unstake[1]),
      schedule,
      pending: Number(pending[1]) === 0 ? null : { ...pending[0], eta: Number(pending[1]) },
      domain: { name: domain[1], version: domain[2], chainId: domain[3], verifyingContract: domain[4] },
    }
  }
  // The last complete read: shown, marked stale, when a later read fails; never a guessed number.
  const current = parse(reads.data)
  const last = useRef<{ facts: Facts; at: number } | null>(null)
  if (current !== null && reads.dataUpdatedAt !== last.current?.at) last.current = { facts: current, at: reads.dataUpdatedAt }
  const facts = current ?? last.current?.facts ?? null
  const stale = current === null && facts !== null

  const [op, setOpState] = useState<Op | null>(() => loadOp(address))
  const setOp = (next: Op | null) => {
    saveOp(address, next)
    setOpState(next)
  }
  const [safeToDismiss, setSafeToDismiss] = useState(true)
  const [mode, setMode] = useState<'stake' | 'unstake'>('stake')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setError(null), [text, mode])

  const tx = (description: string, data: Hex): TxRequest => ({ description, chainId: chain.id, to: c.vault, data, value: '0' })
  const amount = factoryAmount(text)
  const problem = amountProblem(text, mode === 'stake' ? facts?.wallet : facts?.available, mode)

  /** Signs an EIP-2612 permit for the vault, against a fresh nonce, then hands `stakeWithPermit` to the wallet. */
  const stake = async (value: bigint) => {
    setBusy(true)
    setError(null)
    try {
      const fresh = parse((await reads.refetch()).data)
      if (fresh === null) throw new Error('Your FACTORY balance and permit nonce could not be read from the chain. Try again.')
      if (value > fresh.wallet) throw new Error('That is more FACTORY than your wallet holds.')
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
      const signature = await signTypedDataAsync({
        domain: fresh.domain,
        types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
        primaryType: 'Permit',
        message: { owner: address, spender: c.vault, value, nonce: fresh.nonce, deadline },
      })
      const { r, s, v, yParity } = parseSignature(signature)
      const data = encodeFunctionData({ abi: sdk.stakeVaultAbi, functionName: 'stakeWithPermit', args: [value, deadline, Number(v ?? BigInt(yParity + 27)), r, s] })
      setOp({ kind: 'stake', txs: [tx(`Stake ${fmt(value)}`, data)] })
      setText('')
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }
  const submit = () => {
    if (amount === null || problem !== null || facts === null || stale) return
    if (mode === 'stake') void stake(amount)
    else {
      setOp({ kind: 'unstake', txs: [tx(`Start unstaking ${fmt(amount)}`, encodeFunctionData({ abi: sdk.stakeVaultAbi, functionName: 'requestUnstake', args: [amount] }))] })
      setText('')
    }
  }

  const tiers = facts === null ? null : tierOf(facts.schedule, facts.staked)
  const unlocked = facts !== null && facts.unstaking > 0n && facts.unlockAt <= now
  const days = facts === null ? '7 days' : duration(facts.cooldown)

  return (
    <>
      <Link to="/me" className="-mb-2 inline-flex w-fit items-center gap-0.5 text-tint">
        <ChevronLeft aria-hidden className="-ml-1.5 size-5" strokeWidth={2.4} />
        Me
      </Link>
      <PageTitle sub="FACTORY staked here sets your fee as a worker and backs your bonds.">Stake</PageTitle>

      {reads.isError && facts === null && (
        <div role="status" className="grid gap-2 rounded-xl bg-warn-bg p-4 text-[0.9rem] text-warn">
          <p>Your stake cannot be read from the chain right now. This does not mean it is gone.</p>
          <Button variant="tinted" onClick={() => void reads.refetch()}>Retry</Button>
        </div>
      )}
      {stale && last.current !== null && (
        <div role="status" className="grid gap-2 rounded-xl bg-warn-bg p-4 text-[0.9rem] text-warn">
          <p>The chain did not answer. Showing last-known stake facts from {new Date(last.current.at).toLocaleTimeString()}; staking is paused until they refresh.</p>
          <Button variant="tinted" onClick={() => void reads.refetch()}>Retry</Button>
        </div>
      )}

      <section aria-label="Your stake" className="grid gap-4 rounded-2xl bg-surface p-4">
        <div className="flex items-center gap-3.5">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-tint/14 text-tint">
            <Layers aria-hidden className="size-5" />
          </span>
          <span className="min-w-0">
            <span className="tabular block font-display text-[1.75rem] leading-none font-bold tracking-[-0.02em] [overflow-wrap:anywhere]">{facts === null ? '—' : fmt(facts.staked)}</span>
            <span className="mt-1 block text-[0.88rem] text-label-2">Staked · counts for your fee tier</span>
          </span>
        </div>
        <Group className="bg-bg">
          <ListRow>
            <Lock aria-hidden className="size-4 shrink-0 text-label-3" />
            <span className="flex-1">
              Reserved
              <span className="block text-[0.78rem] text-label-3">Bonds on your live jobs; cannot be unstaked</span>
            </span>
            <span className="tabular">{facts === null ? '—' : fmt(facts.reserved)}</span>
          </ListRow>
          <ListRow>
            <span className="size-4 shrink-0" />
            <span className="flex-1">Available to unstake</span>
            <span className="tabular">{facts === null ? '—' : fmt(facts.available)}</span>
          </ListRow>
          <ListRow>
            <span className="size-4 shrink-0" />
            <span className="flex-1">In your wallet</span>
            <span className="tabular">{facts === null ? '—' : fmt(facts.wallet)}</span>
          </ListRow>
        </Group>
      </section>

      {facts !== null && tiers !== null && (
        <Section title="Your fee as a worker" note="Taken from what a job pays you, at the rate in force when you activate it. A bigger stake pays less.">
          <div className="grid gap-3 rounded-xl bg-surface px-4 py-3.5">
            <p className="flex flex-wrap items-baseline gap-x-2">
              <span className="tabular font-display text-[1.5rem] font-bold">{percent(tiers.current.bps)}</span>
              <span className="text-label-2">fee on what you are paid</span>
            </p>
            {tiers.next === null ? (
              <p className="text-[0.9rem] text-label-2">You are in the lowest fee tier.</p>
            ) : (
              <>
                <div aria-hidden className="h-1.5 overflow-hidden rounded-full bg-fill">
                  <div className="h-full rounded-full bg-tint" style={{ width: `${progress(facts.staked, tiers.current.threshold, tiers.next.threshold)}%` }} />
                </div>
                <p className="text-[0.9rem] text-label-2">
                  Stake <span className="tabular font-semibold text-label">{fmt(tiers.next.needed)}</span> more to pay {percent(tiers.next.bps)}.
                </p>
              </>
            )}
          </div>
          <Group className="mt-2">
            {facts.schedule.thresholds.map((threshold, i) => (
              <ListRow key={i}>
                <span className="tabular flex-1">{i === 0 ? 'Any stake' : `From ${fmt(threshold)}`}</span>
                {i === tiers.current.index && <Badge tone="info">You</Badge>}
                <span className={cn('tabular w-14 text-right', i === tiers.current.index ? 'font-semibold' : 'text-label-2')}>{percent(facts.schedule.bps[i] ?? 0)}</span>
              </ListRow>
            ))}
          </Group>
          {facts.pending !== null && (
            <p role="note" className="mt-2 rounded-lg bg-tint/10 px-3 py-2 text-[0.86rem] text-label-2">
              A new fee schedule can take effect from <When at={facts.pending.eta} />. Jobs already activated keep their rate.
            </p>
          )}
        </Section>
      )}

      {facts !== null && facts.unstaking > 0n && (
        <Section title="Unstaking">
          <div className="grid gap-3 rounded-xl bg-surface px-4 py-3.5">
            <div className="flex items-center gap-3">
              <Hourglass aria-hidden className="size-5 shrink-0 text-label-3" />
              <span className="min-w-0 flex-1">
                <span className="tabular block font-semibold">{fmt(facts.unstaking)}</span>
                <span className="block text-[0.86rem] text-label-2">
                  {unlocked ? 'Ready to withdraw' : <>Withdrawable in <Countdown to={facts.unlockAt} /> · <When at={facts.unlockAt} show="time" /></>}
                </span>
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                className="flex-1"
                disabled={!unlocked || op !== null || stale}
                onClick={() => setOp({ kind: 'withdraw', txs: [tx(`Withdraw ${fmt(facts.unstaking)}`, encodeFunctionData({ abi: sdk.stakeVaultAbi, functionName: 'withdraw' }))] })}
              >
                Withdraw
              </Button>
              <Button
                variant="tinted"
                className="flex-1"
                disabled={op !== null || stale}
                onClick={() => setOp({ kind: 'cancel', txs: [tx(`Stake ${fmt(facts.unstaking)} again`, encodeFunctionData({ abi: sdk.stakeVaultAbi, functionName: 'cancelUnstake' }))] })}
              >
                Cancel unstaking
              </Button>
            </div>
          </div>
        </Section>
      )}

      {facts !== null && !facts.open && op === null ? (
        <div role="status" className="grid gap-1 rounded-2xl bg-tint/10 px-4 py-3.5">
          <p className="font-semibold">Staking opens at launch</p>
          <p className="text-[0.9rem] leading-relaxed text-label-2">
            The vault takes stake once the first Hireling contract is authorized to reserve bonds from it, at launch. Until then nothing can be staked; your FACTORY stays in your wallet.
          </p>
        </div>
      ) : op !== null ? (
        <Section title="Send from your wallet">
          <TxSteps
            key={op.txs.map((t) => t.data).join()}
            taskId={`stake:${address.toLowerCase()}`}
            txs={op.txs}
            owner={address}
            reportToBoard={false}
            onSafeToRestartChange={setSafeToDismiss}
            onDone={() => {
              const kind = op.kind
              setOp(null)
              void reads.refetch()
              toast(DONE[kind])
            }}
          />
          {safeToDismiss && (
            <Button variant="plain" size="sm" className="mt-2 justify-self-center" onClick={() => setOp(null)}>
              Not now
            </Button>
          )}
        </Section>
      ) : (
        <Section title={mode === 'stake' ? 'Stake' : 'Unstake'}>
          <form
            className="grid gap-3 rounded-xl bg-surface px-4 py-3.5"
            onSubmit={(e) => {
              e.preventDefault()
              submit()
            }}
          >
            <Segmented label="Stake or unstake" value={mode} onChange={setMode} options={[['stake', 'Stake'], ['unstake', 'Unstake']]} />
            <label className="grid gap-1.5">
              <span className="text-[0.82rem] text-label-2">Amount of FACTORY</span>
              <span className="flex gap-2">
                <Input id="stake-amount" value={text} onChange={(e) => setText(e.target.value)} inputMode="decimal" placeholder="0" className="tabular flex-1" autoComplete="off" />
                <Button
                  variant="gray"
                  disabled={facts === null}
                  onClick={() => facts !== null && setText(trim(mode === 'stake' ? facts.wallet : facts.available))}
                >
                  Max
                </Button>
              </span>
            </label>
            <p className="text-[0.86rem] leading-snug text-label-2">
              {mode === 'stake'
                ? 'One signature and one transaction: the signature lets the vault take exactly this amount, nothing more.'
                : facts !== null && facts.unstaking > 0n
                  ? `You are already unstaking ${fmt(facts.unstaking)}. Adding to it restarts the ${days} cooldown for the whole amount.`
                  : `It stops counting for your fee tier now and can be withdrawn after ${days}. You can cancel until you withdraw.`}
            </p>
            {problem !== null && <ErrorText>{problem}</ErrorText>}
            {error !== null && <ErrorText>{error}</ErrorText>}
            <Button size="lg" type="submit" busy={busy} disabled={amount === null || problem !== null || facts === null || stale}>
              {mode === 'stake' ? (amount === null ? 'Stake' : `Stake ${fmt(amount)}`) : amount === null ? 'Unstake' : `Unstake ${fmt(amount)}`}
            </Button>
          </form>
        </Section>
      )}

      <Section title="How staking works">
        <div className="grid gap-3 rounded-xl bg-surface px-4 py-3.5 text-[0.92rem] leading-relaxed">
          <p>
            <span className="font-semibold">Reserved stake.</span> A bond is not sent anywhere: when you publish a job, or activate one as a worker, its bond is reserved from your stake. Reserved stake still counts for your fee tier, but it cannot be unstaked until the job settles, and a ruling against you, or a missed deadline, can burn it.
          </p>
          <p>
            <span className="font-semibold">Why unstaking waits {days}.</span> So that stake cannot leave just before a bond is reserved or burned, and so that every staker can leave before a new Holding contract is allowed to reserve stake: adding one takes the Safe 8 days, longer than the cooldown.
          </p>
        </div>
      </Section>
    </>
  )
}

/** "7 days" for a whole number of days (the cooldown), else "36 h". */
function duration(seconds: number): string {
  const days = seconds / 86_400
  return Number.isInteger(days) ? `${days} day${days === 1 ? '' : 's'}` : span(seconds)
}

/** How far `stake` is from `from` to `to`, in percent, for the tier bar. */
function progress(stake: bigint, from: bigint, to: bigint): number {
  if (to <= from) return 100
  return Number(((stake - from) * 1000n) / (to - from)) / 10
}

/** A wei amount as a person would type it: exact, without trailing zeros. */
function trim(wei: bigint): string {
  const s = wei.toString().padStart(19, '0')
  const whole = s.slice(0, -18).replace(/^0+(?=\d)/, '')
  const frac = s.slice(-18).replace(/0+$/, '')
  return frac === '' ? whole : `${whole}.${frac}`
}

