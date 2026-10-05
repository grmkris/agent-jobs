import { useQueries, useQuery } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { ChevronRight, CircleCheck, CircleX, Flame, RotateCcw, TriangleAlert } from 'lucide-react'
import { type ReactNode, useMemo } from 'react'
import { BaseError, ContractFunctionRevertedError, maxUint256, zeroAddress } from 'viem'
import { useReadContracts } from 'wagmi'
import { type BoardInfo, type ChainJob, type TaskIndexEntry, boardApi, currentBoardId, data, fetchDirectoryAgent } from '../api.ts'
import { BoardLink, boardRoutes } from '../components/BoardLink.tsx'
import { DirectorySection } from '../components/DirectoryCards.tsx'
import { AgentBacking } from '../components/AgentBacking.tsx'
import { AgentStartLink } from '../components/AgentStartLink.tsx'
import { OwnerTabs } from '../components/agent/OwnerTabs.tsx'
import { HireAgainLink, lastPaidJob } from '../components/job/HireAgain.tsx'
import { PhaseBadge, phaseOf } from '../components/Phase.tsx'
import { useNow } from '../components/Time.tsx'
import { Address, Amount, EmptyState, ErrorText, Group, ListRow, LoadingRows, PageTitle, Section, Skeleton, cn, rowClass } from '../components/ui.tsx'
import { Monogram, useAuth } from '../components/Wallet.tsx'
import { amount } from '../format.ts'
import { useOwnedAgent } from '../managed.ts'
import { useTokenList } from '../useTokens.ts'
import { chain, deployment } from '../wallet.ts'
import type { AgentSummary } from './Agents.tsx'

/** The ERC-8004 identity registry's reads the operator console needs (the SDK's ABI has no `tokenURI`). */
export const identityAbi = [
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'agentId', type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'getAgentWallet', stateMutability: 'view', inputs: [{ name: 'agentId', type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'tokenURI', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'string' }] },
] as const

/** An agent number as the registry numbers them: digits only, without leading zeros; null for anything else. */
export function agentNumber(raw: unknown): string | null {
  const s = String(raw ?? '').trim()
  if (!/^\d{1,78}$/.test(s) || BigInt(s) > maxUint256) return null
  return BigInt(s).toString()
}

// ---------------------------------------------------------------------------------------------------------------
// The agent's registration: a data: JSON profile gives a name, description and (inline) picture; a URL gives none.
// ---------------------------------------------------------------------------------------------------------------

export type AgentProfile =
  | { kind: 'json'; name: string | null; description: string | null; image: string | null; raw: string }
  | { kind: 'link'; url: string; href: string | null }

const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null)

/**
 * Reads what an agent registered (`tokenURI`). A `data:application/json[;base64],…` profile yields its name and
 * description, and its image only when that is itself a data: URL (the page's CSP loads no remote images). Anything
 * else is a link: shown, and linked only when it is https.
 */
export function parseProfile(uri: string | null | undefined): AgentProfile | null {
  if (uri === null || uri === undefined || uri.trim() === '') return null
  const u = uri.trim()
  if (/^data:application\/json/i.test(u)) {
    const comma = u.indexOf(',')
    const meta = u.slice(0, comma)
    const payload = u.slice(comma + 1)
    let json = payload
    try {
      if (/;base64$/i.test(meta)) json = new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)))
      else {
        try {
          json = decodeURIComponent(payload)
        } catch {
          json = payload
        }
      }
      const doc = JSON.parse(json) as Record<string, unknown>
      const image = text(doc.image, 200_000)
      return {
        kind: 'json',
        name: text(doc.name, 80),
        description: text(doc.description, 600),
        image: image !== null && /^data:image\/(png|jpeg|gif|webp|svg\+xml);/i.test(image) ? image : null,
        raw: u,
      }
    } catch {
      return { kind: 'link', url: u.slice(0, 120), href: null }
    }
  }
  return { kind: 'link', url: u, href: /^https:\/\//i.test(u) ? u : null }
}

/** A revert (the registry says no), as opposed to an RPC that did not answer. */
export const isRevert = (e: unknown) => e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError) !== null

export interface AgentIdentity {
  loading: boolean
  /** true registered, false not, null unknown (the RPC did not answer). */
  exists: boolean | null
  owner: `0x${string}` | undefined
  wallet: `0x${string}` | undefined
  uri: string | undefined
  profile: AgentProfile | null
}

/** The agent's on-chain identity (ERC-8004): owner, agent wallet and registration, re-read every 10 s when `live`. */
export function useAgentIdentity(id: string | null, live = false): AgentIdentity {
  const n = id === null ? 0n : BigInt(id)
  const reads = useReadContracts({
    contracts: [
      { address: deployment.identity, abi: identityAbi, functionName: 'ownerOf', args: [n], chainId: chain.id },
      { address: deployment.identity, abi: identityAbi, functionName: 'getAgentWallet', args: [n], chainId: chain.id },
      { address: deployment.identity, abi: identityAbi, functionName: 'tokenURI', args: [n], chainId: chain.id },
    ],
    query: { enabled: id !== null, refetchInterval: live ? 10_000 : false },
  })
  const [owner, wallet, uri] = reads.data ?? []
  const exists = owner === undefined ? null : owner.status === 'success' ? true : isRevert(owner.error) ? false : null
  const w = wallet?.status === 'success' ? wallet.result : undefined
  const u = uri?.status === 'success' ? uri.result : undefined
  return {
    loading: reads.isLoading,
    exists: reads.error !== null && reads.data === undefined ? null : exists,
    owner: owner?.status === 'success' ? owner.result : undefined,
    wallet: w === zeroAddress ? undefined : w,
    uri: u,
    profile: parseProfile(u),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The agent's record: every job it took, the evaluator's ratings and what happened to its bonds (chain facts).
// ---------------------------------------------------------------------------------------------------------------

export interface AgentRecord {
  agent: AgentSummary
  wallets: string[]
  bonds: { returned?: number; burned?: number }
  jobs: ChainJob[]
  feedback: Array<{ job_id: string; value: string; tag: string; recorded: number; tx_hash: string | null }>
}

/**
 * `/data/agents/<id>`: the agent's record, or null when it has taken no job yet. Fetched directly rather than through
 * `data()`, which folds "not found" and "unavailable" into one error; here they read differently.
 */
export async function fetchAgentRecord(id: string): Promise<AgentRecord | null> {
  const res = await fetch(`/data/agents/${encodeURIComponent(id)}`)
  const body = (await res.json()) as (AgentRecord & { ok: true }) | { ok: false; code?: string; message?: string }
  if (body.ok) return body
  if (body.code === 'not-found') return null
  throw new Error(body.message ?? 'unavailable')
}

export const useAgentRecord = (id: string | null, refetchInterval = 30_000) =>
  useQuery({ queryKey: ['data-agent', id], queryFn: () => fetchAgentRecord(id as string), enabled: id !== null, refetchInterval })

/** "once", "twice", "3 times". */
export const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`)

const RATING: Record<string, { words: string; good: boolean }> = {
  completed: { words: 'completed', good: true },
  rejected: { words: 'rejected', good: false },
  'rejected-quality': { words: 'rejected: not good enough', good: false },
  'rejected-falsified': { words: 'rejected: falsified evidence', good: false },
  'not-delivered': { words: 'not delivered', good: false },
}

/** The evaluator's ratings in plain words, completed first: "11 completed", "2 rejected: not good enough". */
export function ratings(feedback: Record<string, number>): Array<{ tag: string; count: number; words: string; good: boolean }> {
  return Object.entries(feedback)
    .filter(([, n]) => n > 0)
    .map(([tag, count]) => ({ tag, count, words: RATING[tag]?.words ?? tag.replaceAll('-', ' '), good: RATING[tag]?.good ?? false }))
    .toSorted((a, b) => Number(b.good) - Number(a.good) || b.count - a.count)
}

/** The agent's picture when its profile carries one inline, else its monogram (the same one the directory shows). */
export function AgentAvatar({ id, image, size = 'md' }: { id: string; image?: string | null | undefined; size?: 'md' | 'lg' }) {
  if (image !== null && image !== undefined) {
    return <img src={image} alt="" className={cn('shrink-0 rounded-full bg-fill object-cover', size === 'lg' ? 'size-16' : 'size-9')} />
  }
  return <Monogram seed={`agent-${id}`} label={id.slice(-2)} size={size} />
}

function Tile({ value, label, className }: { value: ReactNode; label: ReactNode; className?: string | undefined }) {
  return (
    <div className="grid content-start gap-0.5 rounded-xl bg-surface px-3.5 py-3">
      <b className={cn('tabular font-display text-[1.35rem] leading-[1.15] font-bold tracking-[-0.02em]', className)}>{value}</b>
      <span className="text-[0.78rem] text-label-2">{label}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------------------------

/** A worker's public profile: its ERC-8004 identity, its record across every board, and every job it took. */
export function AgentPage() {
  const { agentId } = useParams({ strict: false }) as { agentId: string }
  const id = agentNumber(agentId)
  if (id === null) {
    return (
      <>
        <PageTitle>Agent</PageTitle>
        <EmptyState title="That is not an agent number">Agents are numbered by the ERC-8004 identity registry, like 1942.</EmptyState>
      </>
    )
  }
  return <Profile id={id} />
}

function Profile({ id }: { id: string }) {
  const identity = useAgentIdentity(id)
  const record = useAgentRecord(id)
  const directory = useQuery({ queryKey: ['directory-agent', id], queryFn: () => fetchDirectoryAgent(id), refetchInterval: 20_000 })
  const profile = identity.profile?.kind === 'json' ? identity.profile : null
  const wallet = identity.wallet ?? record.data?.wallets[0]
  const board = currentBoardId()
  const { address } = useAuth()
  const again = lastPaidJob(record.data?.jobs ?? [], address, id)
  // The signed-in operator's own agent gets its owner tabs; everyone else, the public profile alone.
  const managed = useOwnedAgent(id)
  const header = (
    <>
      <header className="flex items-center gap-4">
        <AgentAvatar id={id} image={profile?.image} size="lg" />
        <div className="grid min-w-0 gap-1">
          <h1 className="font-display text-[2rem] leading-[1.12] font-bold tracking-[-0.022em] [overflow-wrap:anywhere]">{profile?.name ?? `Agent #${id}`}</h1>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.9rem] text-label-2">
            {profile?.name !== null && profile?.name !== undefined && <span>Agent #{id} ·</span>}
            {identity.exists === true && (
              <span>
                On-chain agent <span className="text-label-3">(ERC-8004)</span>
              </span>
            )}
            {identity.exists === null && <span>Identity check unavailable</span>}
            {wallet !== undefined && <Address value={wallet} />}
          </div>
        </div>
      </header>
      {profile?.description !== null && profile?.description !== undefined && <p className="-mt-2 leading-relaxed text-label-2">{profile.description}</p>}
    </>
  )
  const overview = (
    <>
      {again !== undefined && (
        <div className="grid gap-1.5">
          <HireAgainLink jobId={again.job_id} />
          <p className="px-4 text-[0.85rem] text-label-2">You paid this agent for job #{again.job_id}. Hire again prefills a direct hire with that job's token, reward and terms.</p>
        </div>
      )}

      {managed === undefined && <AgentStartLink />}
      {directory.data?.agent !== undefined && <DirectorySection agent={directory.data.agent} />}
      {wallet !== undefined && <AgentBacking wallet={wallet as `0x${string}`} viewer={address} />}
      {record.isLoading ? (
        <>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="grid gap-2 rounded-xl bg-surface px-3.5 py-3">
                <Skeleton className="h-6 w-2/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            ))}
          </div>
          <LoadingRows rows={4} />
        </>
      ) : record.error !== null ? (
        <ErrorText>This agent&apos;s record is unavailable right now. Its identity below is read from the chain.</ErrorText>
      ) : record.data === null || record.data === undefined ? (
        identity.exists === false ? (
          <EmptyState title={`No agent #${id}`}>
            Nothing is registered under this number on the ERC-8004 identity registry.{' '}
            <Link to="/connect" className="text-tint">
              Register an agent
            </Link>
          </EmptyState>
        ) : (
          <EmptyState title="This agent has not taken a job here yet">Its record starts with its first job: jobs paid, ratings and earnings show up here.</EmptyState>
        )
        ) : (
          <Record record={record.data} />
      )}

      {identity.exists !== false && <Registration id={id} identity={identity} />}

      {record.data !== null && record.data !== undefined && <Jobs record={record.data} />}

      {managed === undefined && identity.exists !== false && (
        <Link
          to="/connect"
          search={{ agent: id, ...(board === 'public' ? {} : { board }) } as never}
          className="press inline-flex min-h-[3.125rem] items-center justify-center gap-2 rounded-2xl bg-tint/14 px-5 font-semibold text-tint"
        >
          Run this agent: setup checklist
        </Link>
      )}
    </>
  )
  return (
    <>
      {header}
      {managed === undefined ? overview : <OwnerTabs id={id} managed={managed} overview={overview} />}
    </>
  )
}


function Record({ record }: { record: AgentRecord }) {
  const now = useNow()
  const minute = Math.floor(now / 60) * 60
  const a = record.agent
  useTokenList(Object.keys(a.earned))
  // Open and past the delivery deadline: nothing was submitted, so anyone can close it (refund, and any bond burns).
  const overdue = useMemo(() => record.jobs.filter((j) => j.status === 'active' && j.delivery_deadline !== null && j.delivery_deadline < minute), [record.jobs, minute])
  const bondAtStake = overdue.some((j) => j.worker_bond !== null && j.worker_bond !== '0')
  const earned = Object.entries(a.earned).map(([token, v]) => amount(v, token))
  const rated = ratings(a.feedback)
  const bonds = record.bonds
  return (
    <>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Tile value={`${a.completed} of ${a.jobs}`} label="jobs paid" />
        <Tile value={a.lost} label="refunded or rejected" />
        <Tile value={a.inProgress} label="open now" className={overdue.length > 0 ? 'text-warn' : undefined} />
        <Tile
          value={
            earned.length === 0 ? (
              '—'
            ) : (
              <span className="grid text-[1.05rem] leading-snug">
                {earned.map((e) => (
                  <span key={e}>{e}</span>
                ))}
              </span>
            )
          }
          label="earned"
        />
      </div>

      {overdue.length > 0 && (
        <div role="status" className="flex items-start gap-3 rounded-2xl bg-warn-bg px-4 py-3.5 leading-snug">
          <TriangleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-warn" />
          <p className="text-[0.92rem]">
            <span className="font-semibold">Needs attention:</span> {overdue.length === 1 ? 'one of its open jobs is' : `${overdue.length} of its open jobs are`} past the delivery
            deadline with nothing delivered. Anyone can close {overdue.length === 1 ? 'it' : 'them'}; the creator gets the reward back
            {bondAtStake ? ' and the posted bond burns' : ''}.
          </p>
        </div>
      )}

      <Section title="Ratings" note="Each job's evaluator writes a rating to the ERC-8004 reputation registry when the job settles; bonds are counted as the chain settled them.">
        <Group>
          {rated.length === 0 && (bonds.returned ?? 0) === 0 && (bonds.burned ?? 0) === 0 && (
            <ListRow>
              <span className="text-label-2">No ratings yet: they are written when a job settles.</span>
            </ListRow>
          )}
          {rated.map((r) => (
            <ListRow key={r.tag}>
              {r.good ? <CircleCheck aria-hidden className="size-5 shrink-0 text-ok" /> : <CircleX aria-hidden className="size-5 shrink-0 text-bad" />}
              <span className="flex-1">
                <span className="tabular font-semibold">{r.count}</span> {r.words}
              </span>
            </ListRow>
          ))}
          {(bonds.returned ?? 0) > 0 && (
            <ListRow>
              <RotateCcw aria-hidden className="size-5 shrink-0 text-label-3" />
              <span className="flex-1">Bond returned {times(bonds.returned ?? 0)}</span>
            </ListRow>
          )}
          {(bonds.burned ?? 0) > 0 && (
            <ListRow>
              <Flame aria-hidden className="size-5 shrink-0 text-bad" />
              <span className="flex-1">Bond burned {times(bonds.burned ?? 0)}</span>
            </ListRow>
          )}
        </Group>
      </Section>
    </>
  )
}

function Registration({ id, identity }: { id: string; identity: AgentIdentity }) {
  const p = identity.profile
  return (
    <Section
      title="Registration"
      note={
        p?.kind === 'link' ? (
          <>
            This agent registered a web link, not a profile, so Hireling can&apos;t show a name, picture or description.{' '}
            <Link to="/connect" search={{ agent: id } as never} className="text-tint">
              Register a JSON profile
            </Link>{' '}
            to get one.
          </>
        ) : p?.kind === 'json' ? (
          'The name and description come from the profile the agent registered on-chain.'
        ) : undefined
      }
    >
      <Group>
        {identity.loading ? (
          <ListRow>
            <span className="grid flex-1 gap-2 py-1">
              <Skeleton className="h-4 w-2/5" />
              <Skeleton className="h-3 w-3/5" />
            </span>
          </ListRow>
        ) : identity.exists === null ? (
          <ListRow>
            <span className="text-label-2">The identity registry did not answer. Retry in a moment.</span>
          </ListRow>
        ) : (
          <>
            <ListRow>
              <span className="flex-1">Owner</span>
              <Address value={identity.owner} />
            </ListRow>
            <ListRow>
              <span className="flex-1">
                Agent wallet
                <span className="block text-[0.78rem] text-label-3">Signs its applications and transactions</span>
              </span>
              <Address value={identity.wallet} />
            </ListRow>
            <ListRow>
              <span className="shrink-0">{p?.kind === 'json' ? 'Profile' : 'Profile link'}</span>
              <span className="min-w-0 flex-1 truncate text-right text-[0.88rem] text-label-2">
                {p === null ? (
                  'None'
                ) : p.kind === 'json' ? (
                  'JSON profile, on-chain'
                ) : p.href !== null ? (
                  <a href={p.href} target="_blank" rel="noreferrer noopener" className="text-tint">
                    {p.url.replace(/^https:\/\//, '')}
                  </a>
                ) : (
                  p.url
                )}
              </span>
            </ListRow>
          </>
        )}
      </Group>
    </Section>
  )
}

/** Every job the agent took, on every board, newest first, linked on the board it was posted on. */
function Jobs({ record }: { record: AgentRecord }) {
  const { address } = useAuth()
  const now = useNow()
  const minute = Math.floor(now / 60) * 60
  // Which board each job was posted on, and the boards' names and titles (the same queries the job list uses).
  const all = useQuery({ queryKey: ['chain-jobs', 'public'], queryFn: () => boardApi('public').jobs<{ jobs: ChainJob[] }>(), refetchInterval: 60_000 })
  const boards = useQuery({ queryKey: ['data-boards'], queryFn: () => data<{ boards: BoardInfo[] }>('boards'), staleTime: 300_000 })
  const boardOf = useMemo(() => new Map((all.data?.jobs ?? []).map((j) => [j.job_id, j.board_id ?? 'public'])), [all.data])
  const boardIds = useMemo(() => [...new Set(['public', ...record.jobs.map((j) => boardOf.get(j.job_id) ?? 'public')])], [record.jobs, boardOf])
  const indexes = useQueries({
    queries: boardIds.map((b) => ({ queryKey: ['task_index', b], queryFn: () => boardApi(b).tool<TaskIndexEntry[]>('task_index'), staleTime: 60_000 })),
  })
  const tasks = new Map<string, TaskIndexEntry>()
  for (const q of indexes) for (const t of q.data ?? []) if (t.jobId !== null) tasks.set(t.jobId, t)
  const names = new Map((boards.data?.boards ?? []).map((b) => [b.id, b.name]))
  const jobs = record.jobs.toSorted((a, b) => Number(b.job_id) - Number(a.job_id))
  return (
    <Section title={`Jobs · ${jobs.length}`} note="Every job this agent took, on every board, from chain records.">
      <Group>
        {jobs.map((j) => {
          const b = boardOf.get(j.job_id) ?? 'public'
          const task = tasks.get(j.job_id)
          const phase = phaseOf(j, task, address, minute)
          return (
            <BoardLink key={j.job_id} target={boardRoutes(b).job(j.job_id)} className={rowClass({ interactive: true })}>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{task?.title ?? `Job #${j.job_id}`}</span>
                <span className="block truncate text-[0.84rem] text-label-2">
                  #{j.job_id} · {b === 'public' ? 'Public board' : (names.get(b) ?? b)} · {j.mode === 'contest' ? 'Contest' : 'Hire'}
                </span>
              </span>
              <span className="grid shrink-0 justify-items-end gap-1">
                <Amount value={j.reward} token={j.token} />
                <PhaseBadge phase={phase} />
              </span>
              <ChevronRight aria-hidden className="size-4 shrink-0 text-label-3" />
            </BoardLink>
          )
        })}
      </Group>
    </Section>
  )
}
