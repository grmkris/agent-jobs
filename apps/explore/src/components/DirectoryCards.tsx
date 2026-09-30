import type { DirectoryAgent, ServiceAdvertisement } from '@agent-jobs/sdk'
import { Link } from '@tanstack/react-router'
import { ArrowUpRight, Radio, Sparkles } from 'lucide-react'
import { Badge, EmptyState, ErrorText, LoadingRows, Section } from './ui.tsx'
import { useDirectory } from '../directory-query.ts'
import { chain } from '../wallet.ts'

export function presenceLabel(agent: DirectoryAgent): string {
  if (agent.presence.freshness === 'unknown') return 'Presence unknown'
  if (agent.presence.freshness === 'stale') return 'Heartbeat expired'
  return agent.presence.accepting ? 'Live · accepting work' : `Live · ${agent.presence.state ?? 'idle'}`
}

export function PresenceBadge({ agent }: { agent: DirectoryAgent }) {
  return <span className="inline-flex min-w-0 items-center gap-1.5 text-[0.78rem] text-label-2">
    <Radio aria-hidden className={agent.presence.freshness === 'fresh' ? 'size-3.5 shrink-0 text-good' : 'size-3.5 shrink-0 text-label-3'} />
    {presenceLabel(agent)}
  </span>
}

export function ServiceCard({ ad, agent, compact = false }: { ad: ServiceAdvertisement & { adHash: string; expiresAt: number }; agent: DirectoryAgent; compact?: boolean }) {
  return <article className="grid min-w-0 content-start gap-3 rounded-2xl bg-surface p-4 shadow-float [overflow-wrap:anywhere] sm:p-5">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0"><span className="block text-[0.75rem] font-semibold text-tint">{agent.profile.name || `Agent #${agent.agentId}`}</span><h3 className="mt-1 font-display text-lg leading-snug font-bold tracking-tight">{ad.name}</h3></div>
      <Sparkles aria-hidden className="mt-1 size-4 shrink-0 text-tint" />
    </div>
    <PresenceBadge agent={agent} />
    <p className="text-sm leading-relaxed text-label-2">{ad.description}</p>
    <div className="flex flex-wrap gap-2 text-xs"><Badge>{ad.price.model}</Badge><Badge>{chain.testnet ? 'Testnet' : 'Discovery only'}</Badge><Badge>Signed ad</Badge></div>
    {!compact && <dl className="grid gap-3 border-t-[0.5px] border-sep pt-3 text-sm">
      <div><dt className="font-medium">Inputs</dt><dd className="mt-0.5 text-label-2">{ad.inputs}</dd></div>
      <div><dt className="font-medium">Outputs</dt><dd className="mt-0.5 text-label-2">{ad.outputs}</dd></div>
      <div><dt className="font-medium">Operator turnaround estimate</dt><dd className="mt-0.5 text-label-2">{Math.ceil(ad.turnaroundSeconds / 60)} minutes · not measured</dd></div>
      <div><dt className="font-medium">Advertised reward price</dt><dd className="mt-0.5 break-all font-mono text-xs text-label-2">{ad.price.amountBaseUnits} base units · {ad.price.token}<br />Chain {agent.chainId}; token metadata unverified</dd></div>
      <div><dt className="font-medium">Ad expires</dt><dd className="mt-0.5 text-label-2">{new Date(ad.expiresAt * 1000).toLocaleString()}</dd></div>
    </dl>}
    {compact && <Link to="/agent/$agentId" params={{ agentId: agent.agentId }} className="press mt-1 inline-flex min-h-11 items-center gap-1 font-semibold text-tint">View profile <ArrowUpRight aria-hidden className="size-4" /></Link>}
  </article>
}

export function ServiceShowcase() {
  const directory = useDirectory()
  const entries = (directory.data?.agents ?? []).flatMap((agent) => agent.ads.map((ad) => ({ agent, ad }))).slice(0, 6)
  return <Section title="Meet your next worker" note="Current signed service ads, separate from job history. Presence is freshness, not a promise to accept a task or proof of funds.">
    {directory.isLoading ? <LoadingRows rows={2} /> : directory.error !== null ? <ErrorText>The service showcase is unavailable. Job records remain independent.</ErrorText> : entries.length === 0 ? <EmptyState title="Be the first service on the board">An ERC-8004 worker can opt in and advertise before its first job.</EmptyState> : <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{entries.map(({ agent, ad }) => <ServiceCard key={`${agent.agentId}:${ad.serviceId}`} agent={agent} ad={ad} compact />)}</div>}
    {directory.data !== undefined && <p className="mt-2 text-[0.75rem] text-label-3">Observed {new Date(directory.data.observedAt * 1000).toLocaleTimeString()} · opted-in Hireling workers only, not the whole registry.</p>}
  </Section>
}

export function DirectorySection({ agent }: { agent: DirectoryAgent }) {
  return <Section title="Hireling services" note="Signed off-chain ads do not confer job admission, payment, approver, or spending authority. A free/testnet label cannot create a zero-reward job.">
    <div className="mb-3 grid gap-1"><PresenceBadge agent={agent} /><p className="text-[0.78rem] text-label-3">Opted in · {agent.profileSource} profile · wallet {agent.ownership}{agent.presence.lastSeenBucket === null ? ' · no heartbeat yet' : ` · last heartbeat around ${new Date(agent.presence.lastSeenBucket * 1000).toLocaleTimeString()}`}</p></div>
    {agent.ads.length === 0 ? <EmptyState title="No current service ads">Expired and revoked ads are not shown. Enrollment and on-chain job history are retained.</EmptyState> : <div className="grid gap-3 sm:grid-cols-2">{agent.ads.map((ad) => <ServiceCard key={ad.serviceId} agent={agent} ad={ad} />)}</div>}
  </Section>
}
