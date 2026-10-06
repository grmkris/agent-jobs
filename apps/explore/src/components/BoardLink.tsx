import { Link, useNavigate } from '@tanstack/react-router'
import type { ComponentProps } from 'react'
import { currentBoardId } from '../api.ts'

export interface LinkTarget {
  to: string
  params?: Record<string, string>
  search?: Record<string, string>
}

/**
 * Where a page lives for the current board (ADR-0008): the public board's routes are the plain ones, a tenant
 * board's are under `/b/<slug>`. Both route trees exist; this only picks.
 */
export function boardRoutes(boardId = currentBoardId()) {
  const on = boardId !== 'public'
  const p = (to: string, params: Record<string, string> = {}): LinkTarget =>
    on ? { to: `/b/$boardId${to === '/' ? '' : to}`, params: { boardId, ...params } } : { to, params }
  return {
    boardId,
    jobs: () => p(on ? '/' : '/jobs'),
    job: (jobId: string) => p('/job/$jobId', { jobId }),
    publish: () => p('/publish'),
    quotes: () => p('/quotes'),
    workers: () => p('/workers'),
    quoteRequest: (requestId: string) => p('/quotes/$requestId', { requestId }),
    agent: (agentId: string) => p('/agent/$agentId', { agentId }),
  }
}

export function BoardLink({ target, ...props }: { target: LinkTarget } & Omit<ComponentProps<'a'>, 'href' | 'target'>) {
  return (
    <Link to={target.to as '/'} params={(target.params ?? {}) as never} search={target.search as never} {...props}>
      {props.children}
    </Link>
  )
}

export function useBoardNavigate() {
  const navigate = useNavigate()
  return (target: LinkTarget) => navigate({ to: target.to as '/', params: (target.params ?? {}) as never, search: target.search as never })
}
