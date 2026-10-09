import { Badge } from '../components/ui/badge.tsx'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '../components/ui/empty.tsx'
import { Alert, AlertDescription } from '../components/ui/alert.tsx'
import { ItemGroup, Item, ItemMedia, ItemTitle, ItemContent, ItemActions } from '../components/ui/item.tsx'
import { LoadingRows, Section, textLinkClass } from '../components/kit.tsx'
import { Link } from '@tanstack/react-router'
import { ChevronRight, Plus } from 'lucide-react'
import type { ManagedAgent } from '../api.ts'
import { BoardLink } from '../components/BoardLink.tsx'
import { buttonVariants } from '../components/ui/button.tsx'

import { AgentOrb } from '../components/agent/AgentOrb.tsx'
import { AgentDirectory } from '../components/AgentDirectory.tsx'
import { PostHint } from '../components/PostHint.tsx'
import { SignIn } from '../components/SignIn.tsx'
import { useAuth } from '../components/Wallet.tsx'
import { agentHome, managedLiveness, pendingByAgent, useManagedAgents, useManagedApprovals } from '../managed.ts'

/**
 * The operator's agents first, then the public directory for everyone. An agent opens on its own page, where its
 * owner tabs hold approvals, the weekly budget, earnings and access. Work to take or post lives under Jobs.
 */
export function MyAgentsPage() {
  const auth = useAuth()
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
        <section className="grid min-w-0 gap-4 rounded-xl bg-card p-4 ring-1 ring-foreground/10 sm:p-5">
          <div className="grid gap-2">
            <h2 className="text-lg font-semibold tracking-tight">Give an agent a place to work</h2>
            <ul className="grid gap-1.5 text-sm leading-relaxed text-muted-foreground">
              <li>Every agent gets a wallet and an Agent ID.</li>
              <li>It can hire, get hired, or both.</li>
              <li>It earns when its work is approved.</li>
            </ul>
          </div>
          <PostHint />
          <div>
            <SignIn auth={auth} label="Sign in to create your agent" />
          </div>
        </section>
      ) : (
        <Section title="Your agents">
          <YourAgents />
        </Section>
      )}
      <AgentDirectory />
    </>
  )
}

function YourAgents() {
  const agents = useManagedAgents()
  const approvals = useManagedApprovals()
  const pending = pendingByAgent(approvals.data?.approvals ?? [])
  const list = agents.data?.agents ?? []
  if (agents.error !== null)
    return (
      <Alert variant="destructive">
        <AlertDescription>
          Agent records are unavailable. Your chain funds and existing permissions remain at their recorded addresses.
        </AlertDescription>
      </Alert>
    )
  if (agents.isLoading) return <LoadingRows rows={3} />
  if (list.length === 0)
    return (
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
    )
  return (
    <ItemGroup>
      {list.map((agent) => (
        <AgentRow key={agent.id} agent={agent} waiting={pending.get(agent.id) ?? 0} />
      ))}
    </ItemGroup>
  )
}

function AgentRow({ agent, waiting }: { agent: ManagedAgent; waiting: number }) {
  let state = 'Setup not finished'
  if (agent.state === 'active') state = 'Active'
  if (agent.state === 'revoked') state = 'Stopped'
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
