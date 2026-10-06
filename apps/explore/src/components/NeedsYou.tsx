import type { Phase } from '@sidequest/react'
import { ChevronRight, Clock, Send } from 'lucide-react'
import type { JobListItem } from '../routes/Jobs.tsx'
import { BoardLink, boardRoutes } from './BoardLink.tsx'
import { Sentence } from './Phase.tsx'
import { Group, Section, rowClass } from './ui.tsx'

/**
 * The jobs waiting on this wallet now, from the shared lifecycle model, soonest deadline first. Shown atop Jobs › Mine,
 * from the rows that page already holds; nothing when nothing waits.
 */
export function NeedsYou({ rows }: { rows: ReadonlyArray<{ item: JobListItem; phase: Phase | null }> }) {
  const routes = boardRoutes()
  const waiting = rows
    .filter((r) => r.phase !== null && r.phase.youAct && r.phase.toYou !== null)
    .toSorted((a, b) => (a.phase?.deadline ?? Infinity) - (b.phase?.deadline ?? Infinity))
  if (waiting.length === 0) return null
  return (
    <Section title={`Needs you · ${waiting.length}`} note="From chain facts; a job's page shows exact review and dispute deadlines.">
      <Group>
        {waiting.map(({ item, phase }) => {
          const target = item.jobId === null ? { ...routes.publish(), search: { resume: item.task?.taskId ?? '' } } : routes.job(item.jobId)
          return (
            <BoardLink key={item.jobId ?? item.task?.taskId} target={target} className={rowClass({ inset: true, interactive: true })}>
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-warning/12 text-warning-text">
                {item.jobId === null ? <Send aria-hidden className="size-4" /> : <Clock aria-hidden className="size-4" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{item.task?.title ?? `Job #${item.jobId}`}</span>
                <span className="block text-ui leading-snug text-muted-foreground">{phase !== null && phase.toYou !== null && <Sentence parts={phase.toYou} />}</span>
              </span>
              <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            </BoardLink>
          )
        })}
      </Group>
    </Section>
  )
}
