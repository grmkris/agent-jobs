import { Item, ItemGroup, ItemContent } from './ui/item.tsx'
import { Details, Address } from './kit.tsx'
import type * as sdk from '@sidequest/sdk'

export function AgentGrantReview({ description }: { description: ReturnType<typeof sdk.describeGrant> }) {
  return (
    <div className="grid gap-3">
      <p className="text-sm leading-relaxed text-muted-foreground">
        Review the permission before your wallet signs. It expires on{' '}
        {new Date(description.expiresAt * 1000).toLocaleString()}.
      </p>
      <ItemGroup>
        <Item>
          <ItemContent className="flex-1">Native value</ItemContent>
          <span>{description.nativeValue} MON</span>
        </Item>
        <Item>
          <ItemContent className="flex-1">Calls</ItemContent>
          <span>{description.calls ?? 'Limited by the spending cap'}</span>
        </Item>
        {description.periodSeconds !== null && (
          <Item>
            <ItemContent className="flex-1">Fixed period</ItemContent>
            <span>7 days from {new Date(description.validAfter * 1000).toLocaleString()}</span>
          </Item>
        )}
      </ItemGroup>
      <Details summary="Technical details">
        <ItemGroup>
          <Item>
            <ItemContent className="flex-1">From your wallet</ItemContent>
            <Address value={description.delegator} />
          </Item>
          <Item>
            <ItemContent className="flex-1">Granted to</ItemContent>
            <Address value={description.delegate} />
          </Item>
          {description.recipient !== null && (
            <Item>
              <ItemContent className="flex-1">Pinned recipient or spender</ItemContent>
              <Address value={description.recipient} />
            </Item>
          )}
          {description.token !== null && (
            <Item>
              <ItemContent className="flex-1">Token</ItemContent>
              <Address value={description.token} />
            </Item>
          )}
          {description.amount !== null && (
            <Item>
              <ItemContent className="flex-1">Maximum in base units</ItemContent>
              <span className="max-w-[60%] break-all font-mono text-xs">{description.amount}</span>
            </Item>
          )}
        </ItemGroup>
        <p className="text-sm font-medium">Allowed contracts and methods</p>
        <div className="grid gap-3">
          {description.targets.map((target) => (
            <div key={target.address} className="grid gap-1">
              <Address value={target.address} />
              <p className="break-words text-xs text-muted-foreground">{target.methods.join(', ')}</p>
            </div>
          ))}
        </div>
      </Details>
    </div>
  )
}
