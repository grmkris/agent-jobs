import { Link } from '@tanstack/react-router'
import { ChevronRight, Plus } from 'lucide-react'
import type { ManagedAgent } from '../api.ts'
import { BoardLink } from '../components/BoardLink.tsx'
import { buttonVariants } from '../components/ui/button.tsx'
import { Badge, EmptyState, ErrorText, Group, LoadingRows, rowClass, textLinkClass } from '../components/ui.tsx'
import { Monogram, useAuth } from '../components/Wallet.tsx'
import { agentHome, pendingByAgent, useManagedAgents, useManagedApprovals } from '../managed.ts'

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
        <EmptyState title="Sign in to see your agents">
          Use your operator wallet. Looking for an agent to hire?{' '}
          <Link to="/workers" className={textLinkClass}>
            Browse workers
          </Link>
        </EmptyState>
      ) : agents.error !== null ? (
        <ErrorText>Agent records are unavailable. Your chain funds and existing permissions remain at their recorded addresses.</ErrorText>
      ) : agents.isLoading ? (
        <LoadingRows rows={3} />
      ) : list.length === 0 ? (
        <EmptyState title="Your first agent starts here">
          Give it a name, connect your coding agent, then choose whether it hires, gets hired, or both.{' '}
          <Link to="/agents/new" className={textLinkClass}>
            Create an agent
          </Link>
        </EmptyState>
      ) : (
        <Group>
          {list.map((agent) => (
            <AgentRow key={agent.id} agent={agent} waiting={pending.get(agent.id) ?? 0} />
          ))}
        </Group>
      )}
    </>
  )
}

function AgentRow({ agent, waiting }: { agent: ManagedAgent; waiting: number }) {
  const state = agent.state === 'active' ? 'Active' : agent.state === 'revoked' ? 'Stopped' : 'Setup not finished'
  return (
    <BoardLink target={agentHome(agent)} className={rowClass({ inset: true, interactive: true })}>
      <Monogram seed={agent.agent_id ?? agent.id} label={initials(agent.name)} size="md" />
      <span className="grid min-w-0 flex-1">
        <span className="truncate font-medium">{agent.name}</span>
        <span className="truncate text-ui text-muted-foreground">
          {agent.agent_id === null ? 'No Agent ID yet' : `Agent ID ${agent.agent_id}`} · {state}
        </span>
      </span>
      {waiting > 0 && <Badge tone="warning">{waiting} waiting</Badge>}
      <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    </BoardLink>
  )
}

/** Up to two initials for a name's monogram: "My worker" → "MW". */
export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter((word) => word !== '')
    .slice(0, 2)
    .map((word) => [...word][0]?.toUpperCase() ?? '')
    .join('')
