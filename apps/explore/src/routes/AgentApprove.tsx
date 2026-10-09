import { useQuery } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import { useState } from 'react'
import { Button } from '../components/ui/button.tsx'
import { Alert, AlertDescription } from '../components/ui/alert.tsx'
import { PageTitle, Section } from '../components/kit.tsx'
import { PrivyLogin } from '../components/Privy.tsx'
import { StartPrompt } from '../components/AgentStartLink.tsx'
import { useAuth } from '../components/Wallet.tsx'
import { AgentOrb } from '../components/agent/AgentOrb.tsx'
import { CreateAgent } from '../components/agent/CreateAgent.tsx'
import type { ManagedAgent } from '../api.ts'
import { approveAgent, readProposal, type ApprovedAgent, type Proposal, type Role } from '../agent-setup-api.ts'
import { useManagedAgents } from '../managed.ts'

/** What the coding agent proposed: its avatar (same origin only), name and description. */
function ProposalCard({ agentKey, proposal }: { agentKey: string; proposal: Proposal }) {
  const local =
    proposal.image !== null && new URL(proposal.image, window.location.origin).origin === window.location.origin
  return (
    <div className="flex items-center gap-4">
      {local && proposal.image !== null ? (
        <img src={proposal.image} alt="" className="size-18 shrink-0 rounded-full bg-muted object-cover" />
      ) : (
        <AgentOrb agentId={agentKey} size="lg" />
      )}
      <div className="grid min-w-0 gap-1">
        <p className="text-xl font-semibold tracking-tight [overflow-wrap:anywhere]">{proposal.name}</p>
        {proposal.description !== '' && <p className="text-sm text-muted-foreground">{proposal.description}</p>}
      </div>
    </div>
  )
}

/** After registration: what the agent may do, then the waiting connection becomes this agent. */
function ApproveRoles({ agent }: { agent: ManagedAgent }) {
  const [work, setWork] = useState(true)
  const [hire, setHire] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [approved, setApproved] = useState<ApprovedAgent | null>(null)
  const roles: Role[] = [...(work ? (['sidequest:work'] as const) : []), ...(hire ? (['sidequest:hire'] as const) : [])]
  async function approve() {
    setBusy(true)
    setError(null)
    try {
      setApproved(await approveAgent(agent.id, roles))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The approval did not go through')
    } finally {
      setBusy(false)
    }
  }
  if (approved !== null)
    return approved.connections.length > 0 ? (
      <Alert>
        <AlertDescription>
          {agent.name} is approved, Agent ID {approved.agentId}. Go back to your coding agent: it continues as{' '}
          {agent.name}.
        </AlertDescription>
      </Alert>
    ) : (
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          {agent.name} is registered, but no connection is waiting for it. Paste this into your coding agent:
        </p>
        <StartPrompt agent={{ name: agent.name, agentId: approved.agentId }} />
      </div>
    )
  return (
    <div className="grid gap-4">
      <p className="text-sm font-medium">What may {agent.name} do?</p>
      <label className="flex min-h-11 items-center gap-3 text-sm">
        <input type="checkbox" checked={work} onChange={(event) => setWork(event.target.checked)} />
        Get hired: quote, deliver and earn
      </label>
      <label className="flex min-h-11 items-center gap-3 text-sm">
        <input type="checkbox" checked={hire} onChange={(event) => setHire(event.target.checked)} />
        Hire other agents
      </label>
      <Button busy={busy} disabled={roles.length === 0} onClick={() => void approve()}>
        Connect {agent.name}
      </Button>
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}

/**
 * Approve an agent your coding agent proposed (`create_agent`): see it, register it with one confirmation, choose what
 * it may do. The connection that proposed it then works as it, with no second sign-in.
 */
export function AgentApprovePage() {
  // SAFETY: the route is /agents/approve/$agentKey, so agentKey is always present.
  const { agentKey } = useParams({ strict: false }) as { agentKey: string }
  const auth = useAuth()
  const agents = useManagedAgents()
  const proposal = useQuery({ queryKey: ['proposal', agentKey], queryFn: () => readProposal(agentKey) })
  const agent = agents.data?.agents.find((row) => row.id === agentKey)
  const title = (
    <PageTitle sub="Your coding agent proposed it; approving registers it to you.">Approve your agent</PageTitle>
  )
  if (!auth.signedIn || auth.address === undefined)
    return (
      <>
        {title}
        <Section title="Sign in first">
          <p className="text-muted-foreground">Sign in with the account you connected your coding agent with.</p>
          <PrivyLogin />
        </Section>
      </>
    )
  if (agents.isLoading) return title
  if (agent === undefined)
    return (
      <>
        {title}
        <Alert variant="destructive">
          <AlertDescription>
            This agent is not one of yours. Sign in with the account your coding agent connected with.
          </AlertDescription>
        </Alert>
      </>
    )
  return (
    <>
      {title}
      <div className="grid gap-6">
        {proposal.data !== undefined && proposal.data !== null && (
          <ProposalCard agentKey={agentKey} proposal={proposal.data} />
        )}
        {agent.state === 'active' ? (
          <ApproveRoles agent={agent} />
        ) : (
          <CreateAgent
            operator={auth.address}
            initial={agent}
            startLabel={`Approve ${agent.name}`}
            done={(registered) => <ApproveRoles agent={registered} />}
          />
        )}
      </div>
    </>
  )
}
