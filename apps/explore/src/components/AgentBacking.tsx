import { cn } from '../lib/cn.ts'
import { Alert, AlertDescription } from './ui/alert.tsx'
import { Item, ItemGroup, ItemContent, ItemActions } from './ui/item.tsx'
import { Address as AddressText, LoadingRows, Section, textLinkClass } from './kit.tsx'
import { Link } from '@tanstack/react-router'
import type { Address } from 'viem'
import { useIndexedBacking } from '../delegation-query.ts'
import { percent } from '../stake.ts'
import { deployed } from '../wallet.ts'
import { DELEGATION_RISK, factoryValue } from './DelegationPositions.tsx'
import { Countdown, useNow } from './Time.tsx'

export function AgentBacking({ wallet, viewer }: { wallet: Address; viewer: Address | undefined }) {
  const read = useIndexedBacking(wallet, viewer)
  const now = useNow()
  if (!deployed) return null
  const snapshot = read.data
  return (
    <Section
      title="Backing"
      note="The fee tier counts active backing, including reserved bonds. Leaving positions stop counting immediately and remain exposed to slashes."
    >
      {read.isPending ? (
        <LoadingRows rows={3} />
      ) : read.isError || snapshot === undefined ? (
        <Alert variant="destructive">
          <AlertDescription>This agent&apos;s backing index is unavailable right now.</AlertDescription>
        </Alert>
      ) : (
        <>
          <ItemGroup>
            <Item>
              <ItemContent className="flex-1">Total backing</ItemContent>
              <span className="tabular-nums font-semibold">{factoryValue(snapshot.backing.assets)}</span>
            </Item>
            <Item>
              <ItemContent className="flex-1">Active backing</ItemContent>
              <span className="tabular-nums">{factoryValue(snapshot.backing.active)}</span>
            </Item>
            <Item>
              <ItemContent className="flex-1">Reserved by live jobs</ItemContent>
              <span className="tabular-nums">{factoryValue(snapshot.backing.reserved)}</span>
            </Item>
            <Item>
              <ItemContent className="flex-1">Available for new bonds</ItemContent>
              <span className="tabular-nums">{factoryValue(snapshot.backing.available)}</span>
            </Item>
            <Item>
              <ItemContent className="flex-1">Leaving</ItemContent>
              <span className="tabular-nums">{factoryValue(snapshot.backing.queued)}</span>
            </Item>
            <Item>
              <ItemContent className="flex-1">Delegators</ItemContent>
              <span className="tabular-nums">{snapshot.delegatorCount}</span>
            </Item>
            <Item>
              <ItemContent className="flex-1">Worker fee</ItemContent>
              <span className="tabular-nums">{percent(snapshot.backing.tier.feeBps)}</span>
            </Item>
            <Item>
              <ItemContent className="flex-1">Next fee tier</ItemContent>
              <ItemActions className="tabular-nums flex-col items-end text-right">
                {snapshot.backing.tier.nextThreshold === null
                  ? 'Lowest fee reached'
                  : `${factoryValue(snapshot.backing.tier.needed)} more to pay ${percent(snapshot.backing.tier.nextFeeBps!)}`}
              </ItemActions>
            </Item>
          </ItemGroup>

          {snapshot.topDelegators.length > 0 && (
            <Section title="Top delegators" className="mt-3">
              <ItemGroup>
                {snapshot.topDelegators.map((position) => (
                  <Item key={position.delegator}>
                    <AddressText value={position.delegator} />
                    <ItemActions className="tabular-nums ml-auto flex-col items-end text-right">
                      {factoryValue(position.value)}
                      <span className="block text-xs text-muted-foreground">{percent(position.shareBps)} of backing</span>
                    </ItemActions>
                  </Item>
                ))}
              </ItemGroup>
            </Section>
          )}

          {snapshot.position !== null && (
            <div className="mt-2 grid gap-1 rounded-xl bg-primary/10 p-4">
              <p className="text-sm font-semibold">Your position</p>
              <p className="tabular-nums text-lg font-semibold">
                {factoryValue(snapshot.position.value)} · {percent(snapshot.position.shareBps)}
              </p>
              {snapshot.position.queuedShares > 0n && (
                <p className="text-sm text-muted-foreground">
                  {factoryValue(snapshot.position.queued)} leaving ·{' '}
                  {snapshot.position.unlockAt > now ? (
                    <Countdown to={snapshot.position.unlockAt} />
                  ) : snapshot.backing.assets - snapshot.position.queued < snapshot.backing.reserved ? (
                    'Waiting for bonds to clear'
                  ) : (
                    'Ready to withdraw'
                  )}
                </p>
              )}
            </div>
          )}

          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{DELEGATION_RISK}</p>

          <Link
            to="/backing"
            search={{ account: wallet }}
            className={cn(
              textLinkClass,
              'mt-2 inline-flex min-h-11 items-center justify-center rounded-xl bg-primary/14 px-4 font-semibold',
            )}
          >
            Delegate
          </Link>
        </>
      )}
    </Section>
  )
}
