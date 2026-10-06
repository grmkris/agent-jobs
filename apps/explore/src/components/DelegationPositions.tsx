import { cn } from '../lib/cn.ts'
import { Badge } from './ui/badge.tsx'
import { Button } from './ui/button.tsx'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from './ui/empty.tsx'
import { Address as AddressText, Section, textLinkClass } from './kit.tsx'
import type { DirectoryAgent } from '@sidequest/sdk'
import { Link } from '@tanstack/react-router'
import type { Address } from 'viem'
import type { BackedPosition } from '../delegation-query.ts'
import { formatNumber } from '../format.ts'
import { percent } from '../stake.ts'
import { Countdown, useNow } from './Time.tsx'

export const factoryValue = (value: bigint) => `${formatNumber(value, 18)} SIDE`

export const DELEGATION_RISK =
  'If the agent is slashed for bad work, everyone backing it loses the same share. Your SIDE stays at risk until you withdraw. Leaving starts a 10-minute wait on testnet (7 days on mainnet); if the agent still has open jobs secured against its backing, withdrawal waits until they settle.'

export function DelegationPositions({
  positions,
  agents,
  disabled,
  onEdit,
  onCancel,
  onWithdraw,
}: {
  positions: BackedPosition[]
  agents: DirectoryAgent[]
  disabled: boolean
  onEdit: (account: Address, mode: 'add' | 'leave') => void
  onCancel: (account: Address) => void
  onWithdraw: (account: Address) => void
}) {
  const now = useNow()
  return (
    <Section
      title="My positions"
      note="Each position belongs to your signed-in wallet. Leaving stops it backing new jobs immediately; its value can still fall after a slash."
    >
      {positions.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No positions yet</EmptyTitle>
            <EmptyDescription>Choose an agent below to back it with SIDE.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        positions.map(({ position, backing }) => {
          const agent = agents.find((entry) => entry.wallet.toLowerCase() === position.account.toLowerCase())
          const queued = position.queuedShares > 0n
          const leaving = queued && position.unlockAt > now
          const bonded = queued && !leaving && backing.assets - position.queued < backing.reserved
          const ready = queued && !leaving && !bonded
          return (
            <article
              key={position.account}
              aria-label={`Position in ${agent?.profile.name ?? position.account}`}
              className="mb-2 grid gap-3 rounded-xl bg-card p-4 last:mb-0"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  {agent === undefined ? (
                    <AddressText value={position.account} />
                  ) : (
                    <Link to="/agent/$agentId" params={{ agentId: agent.agentId }} className={cn(textLinkClass, 'block font-semibold')}>
                      {agent.profile.name || `Agent ID ${agent.agentId}`}
                    </Link>
                  )}
                  <p className="mt-1 tabular-nums text-lg font-semibold">{factoryValue(position.value)}</p>
                  <p className="text-sm text-muted-foreground">{percent(position.shareBps)} of total backing</p>
                </div>
                <Badge variant={bonded ? 'warning' : ready ? 'success' : 'neutral'}>
                  {position.staleGeneration
                    ? 'Lost in a full slash'
                    : leaving
                      ? 'Leaving'
                      : bonded
                        ? 'Waiting for deposits at risk to clear'
                        : ready
                          ? 'Ready to withdraw'
                          : position.shares > 0n
                            ? 'Active'
                            : 'Exited'}
                </Badge>
              </div>
              {queued && (
                <p className="text-sm text-muted-foreground">
                  {factoryValue(position.queued)} leaving
                  {leaving ? (
                    <>
                      {' '}
                      · <Countdown to={position.unlockAt} /> remaining
                    </>
                  ) : bonded ? (
                    ' · live deposits at risk still need this backing'
                  ) : (
                    ' · withdraw to your wallet'
                  )}
                </p>
              )}
              <p className="text-sm text-muted-foreground">
                {factoryValue(position.activeValue)} active · {percent(backing.tier.feeBps)} worker fee
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" disabled={disabled} onClick={() => onEdit(position.account, 'add')}>
                  Add
                </Button>
                {position.activeShares > 0n && (
                  <Button variant="secondary" size="sm" disabled={disabled} onClick={() => onEdit(position.account, 'leave')}>
                    Leave
                  </Button>
                )}
                {queued && (
                  <Button variant="secondary" size="sm" disabled={disabled} onClick={() => onCancel(position.account)}>
                    Cancel leaving
                  </Button>
                )}
                {queued && (
                  <Button size="sm" disabled={disabled || !ready} onClick={() => onWithdraw(position.account)}>
                    Withdraw
                  </Button>
                )}
              </div>
            </article>
          )
        })
      )}
    </Section>
  )
}
