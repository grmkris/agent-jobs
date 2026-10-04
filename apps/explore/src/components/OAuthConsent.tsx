import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { fleetRequest, operatorSession, type ManagedAgent } from '../fleet.ts'
import { useAgentWallets } from './Privy.tsx'
import { When, useNow } from './Time.tsx'
import { Badge, Button, EmptyState, ErrorText, LoadingRows, PageTitle } from './ui.tsx'
import { useAuth } from './Wallet.tsx'
import { OperatorSignIn } from '../routes/Workspace.tsx'

const SCOPE_LABELS: Record<string, string> = {
  'hireling:read': 'Read listings and the agents you select',
  'hireling:hire': 'Prepare hires and request your approval',
  'hireling:work': 'Apply and prepare work for the selected agents',
}

export function OAuthConsent({ requestId }: { requestId: string }) {
  const auth = useAuth(); const wallets = useAgentWallets(); const owner = wallets?.operatorAddress ?? auth.address
  const now = useNow(); const [agents, setAgents] = useState<string[]>([]); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null)
  const query = useQuery({ queryKey: ['oauth-request', requestId, owner], queryFn: () => fleetRequest<{ request: { id: string; clientName: string; scope: string; resource: string; expiresAt: number }; agents: ManagedAgent[] }>(`/oauth/requests/${encodeURIComponent(requestId)}`, { owner }), enabled: owner !== undefined && operatorSession(owner) !== null, retry: false })
  const decide = async (decision: 'approve' | 'reject') => { setBusy(true); setError(null); try { const result = await fleetRequest<{ redirectUrl: string }>(`/oauth/requests/${encodeURIComponent(requestId)}/approve`, { owner, method: 'POST', body: { agentIds: agents, decision } }); window.location.assign(result.redirectUrl) } catch (failure) { setError((failure as Error).message); setBusy(false) } }
  return <><header><p className="eyebrow">CONNECT YOUR CODING AGENT</p><PageTitle>Review connection</PageTitle></header>{owner === undefined || operatorSession(owner) === null ? <OperatorSignIn /> : query.isLoading ? <LoadingRows rows={4} /> : query.error !== null || query.data === undefined ? <EmptyState title="Connection request unavailable">The request may have expired or already been used. Reconnect from your coding agent.{query.error !== null && <ErrorText>{query.error.message}</ErrorText>}</EmptyState> : <section className="workspace-panel grid gap-5"><div className="flex items-start gap-3"><ShieldCheck className="mt-1 size-6 text-tint" /><div><h2 className="text-xl font-semibold">{query.data.request.clientName} wants to connect</h2><p className="mt-1 text-xs text-label-2">Expires <When at={query.data.request.expiresAt} show="relative" /></p></div></div><div><p className="eyebrow mb-3">REQUESTED ACCESS</p><ul className="grid gap-2 text-sm">{query.data.request.scope.split(' ').map((scope) => <li key={scope}>{SCOPE_LABELS[scope] ?? scope} <Badge>{scope}</Badge></li>)}</ul></div><p className="break-all text-xs text-label-2">Server: {query.data.request.resource}</p><div><p className="eyebrow mb-3">CHOOSE YOUR AGENTS</p>{query.data.agents.length === 0 ? <p className="text-sm leading-relaxed text-label-2">Create or import an agent first, then reconnect. <Link to="/workspace/new" className="font-semibold text-tint">Create an agent</Link></p> : <div className="grid gap-2">{query.data.agents.map((agent) => <label key={agent.id} className="flex min-h-14 cursor-pointer items-center gap-3 rounded-xl border border-sep p-3"><input type="checkbox" className="size-4 accent-tint" checked={agents.includes(agent.id)} onChange={(event) => setAgents((prior) => event.target.checked ? [...prior, agent.id] : prior.filter((id) => id !== agent.id))} /><span><strong className="block text-sm">{agent.name}</strong><span className="block font-mono text-xs text-label-2">{agent.walletAddress.slice(0, 8)}…{agent.walletAddress.slice(-6)}</span></span></label>)}</div>}</div><p className="rounded-xl bg-fill p-4 text-sm leading-relaxed text-label-2">This connection authorizes only the selected agents and scopes. It does not give the coding agent a wallet key. Funding, hiring, bonds, and activation still require your website approval.</p><div className="flex flex-wrap gap-3"><Button busy={busy} disabled={agents.length === 0 || query.data.request.expiresAt <= now} onClick={() => void decide('approve')}>Connect selected agents</Button><Button variant="danger" busy={busy} onClick={() => void decide('reject')}>Decline</Button></div>{error !== null && <ErrorText>{error}</ErrorText>}</section>}</>
}
