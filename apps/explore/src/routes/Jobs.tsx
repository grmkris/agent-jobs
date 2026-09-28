import { useAuth } from '../components/Wallet.tsx'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { type ChainJob, type TaskIndexEntry, data, tool } from '../api.ts'
import { Address, Badge, Card, statusTone } from '../components/ui.tsx'
import { amount, bond, when } from '../format.ts'

export interface JobListItem {
  jobId: string | null
  task: TaskIndexEntry | undefined
  chain: ChainJob | undefined
}

export function useJobs() {
  const tasks = useQuery({ queryKey: ['task_index'], queryFn: () => tool<TaskIndexEntry[]>('task_index'), refetchInterval: 20_000 })
  const chain = useQuery({ queryKey: ['chain-jobs'], queryFn: () => data<{ jobs: ChainJob[]; index: { next_block: number; updated_at: number } | null }>('jobs'), refetchInterval: 20_000 })
  const items = useMemo(() => {
    const byJob = new Map<string, JobListItem>()
    for (const c of chain.data?.jobs ?? []) byJob.set(c.job_id, { jobId: c.job_id, chain: c, task: undefined })
    const out: JobListItem[] = []
    for (const t of tasks.data ?? []) {
      if (t.jobId !== null && byJob.has(t.jobId)) (byJob.get(t.jobId) as JobListItem).task = t
      // Awaiting publish, or published but not indexed yet (the indexer reads finalized blocks once a minute).
      else out.push({ jobId: t.jobId, task: t, chain: undefined })
    }
    return [...byJob.values(), ...out].toSorted((a, b) => Number(b.jobId ?? 1e9) - Number(a.jobId ?? 1e9))
  }, [tasks.data, chain.data])
  return { items, index: chain.data?.index ?? null, loading: tasks.isLoading || chain.isLoading, error: tasks.error ?? chain.error }
}

function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="rounded border border-neutral-300 bg-white px-2 py-1 text-sm">
      {options.map((o) => <option key={o}>{o}</option>)}
    </select>
  )
}

const VERDICT_TONE = { clean: 'green', caution: 'amber', reject: 'red' } as const

export function Jev({ verdict }: { verdict: string | undefined }) {
  if (verdict === undefined) return <span className="text-neutral-400">—</span>
  return <Badge tone={VERDICT_TONE[verdict as keyof typeof VERDICT_TONE] ?? 'gray'}>Jev: {verdict}</Badge>
}

export function JobsPage() {
  const { items, index, loading, error } = useJobs()
  const { address } = useAuth()
  const [stack, setStack] = useState('all')
  const [mode, setMode] = useState('all')
  const [bondOnly, setBondOnly] = useState(false)
  const [verdict, setVerdict] = useState('all')
  const shown = items.filter((i) => {
    // An offer never published is a draft: nothing is escrowed, so only its creator sees it here.
    if (i.jobId === null && (address === undefined || i.task?.creator.toLowerCase() !== address.toLowerCase())) return false
    const s = i.chain?.stack ?? i.task?.stack
    const m = i.chain?.mode ?? i.task?.mode
    const wb = i.chain?.worker_bond ?? i.task?.workerBond ?? '0'
    const cb = i.chain?.creator_bond ?? i.task?.creatorBond ?? '0'
    return (stack === 'all' || s === stack) && (mode === 'all' || m === mode) && (!bondOnly || wb !== '0' || cb !== '0') &&
      (verdict === 'all' || i.task?.screening.verdict === verdict)
  })
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-neutral-500">Board</span><Select value={stack} onChange={setStack} options={['all', 'main', 'demo']} />
        <span className="text-neutral-500">Mode</span><Select value={mode} onChange={setMode} options={['all', 'hire', 'contest']} />
        <span className="text-neutral-500">Jev</span><Select value={verdict} onChange={setVerdict} options={['all', 'clean', 'caution', 'reject', 'unscreened']} />
        <label className="flex items-center gap-1"><input type="checkbox" checked={bondOnly} onChange={(e) => setBondOnly(e.target.checked)} /> bond present</label>
        <span className="ml-auto text-xs text-neutral-400">{index === null ? 'index not built yet' : `indexed to block ${index.next_block - 1}`}</span>
      </div>
      {error !== null && <p className="text-sm text-red-600">{(error as Error).message}</p>}
      {loading && <p className="text-sm text-neutral-500">Loading…</p>}
      <div className="grid gap-3">
        {shown.map((i) => {
          const status = i.chain?.status ?? 'awaiting publish'
          const m = i.chain?.mode ?? i.task?.mode
          return (
            <Card key={i.jobId ?? i.task?.taskId}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  {i.jobId === null ? (
                    <span className="font-medium">{i.task?.title}</span>
                  ) : (
                    <Link to="/job/$jobId" params={{ jobId: i.jobId }} className="font-medium hover:underline">
                      #{i.jobId} {i.task?.title ?? <span className="text-neutral-400">(no board record)</span>}
                    </Link>
                  )}
                  <div className="mt-1 flex flex-wrap gap-2">
                    <Badge tone={statusTone(status)}>{status}</Badge>
                    {m !== undefined && m !== null && <Badge>{m}</Badge>}
                    <Badge>{i.chain?.stack ?? i.task?.stack}</Badge>
                    {i.task?.quoted === true && <Badge tone="blue">quoted</Badge>}
                    <Jev verdict={i.task?.screening.verdict} />
                  </div>
                </div>
                <div className="text-right text-sm">
                  <div className="font-medium">{amount(i.chain?.reward ?? i.task?.reward, i.chain?.token ?? i.task?.token)}</div>
                  <div className="text-xs text-neutral-500">bonds {bond(i.chain?.creator_bond ?? i.task?.creatorBond)} / {bond(i.chain?.worker_bond ?? i.task?.workerBond)}</div>
                  <div className="text-xs text-neutral-500">approver <Address value={i.chain?.approver ?? i.task?.approver} /></div>
                  <div className="text-xs text-neutral-500">due {when(i.chain?.delivery_deadline ?? i.task?.deliveryDeadline)}</div>
                </div>
              </div>
              {m === 'contest' && status === 'open' && (
                <p className="mt-2 text-xs text-amber-700">May close early when a winner is paid. Only the selected entry is paid.</p>
              )}
            </Card>
          )
        })}
      </div>
    </div>
  )
}
