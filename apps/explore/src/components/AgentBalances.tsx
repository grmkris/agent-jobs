import { cn } from '../lib/cn.ts'
import { Button } from './ui/button.tsx'
import { Input } from './ui/input.tsx'
import { Alert, AlertDescription } from './ui/alert.tsx'
import { Section, textLinkClass } from './kit.tsx'
import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useBacking } from '../delegation-query.ts'
import { factoryAmount } from '../stake.ts'
import { Countdown, useNow } from './Time.tsx'
import { type Address, erc20Abi } from 'viem'
import { useReadContracts } from 'wagmi'
import type { ManagedAgent } from '../api.ts'
import { agentAction } from '../agent-api.ts'
import { chain, deployment } from '../wallet.ts'
import { amount } from '../format.ts'
import { useTokenList } from '../useTokens.ts'

export function AgentBalances({
  agent,
  operationKey,
  onConfirmed,
}: {
  agent: ManagedAgent
  operationKey: string
  onConfirmed: () => void
}) {
  const tokens = [...new Set(deployment.rewardTokens.concat(deployment.factory))]
  useTokenList(tokens)
  const wallet = agent.address as Address
  const backingRead = useBacking(wallet, wallet)
  const now = useNow()
  const reads = useReadContracts({
    contracts: tokens.map(
      (token) =>
        ({
          address: token,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [agent.address as Address],
          chainId: chain.id,
        }) as const,
    ),
    query: { refetchInterval: 15000 },
  })
  const [unstake, setUnstake] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const journalKey = `sidequest.agent-action:${agent.id}`
  const [pending, setPending] = useState<{
    tool: string
    args: Record<string, unknown>
    key: string
  } | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(journalKey) ?? 'null') as {
        tool: string
        args: Record<string, unknown>
        key: string
      } | null
    } catch {
      return null
    }
  })
  async function execute(tool: string, args: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    try {
      if (pending !== null && (pending.tool !== tool || JSON.stringify(pending.args) !== JSON.stringify(args)))
        throw new Error('Reconcile the saved action before starting another')
      const intent = pending ?? { tool, args, key: operationKey }
      localStorage.setItem(journalKey, JSON.stringify(intent))
      if (localStorage.getItem(journalKey) !== JSON.stringify(intent)) throw new Error('Action journal is not durable; nothing may start')
      setPending(intent)
      const result = await agentAction<{ status: string; operationId: string }>(agent.id, 'execute', {
        tool,
        args,
        operationKey: intent.key,
      })
      if (result.status === 'confirmed') {
        localStorage.removeItem(journalKey)
        setPending(null)
        onConfirmed()
        await reads.refetch()
        await backingRead.refetch()
      } else if (result.status === 'approval') {
        localStorage.removeItem(journalKey)
        setPending(null)
        onConfirmed()
        setError('Approval to leave the exact agent-owned shares is waiting in Approvals.')
      } else setError(`Operation ${result.operationId} is ${result.status}. Retry the same action to reconcile.`)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The action is unavailable; keep the original operation key')
    } finally {
      setBusy(false)
    }
  }
  const backing = backingRead.data?.backing
  const position = backingRead.data?.position
  const stale = backingRead.isError || reads.isError
  const quantity = factoryAmount(unstake)
  const requestReady = !stale && position !== null && position !== undefined && quantity !== null && quantity <= position.activeValue
  const queued = position !== null && position !== undefined && position.queuedShares > 0n
  const leaving = queued && position.unlockAt > now
  const bonded = queued && backing !== undefined && backing.assets - position.queued < backing.reserved
  return (
    <Section
      title="Agent earnings and backing"
      note="Earnings are held by the agent wallet. Operator-funded backing belongs to the operator; only agent-owned mining positions can be left here."
    >
      {tokens.map((token, index) => {
        const balance = reads.data?.[index]
        return (
          <div key={token} className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-2">
            <span>{balance?.status === 'success' ? amount(String(balance.result), token) : 'Balance unavailable'}</span>
            <Button
              variant="secondary"
              size="sm"
              busy={busy}
              disabled={reads.isError || balance?.status !== 'success' || balance.result === 0n}
              onClick={() => void execute('sweep_earnings', { token })}
            >
              Move earnings to my wallet
            </Button>
          </div>
        )
      })}
      <p className="text-sm">Total backing: {backing === undefined ? 'unavailable' : amount(String(backing.assets), deployment.factory)}</p>
      {position === undefined || position === null || stale ? (
        <p className="text-sm text-muted-foreground">The agent-owned position is unavailable. Actions wait for current chain facts.</p>
      ) : (
        <>
          <p className="text-sm">Agent-owned position: {amount(String(position.value), deployment.factory)}</p>

          {position.shares === 0n && (
            <p className="rounded-xl bg-primary/10 p-3 text-sm text-muted-foreground">
              This agent does not own a position. Operator backing belongs to the operator wallet.
            </p>
          )}

          <Link to="/backing" search={{ account: wallet }} className={cn(textLinkClass, 'min-h-11 content-center text-sm')}>
            Manage your operator position
          </Link>

          {queued && (
            <p role="status" className="rounded-xl bg-warning/14 p-3 text-sm text-warning-text">
              Leaving {amount(String(position.queued), deployment.factory)}.{' '}
              {leaving ? (
                <>
                  <Countdown to={position.unlockAt} /> remaining.
                </>
              ) : bonded ? (
                'Waiting for bonds to clear.'
              ) : (
                'Ready to withdraw.'
              )}{' '}
              Queued shares stay exposed to slashes.
            </p>
          )}

          {position.activeShares > 0n && (
            <div className="flex flex-wrap gap-2">
              <Input
                value={unstake}
                onChange={(event) => setUnstake(event.target.value)}
                placeholder="SIDE amount"
                aria-label="Agent-owned amount to leave"
                inputMode="decimal"
              />
              <Button
                variant="secondary"
                busy={busy}
                disabled={!requestReady}
                onClick={() => void execute('request_unstake', { amount: unstake })}
              >
                Request leaving approval
              </Button>
            </div>
          )}

          {queued && (
            <Button variant="secondary" busy={busy} disabled={leaving || bonded} onClick={() => void execute('withdraw_stake', {})}>
              Withdraw agent-owned position
            </Button>
          )}
        </>
      )}
      {pending !== null && (
        <Button variant="secondary" busy={busy} onClick={() => void execute(pending.tool, pending.args)}>
          Reconcile saved action
        </Button>
      )}
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </Section>
  )
}
