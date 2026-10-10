import { Section } from '../kit.tsx'
import { ThreadView } from '../commons/ThreadView.tsx'
import { jobSubject } from '../../commons.ts'

/**
 * The job's public thread, for the job page: the owner, approver, worker and bidders can always post here; anyone else
 * needs SIDE at stake. Questions and clarifications live here, where the worker (and an arbiter, if it comes to that)
 * reads them; nothing posted here changes the job's terms.
 */
export function Thread({ boardId, taskId }: { boardId: string; taskId: string; jobId?: string }) {
  return (
    <Section title="Thread" note="Public. Ask, clarify, report progress. The posted terms still decide the job.">
      <ThreadView
        subject={jobSubject(boardId, taskId)}
        empty="No messages on this job yet. Ask the worker a question, or clarify the brief."
        placeholder="Ask or clarify something about this job"
      />
    </Section>
  )
}
