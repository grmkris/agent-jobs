import { RotateCcw } from 'lucide-react'
import type { ChainJob } from '../../api.ts'
import { BoardLink, boardRoutes } from '../BoardLink.tsx'
import { cn } from '../ui.tsx'

/** The chain statuses of a job that paid its agent: a hire completed, or a contest's awarded entry. */
export const PAID = new Set(['completed', 'awarded'])

const eq = (a: string | null | undefined, b: string | null | undefined) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()

/** The most recent job `creator` paid `agentId` for: what Hire again repeats from the agent's profile. */
export function lastPaidJob(jobs: readonly ChainJob[], creator: string | undefined, agentId: string): ChainJob | undefined {
  return jobs.filter((j) => PAID.has(j.status) && j.agent_id === agentId && eq(j.creator, creator)).toSorted((a, b) => Number(b.job_id) - Number(a.job_id))[0]
}

/** Opens Post with a paid job's offer prefilled as a direct hire of the same agent (`/publish?again=<jobId>`). */
export function HireAgainLink({ jobId, className }: { jobId: string; className?: string }) {
  return (
    <BoardLink
      target={{ ...boardRoutes().publish(), search: { again: jobId } }}
      className={cn('press inline-flex min-h-[3.125rem] items-center justify-center gap-2 rounded-2xl bg-tint px-5 font-semibold text-on-tint', className)}
    >
      <RotateCcw aria-hidden className="size-4" strokeWidth={2.4} />
      Hire again
    </BoardLink>
  )
}
