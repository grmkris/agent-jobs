import { useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { ArrowRight, ChevronRight, CircleCheck, Fingerprint, Plus, ShieldCheck, Terminal } from 'lucide-react'
import { useState } from 'react'
import { PrivyLogin, useAgentWallets } from '../components/Privy.tsx'
import { When, useNow } from '../components/Time.tsx'
import { Address, Badge, Button, CopyButton, EmptyState, ErrorText, LoadingRows, PageTitle } from '../components/ui.tsx'
import { Monogram, useAuth } from '../components/Wallet.tsx'
import { type ManagedAgent, fleetRequest, healthLabel, humanAction, operatorSession, useLiveOverview } from '../fleet.ts'
import { chain } from '../wallet.ts'

export function WorkspacePage() {
  const auth = useAuth()
  const wallets = useAgentWallets()
  const owner = wallets?.operatorAddress ?? auth.address
  const live = useLiveOverview(owner, owner !== undefined && operatorSession(owner) !== null)
  const now = useNow()
  const agents = live.data?.agents ?? []
  const selected = useParams({ strict: false }) as { agentKey?: string }
  const agent = selected.agentKey === undefined ? undefined : agents.find((entry) => entry.id === selected.agentKey)
  if (selected.agentKey !== undefined && owner !== undefined && operatorSession(owner) !== null && live.isLoading) return <LoadingRows rows={3} />
  if (selected.agentKey !== undefined && owner !== undefined && operatorSession(owner) !== null && live.isError && live.data === undefined)
    return <ErrorText>Agent workspace unavailable: {live.error.message}</ErrorText>
  if (selected.agentKey !== undefined && live.data !== undefined && agent === undefined)
    return (
      <EmptyState title="Agent not found">
        This agent may belong to a different operator.{' '}
        <Link to="/workspace" className="text-tint">
          Back to workspace
        </Link>
      </EmptyState>
    )
  if (selected.agentKey !== undefined && agent !== undefined) return <AgentControl agent={agent} />
  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="eyebrow">YOUR CONTROL ROOM</p>
          <PageTitle>Agent workspace</PageTitle>
          <p className="mt-2 text-sm text-label-2">The people, permissions, and live work behind your agents.</p>
        </div>
        <Link to="/workspace/new" className="action-link">
          <Plus aria-hidden className="size-4" />
          Create an agent
        </Link>
      </header>
      {owner === undefined || operatorSession(owner) === null ? (
        <OperatorSignIn />
      ) : (
        <>
          <div className="workspace-metrics">
            <Metric label="Your agents" value={live.data === undefined ? '—' : agents.length} />
            <Metric
              label="Fresh health checks"
              value={
                live.data === undefined
                  ? '—'
                  : agents.filter((entry) => entry.status !== 'stopped' && entry.lastHeartbeatAt !== undefined && now - entry.lastHeartbeatAt <= 90).length
              }
            />
            <Metric
              label="Waiting for you"
              value={live.data === undefined ? '—' : live.data.approvals.filter((entry) => entry.status === 'pending' && entry.expiresAt > now).length}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-label-2">
            <span className="flex items-center gap-2">
              <span className={live.isError ? 'live-dot quiet' : 'live-dot'} />
              {live.isError ? (
                'Latest observation unavailable'
              ) : live.data === undefined ? (
                'Connecting to workspace…'
              ) : (
                <>
                  Observed <When at={live.data.asOf} show="relative" />
                </>
              )}
            </span>
            <Button variant="plain" busy={live.isFetching} onClick={() => void live.refetch()}>
              Refresh
            </Button>
          </div>
          {live.isError && (
            <ErrorText>
              {live.error.message}
              {live.data !== undefined && ' Showing the last observation. Refresh before approving an operation.'}
            </ErrorText>
          )}
          {live.isLoading ? (
            <LoadingRows rows={3} />
          ) : live.data === undefined ? null : agents.length === 0 ? (
            <EmptyState title="Your first agent starts here">
              Create a named agent wallet, or import an agent you already operate.{' '}
              <Link to="/workspace/new" className="text-tint">
                Create or import an agent <ArrowRight aria-hidden className="inline size-4" />
              </Link>
            </EmptyState>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {agents.map((entry) => (
                <Link key={entry.id} to="/workspace/$agentKey" params={{ agentKey: entry.id }} className="agent-card">
                  <div className="flex items-start justify-between gap-3">
                    <Monogram seed={entry.walletAddress} label={entry.name.slice(0, 2).toUpperCase()} size="md" />
                    <Badge
                      tone={
                        entry.status === 'stopped'
                          ? 'neutral'
                          : entry.lastHeartbeatAt !== undefined && now - entry.lastHeartbeatAt <= 90
                            ? 'success'
                            : 'attention'
                      }
                    >
                      {healthLabel(entry, now)}
                    </Badge>
                  </div>
                  <h2 className="mt-5 text-xl font-semibold">{entry.name}</h2>
                  <p className="mt-1 text-xs text-label-2">
                    {entry.agentId === undefined ? 'On-chain identity not registered' : `ERC-8004 #${entry.agentId}`} ·{' '}
                    {entry.kind === 'privy' ? 'Managed wallet' : 'Existing wallet'}
                  </p>
                  <div className="mt-4 flex items-center justify-between border-t border-sep pt-4 text-xs text-label-2">
                    <span className="font-mono">
                      {entry.walletAddress.slice(0, 8)}…{entry.walletAddress.slice(-6)}
                    </span>
                    <ChevronRight aria-hidden className="size-4" />
                  </div>
                </Link>
              ))}
            </div>
          )}
          <div className="grid items-start gap-6 xl:grid-cols-2">
            <section className="workspace-panel">
              <div className="flex items-center justify-between">
                <h2 className="section-title">Needs your approval</h2>
                <Link to="/approvals" className="text-sm font-semibold text-tint">
                  View all
                </Link>
              </div>
              {live.data === undefined ? (
                <p className="mt-4 text-sm text-label-2">Approval status unavailable.</p>
              ) : live.data.approvals.filter((entry) => entry.status === 'pending' && entry.expiresAt > now).length === 0 ? (
                <p className="mt-5 text-sm text-label-2">Nothing is waiting for your approval.</p>
              ) : (
                <div className="mt-4 grid divide-y divide-sep">
                  {live.data.approvals
                    .filter((entry) => entry.status === 'pending' && entry.expiresAt > now)
                    .slice(0, 4)
                    .map((entry) => (
                      <Link
                        key={entry.id}
                        to="/approvals/$approvalId"
                        params={{ approvalId: entry.id }}
                        className="flex min-h-16 items-center justify-between gap-3 py-3"
                      >
                        <div>
                          <strong className="block text-sm">{humanAction(entry.action)}</strong>
                          <span className="text-xs text-label-2">
                            {agents.find((a) => a.id === entry.agentId)?.name ?? entry.agentId} · expires <When at={entry.expiresAt} show="relative" />
                          </span>
                        </div>
                        <ChevronRight aria-hidden className="size-4" />
                      </Link>
                    ))}
                </div>
              )}
            </section>
            <section className="workspace-panel">
              <h2 className="section-title">Recent activity</h2>
              {live.data === undefined ? (
                <p className="mt-4 text-sm text-label-2">Activity unavailable.</p>
              ) : live.data.activity.length === 0 ? (
                <p className="mt-5 text-sm text-label-2">Pair an agent to see its activity here.</p>
              ) : (
                <ol className="activity-list">
                  {live.data.activity.slice(0, 8).map((entry) => (
                    <li key={entry.id}>
                      <span className="activity-dot" />
                      <div>
                        <span className="block text-sm font-semibold">{humanAction(entry.kind)}</span>
                        <span className="mt-1 block break-words text-xs text-label-2">
                          {typeof entry.detail === 'string' ? entry.detail : JSON.stringify(entry.detail)}
                        </span>
                        <span className="mt-1 block text-xs text-label-3">
                          <When at={entry.createdAt} />
                        </span>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>
          <p className="text-xs text-label-2">
            Workspace observations refresh every five seconds while visible.{' '}
            {live.data?.index?.next_block === undefined
              ? 'Indexer checkpoint unavailable.'
              : `Indexer through block ${(live.data.index.next_block - 1).toLocaleString()}.`}{' '}
            {live.data?.chainHead === undefined ? 'Current chain head unavailable.' : `Observed chain head ${live.data.chainHead.toLocaleString()}.`} Health and
            activity do not prove a payment; chain receipts do.
          </p>
        </>
      )}
    </>
  )
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <span className="metric-value">{value}</span>
      <span className="mt-2 block text-xs text-label-2">{label}</span>
    </div>
  )
}

export function OperatorSignIn() {
  const auth = useAuth()
  const wallets = useAgentWallets()
  const [error, setError] = useState<string | null>(null)
  return (
    <EmptyState title="Sign in to your agent workspace">
      Your operator account manages agents and approvals. Each agent keeps its own wallet.
      {auth.address === undefined && wallets?.operatorAddress === undefined ? (
        <PrivyLogin />
      ) : (
        <Button
          busy={wallets?.busy}
          onClick={() =>
            void (async () => {
              try {
                setError(null)
                if (wallets?.operatorAddress !== undefined && auth.address?.toLowerCase() !== wallets.operatorAddress.toLowerCase())
                  await wallets.select(wallets.operatorAddress)
                else await auth.signIn()
              } catch (failure) {
                setError((failure as Error).message)
              }
            })()
          }
        >
          Use operator wallet
        </Button>
      )}
      {error !== null && <ErrorText>{error}</ErrorText>}
      <Link to="/me" className="text-tint">
        Sign in or manage your account
      </Link>
    </EmptyState>
  )
}

function AgentControl({ agent }: { agent: ManagedAgent }) {
  const wallets = useAgentWallets()
  const auth = useAuth()
  const owner = wallets?.operatorAddress ?? auth.address
  const cache = useQueryClient()
  const now = useNow()
  const [pair, setPair] = useState<{ code: string; expiresAt: number; pairUrl: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const run = async (operation: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await operation()
      await cache.invalidateQueries({ queryKey: ['fleet-live', owner] })
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Link to="/workspace" className="inline-flex min-h-11 items-center text-sm font-semibold text-tint">
        ← All your agents
      </Link>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <Monogram seed={agent.walletAddress} label={agent.name.slice(0, 2).toUpperCase()} size="lg" />
          <div>
            <PageTitle>{agent.name}</PageTitle>
            <p className="mt-2 text-sm text-label-2">
              {agent.agentId === undefined ? 'Identity registration needed' : `ERC-8004 agent #${agent.agentId}`} · {chain.name}
            </p>
          </div>
        </div>
        <Badge tone={agent.lastHeartbeatAt !== undefined && now - agent.lastHeartbeatAt <= 90 ? 'success' : 'attention'}>{healthLabel(agent, now)}</Badge>
      </header>
      <div className="grid gap-5 xl:grid-cols-2">
        <section className="workspace-panel grid gap-4">
          <div className="flex items-center gap-2">
            <Fingerprint aria-hidden className="size-5 text-tint" />
            <h2 className="section-title">Agent wallet</h2>
          </div>
          <Address value={agent.walletAddress} />
          <p className="text-sm leading-relaxed text-label-2">
            This stable wallet holds this agent’s identity, funds, and stake. Your operator account manages it separately.
          </p>
          <Button
            variant="tinted"
            busy={wallets?.busy}
            disabled={wallets === null}
            onClick={() =>
              void run(async () => {
                await wallets?.select(agent.walletAddress)
              })
            }
          >
            Use this agent wallet
          </Button>
          <p className="text-xs text-label-2">
            Selected signer: {wallets?.selectedAddress?.toLowerCase() === agent.walletAddress.toLowerCase() ? agent.name : 'Another wallet'}
          </p>
          {agent.agentId === undefined ? (
            <Link to="/workspace/new" search={{ resume: agent.id } as never} className="text-sm font-semibold text-tint">
              Continue identity registration →
            </Link>
          ) : (
            <Link to="/agent/$agentId" params={{ agentId: agent.agentId }} className="text-sm font-semibold text-tint">
              Open public identity and record →
            </Link>
          )}
        </section>
        <section className="workspace-panel grid gap-4">
          <div className="flex items-center gap-2">
            <ShieldCheck aria-hidden className="size-5 text-tint" />
            <h2 className="section-title">Authority & health</h2>
          </div>
          <p className="text-sm text-label-2">
            Funding, selection, activation, and bonds always require your website approval. Unattended submission stays disabled until its job-specific provider
            policy is verified.
          </p>
          <Badge>Automatic signing disabled</Badge>
          <dl className="review-grid">
            <dt>Heartbeat</dt>
            <dd>
              <When at={agent.lastHeartbeatAt} />
            </dd>
            <dt>Companion</dt>
            <dd>{agent.companionVersion ?? 'Not observed'}</dd>
            <dt>Pair generation</dt>
            <dd>{agent.generation}</dd>
            <dt>Device fingerprint</dt>
            <dd className="break-all font-mono text-xs">{agent.deviceFingerprint ?? 'Not paired'}</dd>
          </dl>
          <Button
            variant="danger"
            busy={busy}
            onClick={() => {
              if (
                window.confirm(
                  `Stop ${agent.name}, revoke its connector credentials${agent.kind === 'privy' ? ', and remove all Privy session signers from this agent wallet' : ''}? Existing on-chain delegations must be revoked separately.`,
                )
              )
                void run(async () => {
                  await fleetRequest(`/api/agents/${encodeURIComponent(agent.id)}/revoke`, {
                    method: 'POST',
                    body: {},
                    owner,
                  })
                  setPair(null)
                  if (agent.kind === 'privy') {
                    if (wallets === null) throw new Error('Hosted access stopped. Sign in to Privy to remove this wallet’s session signers.')
                    await wallets.removeSigners(agent.walletAddress)
                  }
                  setNotice(
                    `Hosted access revoked${agent.kind === 'privy' ? ' and Privy session signers removed' : ''}. Review any on-chain delegations separately.`,
                  )
                })
            }}
          >
            Stop & revoke agent access
          </Button>
          <p className="text-xs leading-relaxed text-label-2">
            This revokes connector access and, for managed wallets, all Privy session signers. Existing on-chain delegations remain active until their own
            expiry or confirmed revocation.
          </p>
          {notice !== null && (
            <p role="status" className="text-sm text-ok">
              {notice}
            </p>
          )}
        </section>
      </div>
      <section className="workspace-panel grid gap-4">
        <div className="flex items-center gap-2">
          <Terminal aria-hidden className="size-5 text-tint" />
          <h2 className="section-title">Pair Claude Code</h2>
        </div>
        <p className="text-sm leading-relaxed text-label-2">
          Run the Hireling skill in your existing coding agent. It installs the versioned local companion, generates a device credential outside the model
          context, and asks you to verify its public fingerprint. Pairing alone grants no spending authority.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button
            busy={busy}
            onClick={() =>
              void run(async () => {
                setPair(
                  await fleetRequest(`/api/agents/${encodeURIComponent(agent.id)}/pair`, {
                    method: 'POST',
                    body: {},
                    owner,
                  }),
                )
              })
            }
          >
            Generate pairing code
          </Button>
          <Link to="/connect" className="action-link secondary">
            Setup instructions <ArrowRight aria-hidden className="size-4" />
          </Link>
        </div>
        {pair !== null && (
          <div className="grid gap-3 rounded-xl bg-fill p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-lg tracking-widest [overflow-wrap:anywhere]">{pair.code}</span>
              <CopyButton value={pair.code} label="Copy pairing code" />
            </div>
            <p className="text-xs text-label-2">
              {pair.expiresAt > now ? (
                <>
                  Expires <When at={pair.expiresAt} show="relative" />. Keep this code private; it is shown only for this pairing attempt.
                </>
              ) : (
                'This code expired. Generate a new code.'
              )}
            </p>
            <pre className="code-block">{`Pair my Hireling agent “${agent.name}” using this one-time code: ${pair.code}.\nUse ${window.location.origin}/skills/connector/SKILL.md.\nShow me the device fingerprint, then start the worker and verify its health checkpoint.`}</pre>
            <CopyButton
              value={`Pair my Hireling agent using ${pair.code}. Read ${window.location.origin}/skills/connector/SKILL.md and show the device fingerprint before starting.`}
              label="Copy pairing prompt"
            />
          </div>
        )}
        {agent.deviceFingerprint !== undefined && (
          <p className="text-sm leading-relaxed text-label-2">
            Compare the device fingerprint above with the one printed by the local companion before starting work.
          </p>
        )}
        <div className="flex items-center gap-2 text-sm text-label-2">
          <CircleCheck aria-hidden className="size-4" />
          {agent.lastHeartbeatAt === undefined ? (
            'Awaiting a signed startup health checkpoint.'
          ) : (
            <>
              Last signed health checkpoint <When at={agent.lastHeartbeatAt} />.
            </>
          )}
        </div>
      </section>
      {error !== null && <ErrorText>{error}</ErrorText>}
    </>
  )
}
