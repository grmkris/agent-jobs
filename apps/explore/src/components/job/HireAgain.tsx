import { buttonVariants } from '../ui/button.tsx'
import { cn } from '../../lib/cn.ts'
import { RotateCcw } from 'lucide-react'
import type { ChainJob } from '../../api.ts'
import { BoardLink, boardRoutes } from '../BoardLink.tsx'

/** Whether a job paid its agent: its work was accepted and the hire completed. */
export const paidJob = (job: Pick<ChainJob, 'status'>) => job.status === 'completed'

const eq = (a: string | null | undefined, b: string | null | undefined) =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()

/** The most recent job `creator` paid `agentId` for: what Hire again repeats from the agent's profile. */
export function lastPaidJob(jobs: readonly ChainJob[], creator: string | undefined, agentId: string): ChainJob | undefined {
  return jobs
    .filter((j) => paidJob(j) && j.agent_id === agentId && eq(j.creator, creator))
    .toSorted((a, b) => Number(b.job_id) - Number(a.job_id))[0]
}

/** Opens Post with a paid job's offer prefilled as a direct hire of the same agent (`/publish?again=<jobId>`). */
export function HireAgainLink({ jobId, className }: { jobId: string; className?: string }) {
  return (
    <BoardLink target={{ ...boardRoutes().publish(), search: { again: jobId } }} className={cn(buttonVariants({ size: 'lg' }), className)}>
      <RotateCcw aria-hidden data-icon="inline-start" strokeWidth={2.4} />
      Hire again
    </BoardLink>
  )
}
