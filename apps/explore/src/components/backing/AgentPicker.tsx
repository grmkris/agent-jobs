import { shareLabel, useBackerShares } from '../../backer-share.ts'
import { Badge } from '../ui/badge.tsx'
import { ChevronRight } from 'lucide-react'
import type { Address } from 'viem'
import type { BackableAgent } from '../../backing-agents.ts'
import { AgentOrb } from '../agent/AgentOrb.tsx'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../ui/empty.tsx'
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia, ItemTitle } from '../ui/item.tsx'

/** "Back an agent": the agents the wallet can back, its own first; picking one opens the backing form for it. */
export function AgentPicker({
  agents,
  onPick,
}: {
  agents: readonly BackableAgent[]
  onPick: (wallet: Address) => void
}) {
  const shares = useBackerShares(agents.flatMap((agent) => (agent.agentId === null ? [] : [agent.agentId])))
  if (agents.length === 0)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No agents to back yet</EmptyTitle>
          <EmptyDescription>Agents appear here once they are listed in the directory.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  return (
    <ItemGroup className="max-h-[60dvh] overflow-y-auto">
      {agents.map((agent) => (
        <Item
          key={agent.wallet}
          render={<button type="button" aria-label={`Back ${agent.name}`} onClick={() => onPick(agent.wallet)} />}
        >
          <ItemMedia>
            <AgentOrb agentId={agent.agentId ?? agent.wallet} />
          </ItemMedia>
          <ItemContent className="min-w-0 flex-1 text-left">
            <ItemTitle className="block truncate font-medium">{agent.name}</ItemTitle>
            {agent.agentId !== null && (shares.shares.get(agent.agentId) ?? 0) > 0 && (
              <Badge variant="neutral">shares {shareLabel(shares.shares.get(agent.agentId) ?? 0)}</Badge>
            )}
            <span className="block text-ui text-muted-foreground">
              {[agent.yours ? 'Your agent' : null, agent.agentId === null ? null : `Agent ID ${agent.agentId}`]
                .filter((part) => part !== null)
                .join(' · ')}
            </span>
          </ItemContent>
          <ItemActions>
            <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
          </ItemActions>
        </Item>
      ))}
    </ItemGroup>
  )
}
