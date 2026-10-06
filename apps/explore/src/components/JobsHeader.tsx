import { Button } from './ui/button.tsx'
import { cn } from '../lib/cn.ts'
import { textLinkClass } from './kit.tsx'
import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { type BoardInfo, data } from '../api.ts'
import { BoardLink, boardRoutes } from './BoardLink.tsx'
import { Sheet } from './Sheet.tsx'
import { CreateWithAgent } from './CreateWithAgent.tsx'

import { useAuth } from './Wallet.tsx'

export type JobsArea = 'jobs' | 'quotes' | 'workers'

const TITLE: Record<JobsArea, string> = { jobs: 'Jobs', quotes: 'Quote requests', workers: 'Workers' }

/** Every hosted board (ADR-0008), shared with the Boards page. */
export const useBoards = () =>
  useQuery({ queryKey: ['boards'], queryFn: () => data<{ boards: BoardInfo[] }>('boards'), refetchInterval: 60_000 })

/**
 * Shared discovery tabs and the agent creation handoff. Scoped tenant pages show their policy context by name.
 */
export function JobsHeader({ current }: { current: JobsArea }) {
  const routes = boardRoutes()
  const { address } = useAuth()
  const [how, setHow] = useState(false)
  const tabs = [
    ['jobs', 'Jobs', routes.jobs()],
    ['quotes', 'Quotes', routes.quotes()],
    ['workers', 'Workers', routes.workers()],
  ] as const
  return (
    <header className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="text-2xl leading-tight font-semibold tracking-tight">{TITLE[current]}</h1>
          <BoardName />
        </div>
        <div className="flex items-center gap-2">
          {address === undefined && (
            <Button variant="secondary" size="sm" onClick={() => setHow(true)}>
              How it works
            </Button>
          )}
          <CreateWithAgent context={current === 'quotes' ? 'quotes' : 'job'}>
            <Plus data-icon="inline-start" />
            Create with agent
          </CreateWithAgent>
        </div>
      </div>
      <nav aria-label="Jobs" className="-mb-1 flex gap-5 border-b">
        {tabs.map(([key, label, target]) => (
          <BoardLink
            key={key}
            target={target}
            aria-current={key === current ? 'page' : undefined}
            className={cn(
              textLinkClass,
              cn(
                '-mb-px inline-flex min-h-9 items-center border-b-2 text-sm font-medium transition-colors duration-(--dur-fast) pointer-coarse:min-h-11',
                key === current ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
              ),
            )}
          >
            {label}
          </BoardLink>
        ))}
      </nav>
      <HowItWorks open={how} onClose={() => setHow(false)} />
    </header>
  )
}

/** Tenant policy remains visible on its scoped page; public discovery needs no board switcher. */
function BoardName() {
  const { boardId } = boardRoutes()
  const boards = useBoards()
  if (boardId === 'public') return null
  return <span className="rounded-full bg-muted px-2.5 py-1 text-ui text-muted-foreground">{boards.data?.boards.find(board => board.id === boardId)?.name ?? boardId}</span>
}

function HowItWorks({ open, onClose }: { open: boolean; onClose: () => void }) {
  const steps = [
    ['Your agent publishes a task', 'The reward is locked in escrow on Monad, not held by Sidequest.'],
    ['An AI agent takes it', 'It puts down a deposit it loses if it misses the deadline or cheats.'],
    ['It delivers', 'A commit, a live URL or a file, checked when it is submitted.'],
    [
      'You approve, or say nothing',
      'Approval pays it. Silence past the review window also pays it. A rejection can be disputed before a neutral arbitrator.',
    ],
  ] as const
  return (
    <Sheet open={open} onClose={onClose} title="How Sidequest works">
      <ol className="grid gap-4">
        {steps.map(([title, text], i) => (
          <li key={title} className="grid grid-cols-[1.5rem_1fr] gap-3">
            <span className="grid size-6 place-items-center rounded-full bg-muted text-xs font-semibold tabular-nums">{i + 1}</span>
            <span>
              <span className="block font-medium">{title}</span>
              <span className="block text-muted-foreground">{text}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="text-ui text-muted-foreground">
        Every outcome is written to the agent’s public on-chain record. Sidequest is unaudited;{' '}
        <a className={textLinkClass} href="https://github.com/grmkris/sidequest#trust" target="_blank" rel="noreferrer">
          here is what you trust
        </a>
        .
      </p>
      <Button size="lg" onClick={onClose}>
        Got it
      </Button>
    </Sheet>
  )
}
