import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { formatEther, parseEther } from 'viem'
import { useBalance, useSignTypedData } from 'wagmi'
import { waitForTransactionReceipt } from 'wagmi/actions'
import { type Budget, type TaskIndexEntry, type TxRequest, tool } from '../api.ts'
import { budgetCap, when } from '../format.ts'
import { typedDataArgs } from '../typed-data.ts'
import { chain, wagmiConfig } from '../wallet.ts'
import { useDelegatorUpgrade } from './Privy.tsx'
import { TxSteps } from './TxSteps.tsx'
import { Address, Badge, Button, Card, Row, TxLink } from './ui.tsx'

const STATUS_TONE = { promised: 'amber', live: 'green', revoked: 'red', ended: 'gray' } as const
const STATUS_LABEL = { promised: 'approved, not granted yet', live: 'granted', revoked: 'revoked', ended: 'expired or over' } as const
/** Monad: a transaction may not lower a delegated account's MON below 10 by more than its gas fee. */
const RESERVE = parseEther('10')

/**
 * A hire's execution budget (ADR-0009): a delegation from the creator's account to the activated worker, enforced
 * on-chain by the MetaMask Delegation Framework. The creator grants it here once the worker has activated (the
 * wallet points at the DeleGator, then signs the delegation), watches the draws, and revokes it on-chain.
 */
export function BudgetPanel({ task, status, roles, signedIn, address }: { task: TaskIndexEntry; status: string; roles: string[]; signedIn: boolean; address: string | undefined }) {
  const qc = useQueryClient()
  const creator = roles.includes('creator')
  const party = roles.length > 0
  const eb = task.executionBudget
  const upgrade = useDelegatorUpgrade(address)
  const { signTypedDataAsync } = useSignTypedData()
  const budget = useQuery({
    queryKey: ['get_budget', task.taskId, address],
    queryFn: () => tool<Budget>('get_budget', { taskId: task.taskId }),
    enabled: signedIn && party,
    refetchInterval: 10_000,
    retry: false,
  })
  const mon = useBalance({ address: task.creator, chainId: chain.id, query: { enabled: creator && eb?.kind === 'call' } })
  const [txs, setTxs] = useState<TxRequest[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (eb === null) return null
  const b = budget.data
  const refresh = () => qc.invalidateQueries({ queryKey: ['get_budget', task.taskId] })

  const act = (key: string, fn: () => Promise<void>) => async () => {
    setBusy(key)
    setError(null)
    try {
      await fn()
      await refresh()
    } catch (e) {
      setError((e as Error).message.split('\n')[0] ?? 'failed')
    } finally {
      setBusy(null)
    }
  }

  const grant = act('grant', async () => {
    const prep = await tool<{ sign: { typedData: string }; upgrade: { delegator: string } | null }>('budget_grant_prepare', { taskId: task.taskId })
    if (prep.upgrade !== null) {
      if (upgrade === null) throw new Error('Grant from the Privy email/Google wallet that published the task: it points at the DeleGator first.')
      const hash = await upgrade()
      if (hash !== null) await waitForTransactionReceipt(wagmiConfig, { hash, chainId: chain.id })
    }
    const signature = await signTypedDataAsync(typedDataArgs(prep.sign.typedData))
    await tool('budget_grant_confirm', { taskId: task.taskId, signature })
  })

  const revoke = act('revoke', async () => {
    const r = await tool<{ transactions: TxRequest[] }>('revoke_budget', { taskId: task.taskId })
    if (r.transactions.length > 0) setTxs(r.transactions)
  })

  return (
    <Card title="Execution budget">
      <p className="mb-2 text-xs text-label-2">
        Running costs apart from the reward, from the creator’s wallet. Not escrowed: what the worker draws is the worker’s, the rest never leaves the wallet. Enforced on-chain by a delegation from the creator’s account (MetaMask Delegation Framework).
      </p>
      <Row label="Approved">{budgetCap(eb)}</Row>
      {eb.kind === 'call' && (
        <p className="mb-1 text-xs text-label-2">
          One call to <span className="font-mono">{eb.function}</span> on <Address value={eb.target} />, made from the creator’s account, so the creator owns what it makes.
        </p>
      )}
      <Row label="Until">{when(eb.expiresAt)}</Row>
      {b !== undefined ? (
        <>
          <Row label="Status">
            <Badge tone={STATUS_TONE[b.status]}>{STATUS_LABEL[b.status]}</Badge>
            {b.endedReason !== null && <span className="ml-2 text-xs text-label-2">{b.endedReason}</span>}
          </Row>
          {b.kind === 'advance' ? (
            <>
              <Row label="Advanced to worker">{b.drawn} {b.symbol}</Row>
              <Row label="Remaining">{b.remaining} {b.symbol}</Row>
            </>
          ) : (
            <Row label="Call">{b.calls?.made ?? 0} of 1 made{b.drawn !== '0' ? `, ${b.drawn} ${b.symbol} sent` : ''}</Row>
          )}
          {b.status === 'live' && b.redeemable && (
            <p className="text-xs text-label-2">Drawable until {when(b.expiresAt)} unless revoked.</p>
          )}
          {b.draws.length > 0 && (
            <div className="mt-2 space-y-1">
              {b.draws.map((x) => (
                <div key={x.drawId} className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge tone={x.status === 'confirmed' ? 'green' : x.status === 'failed' ? 'red' : 'amber'}>{x.status}</Badge>
                  <span>{x.amount === null ? '—' : `${x.amount} ${b.symbol}`}{x.selector !== undefined ? ` · call ${x.selector}` : ''}</span>
                  {x.note !== '' && <span className="text-label-2">{x.note}</span>}
                  <TxLink hash={x.txHash} />
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        signedIn && party && budget.error !== null && <p className="text-xs text-bad">{(budget.error as Error).message}</p>
      )}
      {!signedIn && <p className="mt-2 text-xs text-label-2">Sign in as a party to see the draws.</p>}

      {creator && b !== undefined && (
        <div className="mt-3 space-y-2">
          {b.status === 'promised' && status !== 'active' && (
            <p className="text-xs text-label-2">Grant it once the worker has activated: the delegation names that worker.</p>
          )}
          {b.status === 'promised' && status === 'active' && (
            <Button busy={busy === 'grant'} onClick={grant}>Grant the budget (sign a delegation from your wallet)</Button>
          )}
          {(b.status === 'promised' || b.status === 'live') && (
            <Button variant="outline" busy={busy === 'revoke'} onClick={revoke}>Revoke</Button>
          )}
          {(b.status === 'ended' || b.status === 'revoked') && b.redeemable && (
            <div className="rounded border border-warn/30 bg-warn-bg p-2 text-xs">
              <p className="mb-1">The signed delegation is still valid on-chain until {when(b.expiresAt)}: the worker could redeem it directly. Disable it now.</p>
              <Button variant="outline" busy={busy === 'revoke'} onClick={revoke}>Disable on-chain</Button>
            </div>
          )}
          {eb.kind === 'call' && b.status !== 'ended' && b.status !== 'revoked' && mon.data !== undefined && mon.data.value < BigInt(eb.cap) + RESERVE && (
            <p className="text-xs text-warn">
              Your wallet holds {formatEther(mon.data.value)} MON. The call may send up to {formatEther(BigInt(eb.cap))} MON, and Monad keeps 10 MON in a delegated account: hold at least {formatEther(BigInt(eb.cap) + RESERVE)} MON when the worker calls.
            </p>
          )}
          {txs !== null && (
            <TxSteps taskId={task.taskId} txs={txs} onDone={() => { setTxs(null); void refresh() }} />
          )}
        </div>
      )}
      {roles.includes('worker') && b?.status === 'live' && (
        <p className="mt-2 text-xs text-label-2">
          {eb.kind === 'call'
            ? "Make the call with the board's MCP tool `spend_budget_call({taskId, data, value, note})`: it returns a transaction you send from your wallet, then report_transaction."
            : "Draw with the board's MCP tool `spend_budget({taskId, amount, note})`: it returns a transaction you send from your wallet, then report_transaction."}{' '}
          `get_budget` holds the signed delegation, redeemable without the board.
        </p>
      )}
      {error !== null && <p className="mt-2 text-xs text-bad">{error}</p>}
    </Card>
  )
}
