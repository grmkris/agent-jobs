import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { cn } from '../lib/cn.ts'
import { Alert, AlertDescription } from '../components/ui/alert.tsx'
import { PageTitle, Section, Segmented, textLinkClass } from '../components/kit.tsx'
import { usePrivy } from '@privy-io/react-auth'
import { useQueryClient } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { useSearch } from '@tanstack/react-router'
import { type ReactNode, useState } from 'react'
import { type Address } from 'viem'
import { useSignTypedData } from 'wagmi'
import { agentEndpoint, type ManagedAgent } from '../api.ts'
import { agentAction, prepareRegistration } from '../agent-api.ts'
import { reviewAgentGrant } from '../agent-grant.ts'
import { AgentGrantReview } from '../components/AgentGrantReview.tsx'
import { BoardLink } from '../components/BoardLink.tsx'
import { OperatorGrant } from '../components/OperatorGrant.tsx'
import { PrivyLogin } from '../components/Privy.tsx'

import { StartPrompt } from '../components/AgentStartLink.tsx'
import { useAuth } from '../components/Wallet.tsx'
import { agentHome, useManagedAgents } from '../managed.ts'
import { AllowanceEditor } from '../components/AllowanceEditor.tsx'
import { AgentStake } from '../components/AgentStake.tsx'
import { ConnectionCard } from '../components/ConnectionCard.tsx'
import { typedDataArgs } from '../typed-data.ts'
import { privyAppId } from '../wallet.ts'

/** Create an agent, or (`?resume=<id>`) continue the setup of one that has no Agent ID yet. */
export function AgentNewPage() {
  const { resume } = useSearch({ strict: false }) as { resume?: string }
  const agents = useManagedAgents()
  const initial = resume === undefined ? undefined : agents.data?.agents.find((agent) => agent.id === resume)
  return (
    <>
      <PageTitle sub="Your wallet owns the identity. The agent has its own wallet.">
        {resume === undefined ? 'Create an agent' : 'Finish setting up your agent'}
      </PageTitle>

      {resume !== undefined && initial === undefined ? (
        agents.isLoading ? (
          <p className="text-label-2">Reading your agent records…</p>
        ) : (
          <Alert variant="destructive">
            <AlertDescription>
              That agent is not one of yours, or its records are unavailable. Sign in with its operator wallet.
            </AlertDescription>
          </Alert>
        )
      ) : (
        <AgentNew {...(initial === undefined ? {} : { initial })} />
      )}
    </>
  )
}

export function AgentNew({
  initial,
  onReady,
  context = 'standalone',
}: {
  initial?: ManagedAgent
  onReady?: (agent: ManagedAgent) => void
  context?: 'standalone' | 'oauth'
}) {
  const auth = useAuth()
  if (privyAppId === '' || !auth.signedIn || auth.address === undefined)
    return (
      <Section title="Sign in first">
        <p className="text-label-2">Sign in with your operator wallet to create an agent.</p>
        <PrivyLogin />
      </Section>
    )
  return (
    <AgentSetup
      key={initial?.id ?? auth.address}
      operator={auth.address}
      context={context}
      {...(initial === undefined ? {} : { initial })}
      {...(onReady === undefined ? {} : { onReady })}
    />
  )
}

function AgentSetup({
  operator,
  initial,
  onReady,
  context,
}: {
  operator: Address
  initial?: ManagedAgent
  onReady?: (agent: ManagedAgent) => void
  context: 'standalone' | 'oauth'
}) {
  const { getAccessToken } = usePrivy()
  const queryClient = useQueryClient()
  const { signTypedDataAsync } = useSignTypedData()
  const [name, setName] = useState(initial?.name ?? '')
  const [draft] = useState(() => {
    if (initial !== undefined) return { id: initial.id, name: initial.name }
    try {
      const saved = JSON.parse(localStorage.getItem(`sidequest.agent-draft:${operator}`) ?? 'null') as { id: string; name: string } | null
      if (saved !== null) return saved
    } catch {
      /* This tab keeps the same intent without storage. */
    }
    return { id: crypto.randomUUID(), name: '' }
  })
  const [agent, setAgent] = useState(initial)
  const [operatorReady, setOperatorReady] = useState(false)
  const [fundingReady, setFundingReady] = useState(false)
  const [role, setRole] = useState<'both' | 'hire' | 'work'>('both')
  const [review, setReview] = useState<ReturnType<typeof reviewAgentGrant> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Setup is unavailable; retry this step')
    } finally {
      setBusy(false)
    }
  }
  async function create() {
    if (draft.name === '') draft.name = name.trim() || 'My coding agent'
    try {
      localStorage.setItem(`sidequest.agent-draft:${operator}`, JSON.stringify(draft))
    } catch {
      /* The in-memory identity still survives retries. */
    }
    const token = await getAccessToken()
    setAgent(await agentEndpoint<ManagedAgent>('/api/agents', 'POST', draft, token ?? undefined))
    await queryClient.invalidateQueries({ queryKey: ['managed-agents', operator] })
  }
  async function prepare() {
    if (agent === undefined) return
    const prepared = await prepareRegistration(agent.id)
    setReview(reviewAgentGrant(prepared, { kind: 'registration', delegator: operator }))
  }
  async function register() {
    if (agent === undefined || review === null) return
    const signatureKey = `sidequest.registration-signature:${operator}:${agent.id}`
    const saved = JSON.parse(localStorage.getItem(signatureKey) ?? 'null') as {
      hash: string
      signature: string
    } | null
    const signature = saved?.hash === review.hash ? saved.signature : await signTypedDataAsync(typedDataArgs(review.typedData))
    localStorage.setItem(signatureKey, JSON.stringify({ hash: review.hash, signature }))
    const response = await agentAction<ManagedAgent | { status: string }>(agent.id, 'registration-confirm', {
      hash: review.hash,
      signature,
    })
    if (!('state' in response)) throw new Error(`Registration is ${response.status}. Retry this step to reconcile the saved sends.`)
    setAgent(response)
    setReview(null)
    await queryClient.invalidateQueries({ queryKey: ['managed-agents', operator] })
    try {
      localStorage.removeItem(`sidequest.agent-draft:${operator}`)
    } catch {
      /* Setup is already durably stored. */
    }
  }
  const active = agent !== undefined && agent.state === 'active'
  const steps = context === 'oauth' ? (['Identity', 'Choose'] as const) : (['Identity', 'Connect', 'Choose'] as const)
  return (
    <div className="grid gap-8">
      <Step
        n={1}
        of={steps}
        title="Identity"
        done={active}
        summary={active && agent !== undefined ? `${agent.name} · Agent ID ${agent.agent_id}` : undefined}
      >
        {agent === undefined ? (
          <>
            <label className="grid gap-2 text-sm">
              <span>Agent name</span>
              <Input
                value={name || draft.name}
                onChange={(event) => setName(event.target.value)}
                maxLength={100}
                placeholder="My coding agent"
              />
            </label>

            <p className="text-ui text-muted-foreground">
              Sidequest creates a separate wallet for it, owned by your account, and registers its Agent ID to your wallet.
            </p>

            <Button busy={busy} onClick={() => void run(create)}>
              Create agent wallet
            </Button>
          </>
        ) : agent.state !== 'active' ? (
          <>
            <p className="text-ui text-muted-foreground">
              {agent.name} · setup saved ({agent.state}). Retrying resumes the same wallet and registration.
            </p>

            {['created', 'upgraded'].includes(agent.state) ? (
              <Button busy={busy} onClick={() => void run(async () => setAgent(await agentAction<ManagedAgent>(agent.id, 'resume')))}>
                Resume wallet setup
              </Button>
            ) : !operatorReady ? (
              <OperatorGrant operator={operator} onReady={() => setOperatorReady(true)} />
            ) : review === null ? (
              <Button busy={busy} onClick={() => void run(prepare)}>
                Review registration grant
              </Button>
            ) : (
              <>
                <AgentGrantReview description={review.description} />

                <Button busy={busy} onClick={() => void run(register)}>
                  Sign registration permission
                </Button>
              </>
            )}
          </>
        ) : (
          <p className="text-ui text-muted-foreground">
            Agent ID {agent.agent_id} is registered to your wallet. The agent&apos;s own wallet holds its earnings and job obligations;
            anyone who backs it keeps ownership of their SIDE.
          </p>
        )}
      </Step>
      {active && agent !== undefined && context === 'standalone' && (
        <Step
          n={2}
          of={steps}
          title="Connect"
          summary="Paste this into your coding agent, or add Sidequest to its MCP settings. It asks you once whether to work, hire or both."
        >
          <StartPrompt />
          <ConnectionCard />
        </Step>
      )}
      {active && agent !== undefined && (
        <Step
          n={steps.length}
          of={steps}
          title="Choose"
          summary={
            context === 'oauth'
              ? 'You can connect now. A weekly budget and backing can be added later.'
              : 'An agent can hire other agents, get hired, or both. Either part can wait.'
          }
        >
          <Segmented
            label="What this agent does"
            value={role}
            onChange={setRole}
            options={[
              ['both', 'Both'],
              ['hire', 'Hire'],
              ['work', 'Get hired'],
            ]}
          />
          {context === 'oauth' && onReady !== undefined && (
            <Button onClick={() => onReady(agent)}>Use this agent for this connection</Button>
          )}
          {role !== 'work' && (
            <Part title="Hire · weekly budget" note="What it may spend each week without asking you. Bigger spends wait for your approval.">
              {context === 'oauth' ? (
                <details>
                  <summary className="cursor-pointer text-sm font-medium">Optional weekly spending allowance</summary>
                  <div className="pt-3">
                    <AllowanceEditor agent={agent} onConfirmed={() => setFundingReady(true)} />
                  </div>
                </details>
              ) : (
                <AllowanceEditor agent={agent} onConfirmed={() => setFundingReady(true)} />
              )}
            </Part>
          )}
          {role !== 'hire' && (
            <Part
              title="Get hired · backing"
              note="A worker's deposit comes from the SIDE behind it, and bad work can lose it. Back your agent now or later."
            >
              {context === 'oauth' ? (
                <details>
                  <summary className="cursor-pointer text-sm font-medium">Optional SIDE backing</summary>
                  <div className="pt-3">
                    <AgentStake agent={agent} operator={operator} />
                  </div>
                </details>
              ) : (
                <AgentStake agent={agent} operator={operator} />
              )}
            </Part>
          )}
          {/* Room for the listing the agent drafts for itself ("Review the listing your agent drafted → Publish"),
              once self-listing is decided. */}
          {context === 'standalone' && onReady !== undefined && (
            <Button disabled={!fundingReady} onClick={() => onReady(agent)}>
              Use this agent for this connection
            </Button>
          )}
          {onReady === undefined && (
            <BoardLink target={agentHome(agent)} className={textLinkClass}>
              Open this agent
            </BoardLink>
          )}
        </Step>
      )}
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}

/**
 * One numbered step of agent setup (Identity, Connect, Choose; OAuth has no Connect step, the client is already
 * connecting). A finished step keeps its one-line summary and a check.
 */
function Step({
  n,
  of,
  title,
  done = false,
  summary,
  children,
}: {
  n: number
  of: readonly string[]
  title: string
  done?: boolean
  summary?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3 gap-y-4">
      <span
        aria-hidden
        className={cn(
          'grid size-7 place-items-center rounded-full text-xs font-semibold tabular',
          done ? 'bg-success/15 text-success-text' : 'bg-foreground text-background',
        )}
      >
        {done ? <Check className="size-4" /> : n}
      </span>
      <div className="grid min-w-0 gap-1 pt-0.5">
        <h2 className="text-base leading-tight font-semibold tracking-tight">
          <span className="sr-only">
            Step {n} of {of.length}:{' '}
          </span>
          {title}
        </h2>
        {summary !== undefined && <p className="text-sm text-muted-foreground">{summary}</p>}
      </div>
      <div className="col-start-2 grid min-w-0 gap-5">{children}</div>
    </div>
  )
}

/** One role's part of the Choose step. */
function Part({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <div className="grid gap-0.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-ui text-muted-foreground">{note}</p>
      </div>
      {children}
    </div>
  )
}
