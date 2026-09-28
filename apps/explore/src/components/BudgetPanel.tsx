import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { formatEther } from 'viem'
import { useBalance } from 'wagmi'
import { type Budget, type TaskIndexEntry, tool } from '../api.ts'
import { amount, when } from '../format.ts'
import { chain } from '../wallet.ts'
import { usePrivyBudget } from './Privy.tsx'
import { Address, Badge, Button, Card, Row, TxLink } from './ui.tsx'

const STATUS_TONE = { promised: 'amber', live: 'green', revoked: 'red', ended: 'gray' } as const
/** Enough MON for a few transfers; below it a spend may fail for gas. */
const LOW_GAS = 50_000_000_000_000_000n

/**
 * A hire's execution budget (ADR-0005): the worker spends from the creator's Privy wallet through the board's signer,
 * per transfer within the wallet's Privy policy and in total within the board's ledger. The creator grants it here
 * (adds the board's signer to the embedded wallet), watches the spends, revokes it, and cleans the signer up after.
 */
export function BudgetPanel({ task, roles, signedIn, address }: { task: TaskIndexEntry; roles: string[]; signedIn: boolean; address: string | undefined }) {
  const qc = useQueryClient()
  const creator = roles.includes('creator')
  const party = roles.length > 0
  const privy = usePrivyBudget(address)
  const budget = useQuery({
    queryKey: ['get_budget', task.taskId, address],
    queryFn: () => tool<Budget>('get_budget', { taskId: task.taskId }),
    enabled: signedIn && party,
    refetchInterval: 10_000,
    retry: false,
  })
  const gas = useBalance({ address: task.creator, chainId: chain.id, query: { enabled: creator } })
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const eb = task.executionBudget
  if (eb === null) return null
  const b = budget.data

  const act = (key: string, fn: () => Promise<void>) => async () => {
    setBusy(key)
    setError(null)
    try {
      await fn()
      await qc.invalidateQueries({ queryKey: ['get_budget', task.taskId] })
    } catch (e) {
      setError((e as Error).message.split('\n')[0] ?? 'failed')
    } finally {
      setBusy(null)
    }
  }

  const grant = act('grant', async () => {
    if (privy === null) throw new Error('grant from your Privy email/Google wallet')
    const prep = await tool<{ step: 'add-signer' | 'replace-signer' | 'confirm'; address: string; signerId?: string; policyId: string }>('budget_grant_prepare', {
      taskId: task.taskId,
      privyAccessToken: await privy.getAccessToken(),
    })
    if (prep.step === 'replace-signer') await privy.removeSigners(prep.address)
    if (prep.step !== 'confirm') await privy.addSigner(prep.address, prep.signerId as string, prep.policyId)
    await tool('budget_grant_confirm', { taskId: task.taskId })
  })

  const revoke = act('revoke', async () => {
    await tool('revoke_budget', { taskId: task.taskId })
  })

  const cleanup = act('cleanup', async () => {
    if (privy === null || b?.cleanup == null) throw new Error('clean up from your Privy email/Google wallet')
    if ('removeSigners' in b.cleanup) {
      await privy.removeSigners(b.cleanup.address)
    } else {
      await privy.removeSigners(b.cleanup.replaceSigner.address)
      await privy.addSigner(b.cleanup.replaceSigner.address, b.cleanup.replaceSigner.signerId, b.cleanup.replaceSigner.policyId)
    }
  })

  return (
    <Card title="Execution budget">
      <p className="mb-2 text-xs text-neutral-500">
        Running costs the worker may spend from the creator’s wallet, apart from the reward. Not escrowed: spent is spent, the rest never leaves the wallet.
      </p>
      <Row label="Cap">{amount(eb.cap, eb.token)}</Row>
      <Row label="Until">{when(eb.expiresAt)}</Row>
      {b !== undefined ? (
        <>
          <Row label="Status">
            <Badge tone={STATUS_TONE[b.status]}>{b.status === 'promised' ? 'promised, not granted yet' : b.status}</Badge>
            {b.endedReason !== null && <span className="ml-2 text-xs text-neutral-500">{b.endedReason}</span>}
          </Row>
          <Row label="Spent">{b.spent} {b.symbol}{b.reserved !== '0' ? ` (+ ${b.reserved} pending)` : ''}</Row>
          <Row label="Remaining">{b.remaining} {b.symbol}</Row>
          {b.spends.length > 0 && (
            <div className="mt-2 space-y-1">
              {b.spends.map((x) => (
                <div key={x.spendId} className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge tone={x.status === 'confirmed' ? 'green' : x.status === 'failed' ? 'red' : 'amber'}>{x.status}</Badge>
                  <span>{x.amount} {b.symbol} →</span>
                  <Address value={x.to} />
                  {x.note !== '' && <span className="text-neutral-500">{x.note}</span>}
                  <TxLink hash={x.txHash} />
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        signedIn && party && budget.error !== null && <p className="text-xs text-red-600">{(budget.error as Error).message}</p>
      )}
      {!signedIn && <p className="mt-2 text-xs text-neutral-500">Sign in as a party to see the spends.</p>}

      {creator && b !== undefined && (
        <div className="mt-3 space-y-2">
          {privy === null && (b.status === 'promised' || b.cleanup !== null) && (
            <p className="text-xs text-amber-700">A budget is granted from the Privy email/Google wallet that published the task; this wallet cannot add the board’s signer.</p>
          )}
          {b.status === 'promised' && privy !== null && (
            <Button busy={busy === 'grant'} onClick={grant}>Grant the budget (adds the board’s signer to your wallet)</Button>
          )}
          {(b.status === 'promised' || b.status === 'live') && (
            <Button variant="outline" busy={busy === 'revoke'} onClick={revoke}>Revoke</Button>
          )}
          {b.cleanup !== null && privy !== null && (
            <div className="rounded border border-amber-200 bg-amber-50 p-2 text-xs">
              <p className="mb-1">{b.cleanup.why}</p>
              <Button variant="outline" busy={busy === 'cleanup'} onClick={cleanup}>{'removeSigners' in b.cleanup ? 'Remove the signer' : 'Re-attach under the smaller policy'}</Button>
            </div>
          )}
          {b.status === 'live' && gas.data !== undefined && gas.data.value < LOW_GAS && (
            <p className="text-xs text-amber-700">Your wallet holds {formatEther(gas.data.value)} MON; each spend is a transaction your wallet pays gas for.</p>
          )}
          <p className="text-xs text-neutral-500">
            Privy checks every transfer against your wallet’s policy (this token, at most the cap, before the deadline); the board checks the total, that only the activated worker spends, and only while the job is active.
          </p>
        </div>
      )}
      {roles.includes('worker') && b?.status === 'live' && (
        <p className="mt-2 text-xs text-neutral-500">Spend with the board’s MCP tool `spend_budget({'{'}taskId, to, amount, note{'}'})` while the job is active.</p>
      )}
      {error !== null && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </Card>
  )
}
