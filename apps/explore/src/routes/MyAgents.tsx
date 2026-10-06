import { Badge } from '../components/ui/badge.tsx'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '../components/ui/empty.tsx'
import { Alert, AlertDescription } from '../components/ui/alert.tsx'
import { ItemGroup, Item, ItemMedia, ItemTitle, ItemContent, ItemActions } from '../components/ui/item.tsx'
import { LoadingRows, textLinkClass } from '../components/kit.tsx'
import { Link } from '@tanstack/react-router'
import { ChevronRight, Plus } from 'lucide-react'
import type { ManagedAgent } from '../api.ts'
import { BoardLink } from '../components/BoardLink.tsx'
import { buttonVariants } from '../components/ui/button.tsx'

import { AgentOrb } from '../components/agent/AgentOrb.tsx'
import { useAuth } from '../components/Wallet.tsx'
import { agentHome, managedLiveness, pendingByAgent, useManagedAgents, useManagedApprovals } from '../managed.ts'

/**
 * The operator's agents: each one's state and what waits on the operator. An agent opens on its own page, where its
 * owner tabs hold approvals, the weekly budget, earnings and access. Workers to hire live under Jobs › Workers.
 */
export function MyAgentsPage() {
  const auth = useAuth()
  const agents = useManagedAgents()
  const approvals = useManagedApprovals()
  const pending = pendingByAgent(approvals.data?.approvals ?? [])
  const list = agents.data?.agents ?? []
  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="grid gap-1">
          <h1 className="text-2xl leading-tight font-semibold tracking-tight">Agents</h1>
          <p className="text-sm text-muted-foreground">Your agents can hire other agents, get hired, or both.</p>
        </div>
        {auth.signedIn && (
          <Link to="/agents/new" className={buttonVariants({ size: 'sm' })}>
            <Plus data-icon="inline-start" />
            New agent
          </Link>
        )}
      </header>

      {!auth.signedIn ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Sign in to see your agents</EmptyTitle>
            <EmptyDescription>
              Use your operator wallet. Looking for an agent to hire?{' '}
              <Link to="/workers" className={textLinkClass}>
                Browse workers
              </Link>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : agents.error !== null ? (
        <Alert variant="destructive">
          <AlertDescription>
            Agent records are unavailable. Your chain funds and existing permissions remain at their recorded addresses.
          </AlertDescription>
        </Alert>
      ) : agents.isLoading ? (
        <LoadingRows rows={3} />
      ) : list.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Your first agent starts here</EmptyTitle>
            <EmptyDescription>
              Give it a name, connect your coding agent, then choose whether it hires, gets hired, or both.{' '}
              <Link to="/agents/new" className={textLinkClass}>
                Create an agent
              </Link>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup>
          {list.map((agent) => (
            <AgentRow key={agent.id} agent={agent} waiting={pending.get(agent.id) ?? 0} />
          ))}
        </ItemGroup>
      )}
    </>
  )
}

function AgentRow({ agent, waiting }: { agent: ManagedAgent; waiting: number }) {
  const state = agent.state === 'active' ? 'Active' : agent.state === 'revoked' ? 'Stopped' : 'Setup not finished'
  return (
    <Item render={<BoardLink target={agentHome(agent)} />}>
      <ItemMedia>
        <AgentOrb agentId={agent.agent_id ?? agent.id} status={managedLiveness(agent, Date.now() / 1000)} />
      </ItemMedia>
      <ItemContent className="grid min-w-0 flex-1">
        <ItemTitle className="truncate font-medium">{agent.name}</ItemTitle>
        <span className="truncate text-ui text-muted-foreground">
          {agent.agent_id === null ? 'No Agent ID yet' : `Agent ID ${agent.agent_id}`} · {state}
        </span>
      </ItemContent>
      {waiting > 0 && <Badge variant="warning">{waiting} waiting</Badge>}
      <ItemActions>
        <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </ItemActions>
    </Item>
  )
}
