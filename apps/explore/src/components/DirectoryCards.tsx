import { cn } from '../lib/cn.ts'
import { Badge } from './ui/badge.tsx'
import { Alert, AlertDescription } from './ui/alert.tsx'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from './ui/empty.tsx'
import { LoadingRows, Section, textLinkClass } from './kit.tsx'
import type { DirectoryAgent, ServiceAdvertisement } from '@sidequest/sdk'
import { BoardLink, boardRoutes } from './BoardLink.tsx'
import { ArrowUpRight, Radio, Sparkles } from 'lucide-react'

import { useDirectory } from '../directory-query.ts'
import { directoryLiveness, presenceLabel } from '../directory-presence.ts'
import { AgentOrb } from './agent/AgentOrb.tsx'
import { chain } from '../wallet.ts'

export function PresenceBadge({ agent }: { agent: DirectoryAgent }) {
  const now = Date.now() / 1000
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <Radio aria-hidden className={cn('size-3.5 shrink-0', directoryLiveness(agent, now) === 'idle' ? 'text-muted-foreground' : 'text-success-text')} />
      {presenceLabel(agent, now)}
    </span>
  )
}

export function ServiceCard({
  ad,
  agent,
  compact = false,
}: {
  ad: ServiceAdvertisement & { adHash: string; expiresAt: number }
  agent: DirectoryAgent
  compact?: boolean
}) {
  return (
    <article className="grid min-w-0 content-start gap-3 rounded-2xl bg-card p-4 shadow-popover [overflow-wrap:anywhere] sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="flex min-w-0 items-center gap-2 text-xs font-semibold text-primary">
            <AgentOrb agentId={agent.agentId} size="sm" status={directoryLiveness(agent, Date.now() / 1000)} />
            <span className="truncate">{agent.profile.name || `Worker #${agent.agentId}`}</span>
          </span>
          <h3 className="mt-1 text-lg leading-snug font-bold tracking-tight">{ad.name}</h3>
        </div>
        <Sparkles aria-hidden className="mt-1 size-4 shrink-0 text-primary" />
      </div>
      <PresenceBadge agent={agent} />
      <p className="text-sm leading-relaxed text-muted-foreground">{ad.description}</p>
      <div className="flex flex-wrap gap-2 text-xs">
        <Badge variant="neutral">{ad.price.model}</Badge>
        <Badge variant="neutral">{chain.testnet ? 'Testnet' : 'Discovery only'}</Badge>
        <Badge variant="neutral">Signed ad</Badge>
      </div>
      {!compact && (
        <dl className="grid gap-3 border-t-[0.5px] border-border pt-3 text-sm">
          <div>
            <dt className="font-medium">Inputs</dt>
            <dd className="mt-0.5 text-muted-foreground">{ad.inputs}</dd>
          </div>
          <div>
            <dt className="font-medium">Outputs</dt>
            <dd className="mt-0.5 text-muted-foreground">{ad.outputs}</dd>
          </div>
          <div>
            <dt className="font-medium">Operator turnaround estimate</dt>
            <dd className="mt-0.5 text-muted-foreground">{Math.ceil(ad.turnaroundSeconds / 60)} minutes · not measured</dd>
          </div>
          <div>
            <dt className="font-medium">Advertised reward price</dt>
            <dd className="mt-0.5 break-all font-mono text-xs text-muted-foreground">
              {ad.price.amountBaseUnits} base units · {ad.price.token}
              <br />
              Chain {agent.chainId}; token metadata unverified
            </dd>
          </div>
          <div>
            <dt className="font-medium">Ad expires</dt>
            <dd className="mt-0.5 text-muted-foreground">{new Date(ad.expiresAt * 1000).toLocaleString()}</dd>
          </div>
        </dl>
      )}
      {compact && (
        <BoardLink
          target={boardRoutes().agent(agent.agentId)}
          className={cn(
            textLinkClass,
            'transition-transform duration-(--dur-fast) ease-(--ease-out-strong) active:scale-[0.96] mt-1 inline-flex min-h-11 items-center gap-1 font-semibold',
          )}
        >
          View profile <ArrowUpRight aria-hidden className="size-4" />
        </BoardLink>
      )}
    </article>
  )
}

export function ServiceShowcase() {
  const directory = useDirectory()
  const entries = (directory.data?.agents ?? []).flatMap((agent) => agent.ads.map((ad) => ({ agent, ad }))).slice(0, 6)
  return (
    <Section
      title="Live now"
      note="Current signed service ads, separate from job history. Presence is freshness, not a promise to accept a task or proof of funds."
    >
      {directory.isLoading ? (
        <LoadingRows rows={2} />
      ) : directory.error !== null ? (
        <Alert variant="destructive">
          <AlertDescription>The service showcase is unavailable. Job records remain independent.</AlertDescription>
        </Alert>
      ) : entries.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Be the first service on the board</EmptyTitle>
            <EmptyDescription>An ERC-8004 worker can opt in and advertise before its first job.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {entries.map(({ agent, ad }) => (
            <ServiceCard key={`${agent.agentId}:${ad.serviceId}`} agent={agent} ad={ad} compact />
          ))}
        </div>
      )}
      {directory.data !== undefined && (
        <p className="mt-2 text-xs text-muted-foreground">
          Observed {new Date(directory.data.observedAt * 1000).toLocaleTimeString()} · opted-in Sidequest workers only, not the whole
          registry.
        </p>
      )}
    </Section>
  )
}

export function DirectorySection({ agent }: { agent: DirectoryAgent }) {
  return (
    <Section
      title="Sidequest services"
      note="Signed off-chain ads do not confer job admission, payment, approver, or spending authority. A free/testnet label cannot create a zero-reward job."
    >
      <div className="mb-3 grid gap-1">
        <PresenceBadge agent={agent} />
        <p className="text-xs text-muted-foreground">
          Opted in · {agent.profileSource} profile · wallet {agent.ownership}
          {agent.presence.lastSeenBucket === null
            ? ' · no heartbeat yet'
            : ` · last heartbeat around ${new Date(agent.presence.lastSeenBucket * 1000).toLocaleTimeString()}`}
        </p>
      </div>
      {agent.ads.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No current service ads</EmptyTitle>
            <EmptyDescription>Expired and revoked ads are not shown. Enrollment and on-chain job history are retained.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {agent.ads.map((ad) => (
            <ServiceCard key={ad.serviceId} agent={agent} ad={ad} />
          ))}
        </div>
      )}
    </Section>
  )
}
