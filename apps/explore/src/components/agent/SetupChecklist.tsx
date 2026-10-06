import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, CircleHelp } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Address } from 'viem'
import { agentStatus } from '../../agent-api.ts'
import { setupCompletion } from '../../agent-setup.ts'
import type { ManagedAgent } from '../../api.ts'
import { useIndexedBacking } from '../../delegation-query.ts'
import { deployment } from '../../wallet.ts'
import { StartPrompt } from '../AgentStartLink.tsx'
import { AllowanceEditor } from '../AllowanceEditor.tsx'
import { BackingManager } from '../BackingManager.tsx'
import { BuyButtons } from '../Buy.tsx'
import { ConnectionCard } from '../ConnectionCard.tsx'
import { useNow } from '../Time.tsx'

function SetupRow({ number, title, note, done, children, id, open, onToggle }: {
  number: number
  title: string
  note: string
  done: boolean | null
  children: ReactNode
  id?: string
  open?: boolean
  onToggle?: (open: boolean) => void
}) {
  return (
    <details id={id} open={open} onToggle={onToggle === undefined ? undefined : (event) => onToggle(event.currentTarget.open)} className="group/setup scroll-mt-24 border-t border-border/70 first:border-t-0">
      <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 rounded-md px-1 py-3 outline-none select-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <span className={done ? 'grid size-7 shrink-0 place-items-center rounded-full bg-success/12 text-success-text' : 'grid size-7 shrink-0 place-items-center rounded-full bg-muted text-xs font-medium text-muted-foreground'}>
          {done ? <Check aria-hidden className="size-4" /> : done === null ? <CircleHelp aria-hidden className="size-4" /> : number}
        </span>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="text-sm font-medium">{title} <span className="sr-only">{done === null ? 'status unavailable' : done ? 'complete' : 'not complete'}</span></span>
          <span className="text-xs text-muted-foreground">{done === null ? 'Waiting for confirmed state' : note}</span>
        </span>
        <ChevronDown aria-hidden className="size-4 text-muted-foreground transition-transform duration-(--dur-fast) group-open/setup:rotate-180 motion-reduce:transition-none" />
      </summary>
      <div className="grid min-w-0 gap-4 px-1 pt-1 pb-4">{children}</div>
    </details>
  )
}

export function SetupChecklist({ agent, operator, wallet, backingOpen, onBackingOpenChange }: {
  agent: ManagedAgent
  operator: Address
  wallet: Address | undefined
  backingOpen: boolean
  onBackingOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const status = useQuery({ queryKey: ['managed-agent-status', agent.id, operator], queryFn: () => agentStatus(agent.id), refetchInterval: 15_000, retry: false })
  const position = useIndexedBacking(wallet ?? operator, operator)
  const now = useNow()
  const completed = setupCompletion({ status: status.isSuccess ? status.data : undefined, backing: wallet === undefined || !position.isSuccess ? undefined : position.data.position, now })
  return (
    <section aria-label="Agent setup" className="grid gap-2 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <div className="grid gap-1 px-1 pb-1">
        <h2 className="text-ui font-medium">Ready for Sidequest</h2>
        <p className="text-xs text-muted-foreground">Connect once. Set a budget to hire, and back it to take paid work.</p>
      </div>
      <div className="grid">
        <SetupRow number={1} title="Connect it" note={completed.connected ? 'Your coding agent has a confirmed connection' : 'Give your coding agent its Sidequest access'} done={completed.connected}>
          <StartPrompt />
          <ConnectionCard />
        </SetupRow>
        <SetupRow number={2} title="Set a weekly budget" note={completed.budget ? 'A live weekly spending limit is configured' : 'Hires within it go ahead without asking you'} done={completed.budget}>
          <AllowanceEditor agent={agent} onConfirmed={() => { void queryClient.invalidateQueries({ queryKey: ['managed-agent-status'] }) }} />
        </SetupRow>
        <SetupRow number={3} title="Back it" note={completed.backed ? 'Your wallet owns active backing for this agent' : 'The deposits at risk on jobs it takes come from its backing'} done={completed.backed} id="profile-backing" open={backingOpen} onToggle={onBackingOpenChange}>
          {wallet === undefined ? <p className="text-sm text-muted-foreground">The agent wallet is unavailable.</p> : <BackingManager owner={operator} scope={{ kind: 'agent', account: wallet, ...(agent.agent_id === null ? {} : { agentId: agent.agent_id }) }} />}
          {deployment.market === null ? <p className="text-xs text-muted-foreground">SIDE buying is unavailable on this network.</p> : <BuyButtons address={operator} />}
        </SetupRow>
      </div>
    </section>
  )
}
