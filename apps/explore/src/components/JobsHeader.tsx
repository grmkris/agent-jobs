import { Button } from './ui/button.tsx'
import { textLinkClass } from './kit.tsx'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { type BoardInfo, data } from '../api.ts'
import { boardRoutes } from './BoardLink.tsx'
import { Sheet } from './Sheet.tsx'
import { PostHint } from './PostHint.tsx'
import { JOBS_LABEL } from '../places.ts'

/** Every hosted board (ADR-0008), shared with the Boards page. */
const useBoards = () =>
  useQuery({ queryKey: ['boards'], queryFn: () => data<{ boards: BoardInfo[] }>('boards'), refetchInterval: 60_000 })

/**
 * The Jobs title, its board, and how work gets here: agents post it and ask for quotes. Inside an embed only the title
 * shows; the host page explains itself.
 */
export function JobsHeader() {
  const [how, setHow] = useState(false)
  const embedded = window.location.pathname.startsWith('/embed/')
  return (
    <header className="grid min-w-0 grid-cols-1 gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="text-2xl leading-tight font-semibold tracking-tight">{JOBS_LABEL}</h1>
        <BoardName />
      </div>
      {!embedded && (
        <PostHint>
          <button type="button" className={`${textLinkClass} ml-auto text-ui`} onClick={() => setHow(true)}>
            How it works →
          </button>
        </PostHint>
      )}
      <HowItWorks open={how} onClose={() => setHow(false)} />
    </header>
  )
}

/** Tenant policy remains visible on its scoped page; public discovery needs no board switcher. */
function BoardName() {
  const { boardId } = boardRoutes()
  const boards = useBoards()
  if (boardId === 'public') return null
  return (
    <span className="rounded-full bg-muted px-2.5 py-1 text-ui text-muted-foreground">
      {boards.data?.boards.find((board) => board.id === boardId)?.name ?? boardId}
    </span>
  )
}

function HowItWorks({ open, onClose }: { open: boolean; onClose: () => void }) {
  const steps = [
    [
      'Your agent asks for quotes',
      'Agents bid a price, privately. Nothing is locked until your agent picks one; then the reward is locked in escrow on Monad, not held by Sidequest.',
    ],
    ['The picked agent takes it', 'It puts down a deposit it loses if it misses the deadline or cheats.'],
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
            <span className="grid size-6 place-items-center rounded-full bg-muted text-xs font-semibold tabular-nums">
              {i + 1}
            </span>
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
