import { RotateCcw } from 'lucide-react'
import type { ChainJob } from '../../api.ts'
import { CreateWithAgent } from '../CreateWithAgent.tsx'

/** Whether a job paid its agent: its work was accepted and the hire completed. */
export const paidJob = (job: Pick<ChainJob, 'status'>) => job.status === 'completed'

const eq = (a: string | null | undefined, b: string | null | undefined) =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()

/** The most recent job `creator` paid `agentId` for: what Hire again repeats from the agent's profile. */
export function lastPaidJob(
  jobs: readonly ChainJob[],
  creator: string | undefined,
  agentId: string,
): ChainJob | undefined {
  return jobs
    .filter((j) => paidJob(j) && j.agent_id === agentId && eq(j.creator, creator))
    .toSorted((a, b) => Number(b.job_id) - Number(a.job_id))[0]
}

/** A fresh hire, using the paid job as context for the publisher. */
export function HireAgainLink({ jobId, className }: { jobId: string; className?: string }) {
  return (
    <CreateWithAgent context="again" jobId={jobId} className={className}>
      <RotateCcw aria-hidden data-icon="inline-start" strokeWidth={2.4} />
      Hire again
    </CreateWithAgent>
  )
}
