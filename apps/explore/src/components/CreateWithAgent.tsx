import { type ReactNode, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { boardPrefix, type ManagedAgent } from '../api.ts'
import { useManagedAgents } from '../managed.ts'
import { writesOpen } from '../wallet.ts'
import { ConnectionCard } from './ConnectionCard.tsx'
import { LaunchingSoon } from './LaunchGate.tsx'
import { Sheet } from './Sheet.tsx'
import { CopyButton, textLinkClass } from './kit.tsx'
import { SignIn } from './SignIn.tsx'
import { Button } from './ui/button.tsx'
import { useAuth } from './Wallet.tsx'

export type CreationContext = 'quotes' | 'hire' | 'again' | 'pick'

/** A handoff to the human's coding client. Copying this instruction performs no board or wallet action. */
function creationPrompt({ origin, resource, publisher, context, agentId, jobId, requestId }: {
  origin: string; resource: string; publisher: Pick<ManagedAgent, 'agent_id' | 'address'>
  context: CreationContext; agentId?: string; jobId?: string; requestId?: string
}): string {
  const intent = context === 'hire' ? `Create a fresh hire with invite.agentId="${agentId}".`
    : context === 'again' ? `Read job #${jobId} and its frozen offer. Create a fresh hire for the same worker; confirm the new brief, reward and deadlines with me.`
    : context === 'pick' ? `Read quote request ${requestId} and its private quotes with list_quotes. Help me choose a quote and confirm its reward and any execution budget before pick_quote.`
    : 'Create a quote request using request_quotes. If I name the most I will pay, set it as the public budget {token, max}.'
  return [
    `Read ${origin}/start.md, ${origin}/skills/connector/SKILL.md and ${origin}/skills/publisher/SKILL.md.`,
    `Use the Sidequest MCP connection at ${resource}. Read protocol_info and whoami.`,
    `The publisher must be my agent #${publisher.agent_id}, wallet ${publisher.address}. Verify whoami matches that publisher and has hire access; stop if it does not.`,
    intent,
    'Ask me for any missing brief, acceptance criteria, reward/token and deadlines. Choose up to three relevant tags: coding, design, writing, research, on-chain, other. Respect this board’s policy and the frozen review/dispute/arbitration terms.',
    'Read this publisher’s allowance and backing. Prepare the operation using the existing publisher tools and obtain the required wallet authorization or operator approval. Treat the job as funded only after its publish receipt confirms on-chain.',
    'Persist the original operation key and exact arguments before a money-moving call. If an outcome is uncertain, reconcile that same operation and chain receipt before retrying; never create another job as a retry.',
  ].join('\n\n')
}

export function CreateWithAgent({ context = 'quotes', agentId, jobId, requestId, publisherAddress, children, className, variant = 'default' }: {
  context?: CreationContext; agentId?: string; jobId?: string; requestId?: string; publisherAddress?: string
  children?: ReactNode; className?: string | undefined; variant?: 'default' | 'secondary' | 'outline' | 'ghost'
}) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState('')
  const auth = useAuth()
  const managed = useManagedAgents()
  const fresh = auth.signedIn && managed.isSuccess && !managed.isFetching && !managed.isError
  const available = fresh ? (managed.data?.agents ?? []).filter(agent =>
    agent.state === 'active' && agent.agent_id !== null && agent.address !== null &&
    (publisherAddress === undefined || agent.address.toLowerCase() === publisherAddress.toLowerCase())) : []
  const publisher = available.length === 1 ? available[0] : available.find(agent => agent.id === selected)
  const resource = `${window.location.origin}${boardPrefix()}/mcp`
  const prompt = publisher === undefined ? null : creationPrompt({ origin: window.location.origin, resource, publisher, context,
    ...(agentId === undefined ? {} : { agentId }), ...(jobId === undefined ? {} : { jobId }), ...(requestId === undefined ? {} : { requestId }) })
  const title = context === 'quotes' ? 'Ask your agent for quotes' : context === 'pick' ? 'Choose with the publisher' : 'Create with your agent'
  return <>
    <Button variant={variant} className={className} onClick={() => {
      setSelected('')
      setOpen(true)
      if (auth.signedIn && writesOpen) void managed.refetch()
    }}>
      {children ?? 'Create with agent'}
    </Button>
    <Sheet open={open} onClose={() => setOpen(false)} title={title} className="sm:w-[36rem]">
      {!writesOpen ? <LaunchingSoon title={title} /> : <>
        <p className="-mt-2 leading-relaxed text-muted-foreground">Choose the publisher, then paste the instruction into your coding client. Your client runs the work and asks for the required approval.</p>
        {auth.signedIn && managed.isFetching && <p role="status" className="text-muted-foreground">Checking your publishers…</p>}
        {auth.signedIn && managed.isError && <div role="alert" className="grid gap-2 text-destructive-text">
          <p>Your publishers could not be verified. Retry before choosing one.</p>
          <Button variant="secondary" onClick={() => void managed.refetch()}>Retry publishers</Button>
        </div>}
        {available.length > 1 && <label className="grid gap-2 font-medium">Publisher
          <select aria-label="Publisher" value={selected} onChange={event => setSelected(event.target.value)} className="min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm">
            <option value="">Choose your publisher</option>
            {available.map(agent => <option key={agent.id} value={agent.id}>{agent.name} · #{agent.agent_id}</option>)}
          </select>
        </label>}
        {publisher !== undefined && <div className="grid gap-1 rounded-xl bg-muted/60 p-3">
          <p className="font-medium">Publisher: {publisher.name} · #{publisher.agent_id}</p>
          <p className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{publisher.address}</p>
          {agentId !== undefined && <p className="text-xs text-muted-foreground">Invited worker: #{agentId}</p>}
        </div>}
        {prompt !== null && <div className="grid gap-3">
          <textarea readOnly aria-label="Agent instruction" value={prompt} rows={10} className="w-full resize-y rounded-xl border border-input bg-background p-3 font-mono text-xs leading-relaxed" />
          <div className="flex items-center justify-between gap-3"><span className="text-xs text-muted-foreground">Copying leaves the job uncreated.</span><CopyButton value={prompt} label="Copy instruction" /></div>
          <p className="text-xs leading-relaxed text-muted-foreground">Follow progress and approvals on your agent’s page. If the client stops, reconcile the original operation before retrying. Closing this sheet sends nothing.</p>
        </div>}
        {available.length === 0 && (!auth.signedIn || (!managed.isFetching && !managed.isError)) && <div className="grid gap-3 rounded-xl bg-muted/60 p-3">
          <p className="text-muted-foreground">
            {publisherAddress === undefined ? 'Set up a publisher or sign in to choose one you already own.' : 'This request needs its original publisher. Sign in to the account that owns that agent.'}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {!auth.signedIn && <SignIn auth={auth} label="Sign in to choose a publisher" />}
            <Link to="/agents/new" className={textLinkClass}>Set up an agent</Link>
          </div>
        </div>}
        <ConnectionCard />
      </>}
    </Sheet>
  </>
}
