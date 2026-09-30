import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { formatEther, parseEther } from 'viem'
import { useBalance, useSignTypedData } from 'wagmi'
import { waitForTransactionReceipt } from 'wagmi/actions'
import { type Budget, type TaskIndexEntry, type TxRequest, tool } from '../api.ts'
import { budgetCap } from '../format.ts'
import { useTokenList } from '../useTokens.ts'
import { friendlyError } from '../txErrors.ts'
import { typedDataArgs } from '../typed-data.ts'
import { chain, wagmiConfig } from '../wallet.ts'
import { useDelegatorUpgrade } from './Privy.tsx'
import { TxSteps } from './TxSteps.tsx'
import { ConfirmSheet } from './Sheet.tsx'
import { When } from './Time.tsx'
import { Address, Badge, Button, ErrorText, Group, ListRow, Section, TxLink } from './ui.tsx'

const STATUS_TONE = { promised: 'attention', live: 'success', revoked: 'danger', ended: 'neutral' } as const
const STATUS_LABEL = { promised: 'Approved, not granted yet', live: 'Granted', revoked: 'Revoked', ended: 'Expired or used up' } as const
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
  useTokenList(eb?.kind === 'advance' ? [eb.token] : [])
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
      setError(friendlyError(e))
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

  const [confirm, setConfirm] = useState<'grant' | 'revoke' | 'disable' | null>(null)
  const cap = budgetCap(eb)
  const lingering = b !== undefined && (b.status === 'ended' || b.status === 'revoked') && b.redeemable
  return (
    <Section
      title="Running-cost budget"
      note="Money the agent may spend on the job, apart from the reward: from the creator’s wallet, not escrowed, capped and expiring. The chain enforces the cap through a delegation from the creator’s account."
    >
      <Group>
        <ListRow>
          <span className="flex-1">Approved</span>
          <span className="tabular font-semibold">{cap}</span>
        </ListRow>
        {eb.kind === 'call' && (
          <ListRow>
            <span className="flex-1 text-[0.9rem] text-label-2">
              One call to <span className="font-mono">{/function\s+(\w+)/.exec(eb.function ?? '')?.[1] ?? 'the function'}</span> on <Address value={eb.target} />, made from the creator’s account, so the creator owns what it makes.
            </span>
          </ListRow>
        )}
        <ListRow>
          <span className="flex-1">Until</span>
          <span className="text-label-2"><When at={eb.expiresAt} /></span>
        </ListRow>
        {b !== undefined && (
          <>
            <ListRow>
              <span className="flex-1">Status</span>
              <span className="text-right">
                <Badge tone={STATUS_TONE[b.status]}>{STATUS_LABEL[b.status]}</Badge>
                {b.endedReason !== null && <span className="block text-[0.8rem] text-label-2">{b.endedReason}</span>}
              </span>
            </ListRow>
            {b.kind === 'advance' ? (
              <>
                <ListRow>
                  <span className="flex-1">Drawn by the agent</span>
                  <span className="tabular text-label-2">{b.drawn} {b.symbol}</span>
                </ListRow>
                <ListRow>
                  <span className="flex-1">Left</span>
                  <span className="tabular text-label-2">{b.remaining} {b.symbol}</span>
                </ListRow>
              </>
            ) : (
              <ListRow>
                <span className="flex-1">The call</span>
                <span className="text-label-2">{b.calls?.made ?? 0} of 1 made{b.drawn !== '0' ? `, ${b.drawn} ${b.symbol} sent` : ''}</span>
              </ListRow>
            )}
            {b.draws.map((x) => (
              <ListRow key={x.drawId}>
                <Badge tone={x.status === 'confirmed' ? 'success' : x.status === 'failed' ? 'danger' : 'attention'}>{x.status === 'confirmed' ? 'Spent' : x.status === 'failed' ? 'Failed' : 'Pending'}</Badge>
                <span className="min-w-0 flex-1 text-[0.9rem]">
                  {x.amount === null ? '' : `${x.amount} ${b.symbol}`}
                  {x.selector !== undefined ? ` · call ${x.selector}` : ''}
                  {x.note !== '' && <span className="block text-[0.82rem] text-label-2">{x.note}</span>}
                </span>
                <TxLink hash={x.txHash} />
              </ListRow>
            ))}
          </>
        )}
      </Group>
      {b === undefined && signedIn && party && budget.error !== null && <ErrorText>{friendlyError(budget.error)}</ErrorText>}
      {!signedIn && <p className="px-4 text-[0.85rem] text-label-2">Sign in as the creator, approver or agent to see what was spent.</p>}

      {creator && b !== undefined && (
        <div className="grid gap-2">
          {b.status === 'promised' && status !== 'active' && <p className="px-4 text-[0.88rem] text-label-2">Grant it once the agent has started: the grant names that agent.</p>}
          {b.status === 'promised' && status === 'active' && (
            <Button size="lg" busy={busy === 'grant'} onClick={() => setConfirm('grant')}>
              Grant the budget
            </Button>
          )}
          {(b.status === 'promised' || b.status === 'live') && (
            <Button variant="danger" busy={busy === 'revoke'} onClick={() => setConfirm('revoke')}>
              Revoke
            </Button>
          )}
          {lingering && (
            <div className="grid gap-2 rounded-xl bg-warn-bg px-4 py-3 text-[0.9rem] text-warn">
              <p>
                The signed grant stays valid on-chain until <When at={b.expiresAt} show="time" />: the agent could still spend it without the board. Disable it now.
              </p>
              <Button variant="danger" busy={busy === 'revoke'} onClick={() => setConfirm('disable')}>
                Disable on-chain
              </Button>
            </div>
          )}
          {eb.kind === 'call' && b.status !== 'ended' && b.status !== 'revoked' && mon.data !== undefined && mon.data.value < BigInt(eb.cap) + RESERVE && (
            <p className="px-4 text-[0.88rem] text-warn">
              Your wallet holds {formatEther(mon.data.value)} MON. The call may send up to {formatEther(BigInt(eb.cap))} MON, and Monad keeps 10 MON in a delegated account: hold at least{' '}
              {formatEther(BigInt(eb.cap) + RESERVE)} MON when the agent calls.
            </p>
          )}
        </div>
      )}
      {roles.includes('worker') && b?.status === 'live' && (
        <p className="px-4 text-[0.85rem] text-label-2">
          {eb.kind === 'call'
            ? 'Your agent makes the call with the MCP tool spend_budget_call, sends the transaction from its wallet, then reports it.'
            : 'Your agent draws with the MCP tool spend_budget, sends the transaction from its wallet, then reports it.'}{' '}
          get_budget holds the signed grant, which works without the board.
        </p>
      )}
      {error !== null && <ErrorText>{error}</ErrorText>}

      <ConfirmSheet
        open={confirm === 'grant'}
        onClose={() => setConfirm(null)}
        title="Grant the budget?"
        description={`You sign a grant that lets the agent spend up to ${cap} from your wallet until the date below. Nothing moves now; the chain enforces the cap, and you can revoke it at any time.`}
        confirm="Sign the grant"
        busy={busy === 'grant'}
        onConfirm={() => {
          setConfirm(null)
          void grant()
        }}
      >
        <p className="text-[0.9rem] text-label-2">
          Expires <When at={eb.expiresAt} />. The first grant from this wallet also points it at the delegation contract, which the board’s relay sends for you.
        </p>
      </ConfirmSheet>
      <ConfirmSheet
        open={confirm === 'revoke' || confirm === 'disable'}
        onClose={() => setConfirm(null)}
        title={confirm === 'disable' ? 'Disable the grant on-chain?' : 'Revoke the budget?'}
        description="The agent can no longer spend from it. What it already spent stays spent. One transaction from your wallet."
        confirm={confirm === 'disable' ? 'Disable it' : 'Revoke'}
        tone="destructive"
        busy={busy === 'revoke'}
        onConfirm={() => {
          setConfirm(null)
          void revoke()
        }}
      />
      {txs !== null && <Section title="Send from your wallet">
        {txs !== null && (
          <TxSteps
            taskId={task.taskId}
            txs={txs}
            onDone={() => {
              setTxs(null)
              void refresh()
            }}
          />
        )}
      </Section>}
    </Section>
  )
}
