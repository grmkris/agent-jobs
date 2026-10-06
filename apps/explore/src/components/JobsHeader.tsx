import { Button } from './ui/button.tsx'
import { cn } from '../lib/cn.ts'
import { textLinkClass } from './kit.tsx'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Check, ChevronsUpDown, Plus } from 'lucide-react'
import { useState } from 'react'
import { type BoardInfo, data } from '../api.ts'
import { BoardLink, boardRoutes } from './BoardLink.tsx'
import { Sheet } from './Sheet.tsx'
import { buttonVariants } from './ui/button.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu.tsx'

import { useAuth } from './Wallet.tsx'

export type JobsArea = 'jobs' | 'quotes' | 'workers'

const TITLE: Record<JobsArea, string> = { jobs: 'Jobs', quotes: 'Quote requests', workers: 'Workers' }

/** Every hosted board (ADR-0008), shared with the Boards page. */
export const useBoards = () =>
  useQuery({ queryKey: ['boards'], queryFn: () => data<{ boards: BoardInfo[] }>('boards'), refetchInterval: 60_000 })

/**
 * The Jobs area's header, shared by its three pages: the page title with the board it shows, Post a job, and the
 * area's tabs (Jobs · Quotes · Workers). Boards are a switcher here rather than a place of their own.
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
          <BoardSwitcher />
        </div>
        <div className="flex items-center gap-2">
          {address === undefined && (
            <Button variant="secondary" size="sm" onClick={() => setHow(true)}>
              How it works
            </Button>
          )}
          <BoardLink target={routes.publish()} className={buttonVariants({ size: 'sm' })}>
            <Plus data-icon="inline-start" />
            Post a job
          </BoardLink>
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

/** Which board's jobs these are: a quiet pill that opens a menu of every hosted board. */
function BoardSwitcher() {
  const { boardId } = boardRoutes()
  const boards = useBoards()
  const navigate = useNavigate()
  const list = boards.data?.boards ?? []
  const name = boardId === 'public' ? 'Public board' : (list.find((b) => b.id === boardId)?.name ?? boardId)
  const go = (id: string) =>
    id === 'public' ? void navigate({ to: '/jobs' }) : void navigate({ to: '/b/$boardId', params: { boardId: id } })
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Board: ${name}`}
        className="inline-flex min-h-7 items-center gap-1 rounded-full bg-muted px-2.5 text-ui font-medium text-muted-foreground transition-colors duration-(--dur-fast) hover:text-foreground data-popup-open:text-foreground pointer-coarse:min-h-11"
      >
        {name}
        <ChevronsUpDown aria-hidden className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Boards</DropdownMenuLabel>
          {(list.length === 0 ? [{ id: 'public', name: 'Public board' }] : list).map((b) => (
            <DropdownMenuItem key={b.id} onClick={() => go(b.id)}>
              <span className="flex-1 truncate">{b.id === 'public' ? 'Public board' : b.name}</span>
              {b.id === boardId && <Check aria-hidden className="size-4" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void navigate({ to: '/boards' })}>All boards</DropdownMenuItem>
        <DropdownMenuItem onClick={() => void navigate({ to: '/boards/new' })}>Create a board</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function HowItWorks({ open, onClose }: { open: boolean; onClose: () => void }) {
  const steps = [
    ['You post a task', 'The reward is locked in escrow on Monad, not held by Sidequest.'],
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
