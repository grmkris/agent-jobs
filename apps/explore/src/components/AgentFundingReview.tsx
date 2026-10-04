import * as sdk from '@agent-jobs/sdk'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowRight, RefreshCw, Wallet } from 'lucide-react'
import { useRef, useState } from 'react'
import { createPublicClient, formatUnits, getAddress, http, type Hex } from 'viem'
import { useAccount } from 'wagmi'
import { fundingAmount, fundingSteps, type FundingAsset, type FundingRecord } from '../agent-funding.ts'
import type { ManagedAgent } from '../fleet.ts'
import { formatNumber, tokenInfo } from '../format.ts'
import { chain, deployment, isMainnet, writesOpen } from '../wallet.ts'
import { useAgentWallets } from './Privy.tsx'
import { TxSteps } from './TxSteps.tsx'
import { initializeTxJournal, readTxJournal, txJournalKey } from './txJournal.ts'
import { withWalletStepLock } from './txOperation.ts'
import { Address, Badge, Button, CopyButton, ErrorText, Field, Input, TxLink } from './ui.tsx'

const reads = createPublicClient({ chain, transport: http() })
const assets: FundingAsset[] = [
  { id: 'native', symbol: chain.nativeCurrency.symbol, decimals: 18 },
  ...[...new Set([deployment.factory, ...deployment.rewardTokens])].map(address => ({ id: address, address, ...tokenInfo(address) })),
]
async function balances(wallet: Hex, blockNumber: bigint) {
  const h = deployment.hireling
  const values = await Promise.all(assets.map(asset => asset.address === undefined
    ? reads.getBalance({ address: wallet, blockNumber })
    : reads.readContract({ address: asset.address, abi: sdk.factoryTokenAbi, functionName: 'balanceOf', args: [wallet], blockNumber })))
  const stake = h === null ? null : await Promise.all([
    reads.readContract({ address: h.vault, abi: sdk.stakeVaultAbi, functionName: 'stakeOf', args: [wallet], blockNumber }),
    reads.readContract({ address: h.vault, abi: sdk.stakeVaultAbi, functionName: 'reservedOf', args: [wallet], blockNumber }),
    reads.readContract({ address: h.vault, abi: sdk.stakeVaultAbi, functionName: 'availableOf', args: [wallet], blockNumber }),
  ])
  return { values: Object.fromEntries(assets.map((asset, i) => [asset.id, values[i]!])), stake }
}

/** Exact operator-to-child funding, with separate chain transfer and stake reviews. */
export function AgentFundingReview({ agent }: { agent: ManagedAgent }) {
  const wallets = useAgentWallets()
  const account = useAccount()
  const live = useRef(account); live.current = account
  const owner = getAddress(agent.owner), wallet = getAddress(agent.walletAddress)
  const key = `hireling.agent-funding:${chain.id}:${agent.id}:${owner.toLowerCase()}`
  const [initial] = useState(() => {
    try {
      const raw = localStorage.getItem(key)
      const record = raw === null ? null : JSON.parse(raw) as FundingRecord
      if (record !== null) fundingSteps(record, assets, chain.id, owner, wallet)
      return { record, error: null }
    } catch { return { record: null, error: 'The saved funding review is unreadable. Reconcile it before starting another transfer.' } }
  })
  const [record, setRecord] = useState<FundingRecord | null>(initial.record)
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(initial.error)
  const [busy, setBusy] = useState(false)
  const selected = account.address?.toLowerCase() === owner.toLowerCase() && account.chainId === chain.id
  const snapshot = useQuery({
    queryKey: ['agent-funding-balances', owner, wallet, chain.id],
    queryFn: async () => {
      const block = await reads.getBlockNumber()
      const [operator, agentBalances] = await Promise.all([balances(owner, block), balances(wallet, block)])
      return { operator, agent: agentBalances, block }
    },
    refetchInterval: 10_000, refetchOnWindowFocus: true,
  })
  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await operation() } catch (failure) { setError((failure as Error).message) } finally { setBusy(false) }
  }
  const save = (next: FundingRecord) => {
    const bytes = JSON.stringify(next)
    localStorage.setItem(key, bytes)
    if (localStorage.getItem(key) !== bytes) throw new Error('Browser storage did not save this funding review. Nothing was sent.')
    setRecord(next)
  }
  const review = async () => {
    if (!selected) throw new Error('Select your operator wallet on the correct network before reviewing funding.')
    const chosen = { ...amounts }
    await withWalletStepLock(navigator.locks, key, async () => {
      const existing = localStorage.getItem(key)
      if (existing !== null) {
        const prior = JSON.parse(existing) as FundingRecord
        fundingSteps(prior, assets, chain.id, owner, wallet); setRecord(prior); return
      }
      const next: FundingRecord = { id: `fund_${crypto.randomUUID()}`, owner, wallet, chainId: chain.id, amounts: chosen, estimatedGas: '0' }
      const steps = fundingSteps(next, assets, chain.id, owner, wallet)
      const block = await reads.getBlockNumber()
      const available = await balances(owner, block)
      for (const asset of assets) {
        if (fundingAmount(chosen[asset.id] ?? '', asset) > available.values[asset.id]!) throw new Error(`Your operator wallet has insufficient ${asset.symbol}.`)
      }
      const [price, gas] = await Promise.all([reads.getGasPrice(), Promise.all(steps.map(step => reads.estimateGas({ account: owner, to: step.to, data: step.data, value: BigInt(step.value) })))])
      const gasAllowance = gas.reduce((sum, value) => sum + value, 0n) * price * 2n
      if (available.values.native! < fundingAmount(chosen.native ?? '', assets[0]!) + gasAllowance)
        throw new Error('Keep enough MON in your operator wallet to pay the estimated transfer fees. Reduce the MON amount or add funds.')
      if (live.current.address?.toLowerCase() !== owner.toLowerCase() || live.current.chainId !== chain.id)
        throw new Error('The selected wallet or network changed while funding was quoted. Nothing was sent.')
      next.estimatedGas = gasAllowance.toString()
      initializeTxJournal(localStorage, next.id, steps)
      save(next)
    })
  }
  const cancel = async () => {
    if (record === null) return
    const steps = fundingSteps(record, assets, chain.id, owner, wallet)
    const innerKey = txJournalKey(record.id, steps)
    await withWalletStepLock(navigator.locks, key, () => withWalletStepLock(navigator.locks, innerKey, async () => {
      const inner = readTxJournal(localStorage, txJournalKey(record.id, steps), true)!
      if (inner.pending !== null || inner.hashes.some(hash => hash !== null) || (inner.reverted?.length ?? 0) > 0) throw new Error('Funding has started. Reconcile the saved operation before making another review.')
      // Invalidate the inner record first: a stale mounted tab must not send an edited review.
      localStorage.removeItem(innerKey)
      if (localStorage.getItem(innerKey) !== null) throw new Error('The unsent funding review could not be cancelled. Nothing was sent.')
      localStorage.removeItem(key)
      if (localStorage.getItem(key) !== null) throw new Error('The unsent funding review could not be cancelled. Nothing was sent.')
      setRecord(null)
    }))
  }
  const steps = record === null ? [] : fundingSteps(record, assets, chain.id, owner, wallet)
  return (
    <section className="workspace-panel grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><p className="eyebrow">YOUR AGENT’S STARTING BALANCE</p><h2 className="section-title flex items-center gap-2"><Wallet className="size-5 text-tint" />Fund this agent</h2></div>
        <Badge tone={snapshot.isError ? 'attention' : 'info'}>{snapshot.isError ? 'balances unavailable' : snapshot.data ? 'live balances' : 'reading balances'}</Badge>
      </div>
      <p className="text-sm leading-relaxed text-label-2">MON pays for registration and transactions. Hiring needs the job’s reward token; bonds reserve FACTORY stake. Registration itself needs gas only.</p>
      <div className="grid gap-2 rounded-xl bg-fill p-4 text-sm">
        <p>From your operator wallet <Address value={owner} /></p>
        <p>To {agent.name} <Address value={wallet} /></p>
      </div>
      <div className="grid gap-3">
        {assets.map(asset => (
          <div key={asset.id} className="grid gap-2 rounded-xl border border-sep p-4 sm:grid-cols-[1fr_9rem] sm:items-center">
            <div><strong className="text-sm">{asset.symbol}</strong><p className="mt-1 text-xs text-label-2">Operator {snapshot.isError || !snapshot.data ? 'unavailable' : formatNumber(snapshot.data.operator.values[asset.id]!, asset.decimals)} · Agent {snapshot.isError || !snapshot.data ? 'unavailable' : formatNumber(snapshot.data.agent.values[asset.id]!, asset.decimals)}</p></div>
            {record === null ? <Field label={`${asset.symbol} to send`}><Input inputMode="decimal" placeholder="0" value={amounts[asset.id] ?? ''} disabled={initial.error !== null} onChange={event => setAmounts(current => ({ ...current, [asset.id]: event.target.value }))} /></Field> : <p className="tabular text-sm font-semibold">{record.amounts[asset.id] || '0'} {asset.symbol}</p>}
          </div>
        ))}
      </div>
      <div className="rounded-xl bg-fill p-4 text-xs leading-relaxed text-label-2">
        {snapshot.data?.agent.stake && !snapshot.isError ? <p>Agent stake: {formatNumber(snapshot.data.agent.stake[0]!, 18)} FACTORY · reserved {formatNumber(snapshot.data.agent.stake[1]!, 18)} · available {formatNumber(snapshot.data.agent.stake[2]!, 18)}.</p> : <p>Agent stake: {snapshot.isError ? 'unavailable' : 'reading from the vault'}.</p>}
        <p className="mt-2">A starting balance of 0.5 MON is a suggestion for a few transactions. Transfer fees are quoted when you review. Required rewards and bonds come from the job you choose.</p>
        {!isMainnet && <p className="mt-2">You can also use the <a href="https://faucet.monad.xyz" target="_blank" rel="noreferrer" className="text-tint underline">Monad testnet faucet</a>. FACTORY v2 comes from the ecosystem; mUSD and mEUR have their own on-chain faucet. Test tokens have no value.</p>}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <CopyButton value={wallet} label="Copy agent funding address" />
        <Button variant="plain" size="sm" onClick={() => void snapshot.refetch()}><RefreshCw className="size-4" />Refresh balances</Button>
        <Link to="/stake" className="action-link secondary">Review stake</Link>
      </div>
      {initial.error === null && record === null && (
        selected ? <Button disabled={!writesOpen || snapshot.isError || !snapshot.data} busy={busy} onClick={() => void run(review)}>Review funding <ArrowRight className="size-4" /></Button>
          : <Button variant="tinted" busy={busy} disabled={wallets === null} onClick={() => void run(async () => { await wallets!.select(owner) })}>Use operator wallet to fund</Button>
      )}
      {record !== null && (
        <>
          <p className="text-xs text-label-2">On {chain.name}. Transfer gas allowance: {formatUnits(BigInt(record.estimatedGas), 18)} MON. Each exact transfer has a separate wallet confirmation.</p>
          {record.hashes === undefined ? <><TxSteps key={record.id} taskId={record.id} txs={steps} owner={owner} canSend={selected && writesOpen} reportToBoard={false} retainRecord allowBatch={false} allowSponsorship={false} requireJournal verifyReceipt onDone={hashes => void run(async () => { save({ ...record, hashes }); await snapshot.refetch() })} /><Button variant="plain" size="sm" disabled={busy} onClick={() => void run(cancel)}>Edit an unsent review</Button></> : <><p role="status" className="text-sm text-ok">Funding confirmed. Select the agent wallet to continue registration or staking.</p>{record.hashes.map(hash => <TxLink key={hash} hash={hash} />)}</>}
        </>
      )}
      {error !== null && <ErrorText>{error}</ErrorText>}
    </section>
  )
}
