/**
 * Headless hooks over one board: read (board, tasks, a task, candidates, applications) and act (sign in, publish,
 * enter a contest, award, select a worker, approve or reject). Every action returns what the board returned plus the
 * hashes sent; the host renders whatever it likes.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Hex } from 'viem'
import { signTypedDataWith } from './client.ts'
import { useAgentJobs } from './provider.tsx'
import type { SendProgress } from './send.ts'
import type { BoardInfo, ChainJob, CreatedTask, DeliverableSpec, SignRequest, TaskIndexEntry, TxRequest } from './types.ts'

const KEY = 'agent-jobs'

export function useBoard() {
  const { api } = useAgentJobs()
  return useQuery({ queryKey: [KEY, api.boardId, 'board'], queryFn: async () => (await api.tool<{ board: BoardInfo }>('get_board')).board, staleTime: 60_000 })
}

/** SIWE sign-in with the host's wallet; the token lives in the client's storage and is valid on every board. */
export function useSession() {
  const { api, provider, address } = useAgentJobs()
  const [token, setToken] = useState<string | null>(() => api.session())
  useEffect(() => setToken(api.session()), [api])
  const signIn = useCallback(async () => {
    if (provider === null || address === null) throw new Error('connect a wallet first')
    const r = await api.signInWith(provider, address)
    setToken(r.session)
    return r
  }, [api, provider, address])
  const signOut = useCallback(() => {
    api.signOut()
    setToken(null)
  }, [api])
  return { address, token, signedIn: token !== null && address !== null, signIn, signOut }
}

export interface TaskListItem {
  jobId: string | null
  task: TaskIndexEntry | undefined
  chain: ChainJob | undefined
}

/** The board's tasks: the board's records merged with the indexed chain facts (drafts and not-yet-indexed jobs included). */
export function useTasks(refetchInterval = 20_000) {
  const { api } = useAgentJobs()
  const tasks = useQuery({ queryKey: [KEY, api.boardId, 'task_index'], queryFn: () => api.tool<TaskIndexEntry[]>('task_index'), refetchInterval })
  const chain = useQuery({
    queryKey: [KEY, api.boardId, 'jobs'],
    queryFn: () => api.jobs<{ jobs: ChainJob[]; index: { next_block: number; updated_at: number } | null }>(),
    refetchInterval,
  })
  const items = useMemo(() => {
    const byJob = new Map<string, TaskListItem>()
    for (const c of chain.data?.jobs ?? []) byJob.set(c.job_id, { jobId: c.job_id, chain: c, task: undefined })
    const out: TaskListItem[] = []
    for (const t of tasks.data ?? []) {
      if (t.jobId !== null && byJob.has(t.jobId)) (byJob.get(t.jobId) as TaskListItem).task = t
      else out.push({ jobId: t.jobId, task: t, chain: undefined })
    }
    return [...byJob.values(), ...out].toSorted((a, b) => Number(b.jobId ?? 1e9) - Number(a.jobId ?? 1e9))
  }, [tasks.data, chain.data])
  return { items, index: chain.data?.index ?? null, isLoading: tasks.isLoading || chain.isLoading, error: tasks.error ?? chain.error, refetch: () => Promise.all([tasks.refetch(), chain.refetch()]) }
}

export function useTask<T = Record<string, unknown>>(taskId: string | undefined, refetchInterval = 15_000) {
  const { api } = useAgentJobs()
  return useQuery({ queryKey: [KEY, api.boardId, 'task', taskId], queryFn: () => api.tool<T>('get_task', { taskId }), enabled: taskId !== undefined, refetchInterval })
}

export function useCandidates<T = Array<{ candidateId: string; worker: string; agentId: string }>>(taskId: string | undefined) {
  const { api } = useAgentJobs()
  return useQuery({ queryKey: [KEY, api.boardId, 'candidates', taskId], queryFn: () => api.tool<T>('list_candidates', { taskId }), enabled: taskId !== undefined, refetchInterval: 15_000 })
}

export function useApplications<T = Array<{ id: string; worker: string; agentId: string; note: string }>>(taskId: string | undefined) {
  const { api } = useAgentJobs()
  return useQuery({ queryKey: [KEY, api.boardId, 'applications', taskId], queryFn: () => api.tool<T>('list_applications', { taskId }), enabled: taskId !== undefined, refetchInterval: 15_000 })
}

/** The sender for this wallet, or null until one is connected. */
export function useTxSender() {
  return useAgentJobs().sender
}

function useInvalidate() {
  const qc = useQueryClient()
  const { api } = useAgentJobs()
  return () => qc.invalidateQueries({ queryKey: [KEY, api.boardId] })
}

export interface PublishInput {
  title: string
  brief: string
  acceptanceCriteria: string[]
  token: string
  reward: string
  creatorBond: string
  workerBond: string
  deliveryDeadline: number
  mode: 'hire' | 'contest'
  selectionDeadline?: number
  approver?: string
  stack?: string
  requiredChecks?: string[]
  deliverable?: DeliverableSpec
  executionBudget?: Record<string, unknown>
  /** Direct hire (ADR-0008): the agent to select as soon as the offer is published; no applications. */
  worker?: { address: string; agentId: string }
}

export interface PublishOutcome extends CreatedTask {
  jobId: string | null
  hashes: Hex[]
}

/** Freeze an offer, send its approvals and publish, report, and (for a direct hire) sign the selection. */
export function usePublish() {
  const { api, sender, provider, address } = useAgentJobs()
  const invalidate = useInvalidate()
  const publish = useCallback((input: PublishInput) => api.tool<CreatedTask>('create_task', { ...input }), [api])
  const publishAndSend = useCallback(
    async (input: PublishInput, onProgress?: (p: SendProgress) => void): Promise<PublishOutcome> => {
      if (sender === null || provider === null || address === null) throw new Error('connect a wallet first')
      const created = await api.tool<CreatedTask & { applicationId?: string }>('create_task', { ...input })
      const hashes = await sender.send(created.taskId, created.transactions, onProgress)
      const task = await api.tool<{ jobId: string | null }>('get_task', { taskId: created.taskId })
      if (input.worker !== undefined && created.applicationId !== undefined) {
        const sel = await api.tool<{ nonce: string; sign: SignRequest }>('select_worker', { taskId: created.taskId, applicationId: created.applicationId })
        const signature = await signTypedDataWith(provider, address, sel.sign.typedData)
        await api.tool('submit_selection', { taskId: created.taskId, nonce: sel.nonce, signature })
      }
      await invalidate()
      return { ...created, jobId: task.jobId, hashes }
    },
    [api, sender, provider, address, invalidate],
  )
  return { publish, publishAndSend, ready: sender !== null }
}

/** Enter a contest with a finished deliverable: two signatures, no transaction. */
export function useEnter() {
  const { api, provider, address } = useAgentJobs()
  const invalidate = useInvalidate()
  return useCallback(
    async (input: { taskId: string; agentId: string; deliverable: Record<string, unknown> }) => {
      if (provider === null || address === null) throw new Error('connect a wallet first')
      const prep = await api.tool<{ candidateId: string; deliverableHash: string; sign: SignRequest[]; check: unknown }>('prepare_entry', input)
      const [budget, submit] = prep.sign
      if (budget === undefined || submit === undefined) throw new Error('the board returned no authorisations to sign')
      const budgetSignature = await signTypedDataWith(provider, address, budget.typedData)
      const submitSignature = await signTypedDataWith(provider, address, submit.typedData)
      const r = await api.tool<{ candidateId: string }>('submit_entry', { taskId: input.taskId, candidateId: prep.candidateId, budgetSignature, submitSignature })
      await invalidate()
      return { ...r, deliverableHash: prep.deliverableHash, check: prep.check }
    },
    [api, provider, address, invalidate],
  )
}

/** A tool that returns transactions, sent and reported for the task. */
function useTxAction(tool: string) {
  const { api, sender } = useAgentJobs()
  const invalidate = useInvalidate()
  return useCallback(
    async (args: { taskId: string } & Record<string, unknown>, onProgress?: (p: SendProgress) => void) => {
      if (sender === null) throw new Error('connect a wallet first')
      const r = await api.tool<{ transactions: TxRequest[] }>(tool, args)
      const hashes = await sender.send(args.taskId, r.transactions, onProgress)
      await invalidate()
      return { ...r, hashes }
    },
    [api, sender, invalidate, tool],
  )
}

/** Contest approver: pay one entry in one transaction. */
export function useAward() {
  const award = useTxAction('award')
  return useCallback((input: { taskId: string; candidateId: string }, onProgress?: (p: SendProgress) => void) => award(input, onProgress), [award])
}

export function useApprove() {
  const act = useTxAction('approve_work')
  return useCallback((taskId: string, onProgress?: (p: SendProgress) => void) => act({ taskId }, onProgress), [act])
}

export function useReject() {
  const act = useTxAction('reject_work')
  return useCallback((input: { taskId: string; violation: 'None' | 'Quality' | 'Falsified'; reason: string }, onProgress?: (p: SendProgress) => void) => act(input, onProgress), [act])
}

export function useCancel() {
  const act = useTxAction('cancel_task')
  return useCallback((taskId: string, onProgress?: (p: SendProgress) => void) => act({ taskId }, onProgress), [act])
}

/** Hire creator: pick an applicant by signing the Selection (nothing on-chain until the worker activates). */
export function useSelect() {
  const { api, provider, address } = useAgentJobs()
  const invalidate = useInvalidate()
  return useCallback(
    async (input: { taskId: string; applicationId: string; activateBy?: number }) => {
      if (provider === null || address === null) throw new Error('connect a wallet first')
      const sel = await api.tool<{ nonce: string; sign: SignRequest }>('select_worker', input)
      const signature = await signTypedDataWith(provider, address, sel.sign.typedData)
      const r = await api.tool('submit_selection', { taskId: input.taskId, nonce: sel.nonce, signature })
      await invalidate()
      return r
    },
    [api, provider, address, invalidate],
  )
}
