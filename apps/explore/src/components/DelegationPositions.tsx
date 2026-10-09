import { cn } from '../lib/cn.ts'
import { useQuery } from '@tanstack/react-query'
import { Badge } from './ui/badge.tsx'
import { Button } from './ui/button.tsx'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from './ui/empty.tsx'
import { Address as AddressText, Section, textLinkClass } from './kit.tsx'
import { BoardLink, boardRoutes } from './BoardLink.tsx'
import type { Address } from 'viem'
import type { BackedPosition } from '../delegation-query.ts'
import { formatNumber } from '../format.ts'
import { percent } from '../stake.ts'
import { Countdown, useNow } from './Time.tsx'
import { TokenAmount } from './token/TokenAmount.tsx'
import { deployment } from '../wallet.ts'
import { data } from '../api.ts'
import { positionLabel, type PositionLabelSources } from '../position-label.ts'
import { AgentOrb } from './agent/AgentOrb.tsx'
import { Monogram } from './Wallet.tsx'

export const factoryValue = (value: bigint) => `${formatNumber(value, 18)} SIDE`

export const walletAgentsKey = (account: string) => [
  'data-agents-wallet',
  deployment.chainId,
  deployment.identity,
  account.toLowerCase(),
]

export const DELEGATION_RISK =
  'If the agent is slashed for bad work, everyone backing it loses the same share. Your SIDE stays at risk until you withdraw. Leaving starts the configured unstake period (3 days on the fresh testnet clocks; 14 days in production); open jobs secured against the backing remain slashable during that period.'

export function DelegationPositions({
  positions,
  sources,
  disabled,
  onEdit,
  onCancel,
  onWithdraw,
}: {
  positions: BackedPosition[]
  sources: PositionLabelSources
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
            <EmptyDescription>Back it with SIDE in the form below.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        positions.map(({ position, backing }) => {
          const queued = position.queuedShares > 0n
          const leaving = queued && position.unlockAt > now
          const bonded = queued && !leaving && backing.assets - position.queued < backing.reserved
          const ready = queued && !leaving && !bonded
          return (
            <article
              key={position.account}
              aria-label={`Position in ${positionLabel(position.account, sources).name}`}
              className="mb-2 grid gap-3 rounded-xl bg-card p-4 last:mb-0"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <PositionIdentity account={position.account} sources={sources} />
                  <p className="mt-1 text-lg font-semibold">
                    <TokenAmount value={position.value} token={deployment.factory} />
                  </p>
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
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={disabled}
                  onClick={() => onEdit(position.account, 'add')}
                >
                  Add
                </Button>
                {position.activeShares > 0n && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={disabled}
                    onClick={() => onEdit(position.account, 'leave')}
                  >
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

function PositionIdentity({ account, sources }: { account: Address; sources: PositionLabelSources }) {
  const local = positionLabel(account, sources)
  const walletAgents = useQuery({
    queryKey: walletAgentsKey(account),
    queryFn: () => data<{ agents: string[] }>(`agents?wallet=${encodeURIComponent(account)}`),
    enabled: local.kind === 'address',
    staleTime: 5 * 60_000,
  })
  const label = positionLabel(account, { ...sources, walletAgents: walletAgents.data?.agents })
  return (
    <div className="flex min-w-0 items-center gap-2">
      {label.kind === 'agent' ? <AgentOrb agentId={label.agentId ?? account} size="sm" /> : <Monogram seed={account} />}
      <span className="min-w-0">
        {label.agentId !== undefined ? (
          <BoardLink
            target={boardRoutes().agent(label.agentId)}
            className={cn(textLinkClass, 'flex min-h-11 min-w-0 items-center font-semibold')}
          >
            <span className="truncate">{label.name}</span>
          </BoardLink>
        ) : label.kind === 'address' ? (
          <AddressText value={account} />
        ) : (
          <span className="block truncate font-semibold">{label.name}</span>
        )}
        {label.hint !== undefined && <span className="block text-ui text-muted-foreground">{label.hint}</span>}
      </span>
    </div>
  )
}
