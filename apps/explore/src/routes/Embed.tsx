import { useQuery } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useAccount, useConnect } from 'wagmi'
import { type BoardInfo, currentBoardId, tool } from '../api.ts'
import { PrivyLogin } from '../components/Privy.tsx'
import { Address, Badge, Button } from '../components/ui.tsx'
import { FundButton } from '../components/Fund.tsx'
import { useAuth } from '../components/Wallet.tsx'
import { JobPage } from './Job.tsx'
import { JobsPage } from './Jobs.tsx'
import { PublishPage } from './Publish.tsx'

export type EmbedEvent =
  | 'ready'
  | 'signed-in'
  | 'published'
  | 'entered'
  | 'awarded'
  | 'approved'
  | 'rejected'
  | 'pledged'
  | 'launched'
  | 'cancelled'
  | 'disputed'
  | 'settled'
  | 'error'
  | 'resize'

/** Tells the host page what happened (ADR-0008 postMessage contract). Payloads carry only public identifiers. */
export function postToHost(board: string, type: EmbedEvent, payload: Record<string, unknown> = {}) {
  if (window.parent === window) return
  window.parent.postMessage({ source: 'agent-jobs', v: 1, board, type, payload }, '*')
}

/**
 * The drop-in widget (`/embed/<board>?view=publish|task|jobs&…`): the board's publish form, one job, or its jobs
 * list, with no site chrome, inside a host page's iframe (`embed.js`). Wallet: Privy by default; `wallet=injected`
 * connects the page's own `window.ethereum` (a host that already has a wallet, or a test harness).
 */
export function EmbedPage() {
  const { boardId } = useParams({ strict: false }) as { boardId: string }
  const search = new URLSearchParams(window.location.search)
  const wallet = search.get('wallet') ?? 'privy'
  const [view, setView] = useState(search.get('view') ?? 'publish')
  const [taskId, setTaskId] = useState<string | null>(search.get('taskId'))
  const auth = useAuth()
  const { isConnected } = useAccount()
  const { connect, connectors } = useConnect()
  const board = useQuery({ queryKey: ['get_board', boardId], queryFn: async () => (await tool<{ board: BoardInfo }>('get_board')).board })
  const task = useQuery({ queryKey: ['embed-task', taskId], queryFn: () => tool<{ jobId: string | null }>('get_task', { taskId }), enabled: taskId !== null, refetchInterval: 10_000 })
  const [prefill, setPrefill] = useState<Record<string, string>>(() => {
    const p: Record<string, string> = {}
    for (const k of ['title', 'brief', 'reward', 'token', 'mode', 'worker', 'agentId']) {
      const v = search.get(k)
      if (v !== null) p[k] = v
    }
    return p
  })

  useEffect(() => {
    postToHost(boardId, 'ready', { view })
    const ro = new ResizeObserver(() => postToHost(boardId, 'resize', { height: document.documentElement.scrollHeight }))
    ro.observe(document.body)
    const onMessage = (e: MessageEvent) => {
      const m = e.data as { source?: string; type?: string; payload?: Record<string, string> }
      if (m?.source === 'agent-jobs-host' && m.type === 'prefill' && m.payload !== undefined) setPrefill((p) => ({ ...p, ...m.payload }))
    }
    window.addEventListener('message', onMessage)
    return () => {
      ro.disconnect()
      window.removeEventListener('message', onMessage)
    }
  }, [boardId, view])

  const injected = connectors.find((c) => c.id === 'injected')
  useEffect(() => {
    if (wallet === 'injected' && !isConnected && injected !== undefined) connect({ connector: injected })
  }, [wallet, isConnected, connect, injected])

  useEffect(() => {
    if (auth.signedIn && auth.address !== undefined) postToHost(boardId, 'signed-in', { address: auth.address })
  }, [auth.signedIn, auth.address, boardId])

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const signIn = async () => {
    setBusy(true)
    setError(null)
    try {
      await auth.signIn()
    } catch (e) {
      const m = (e as Error).message.split('\n')[0] ?? 'sign-in failed'
      setError(m)
      postToHost(boardId, 'error', { code: 'sign-in', message: m })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl p-3">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-medium">{board.data?.name ?? currentBoardId()} <span className="text-neutral-400">· Hireling</span></span>
        <span className="flex items-center gap-2">
          {auth.address === undefined ? (
            wallet === 'injected' ? (
              <Button disabled={injected === undefined} onClick={() => injected !== undefined && connect({ connector: injected })}>Connect wallet</Button>
            ) : (
              <PrivyLogin />
            )
          ) : (
            <>
              <Address value={auth.address} />
              <FundButton address={auth.address} />
              {auth.signedIn ? <Badge tone="green">signed in</Badge> : <Button busy={busy} onClick={signIn}>Sign in</Button>}
            </>
          )}
        </span>
      </header>
      {error !== null && <p className="mb-2 text-xs text-red-600">{error}</p>}
      {view === 'jobs' && <JobsPage />}
      {view === 'publish' && (
        <PublishPage
          auth={auth}
          prefill={prefill}
          onPublished={(t) => {
            postToHost(boardId, 'published', { taskId: t.taskId, jobId: t.jobId, txHash: t.txHash })
            setTaskId(t.taskId)
            setView('task')
          }}
        />
      )}
      {view === 'task' &&
        (task.data?.jobId !== undefined && task.data.jobId !== null ? (
          <JobPage auth={auth} jobId={task.data.jobId} onEvent={(type, payload) => postToHost(boardId, type, { taskId, ...payload })} />
        ) : (
          <p className="text-sm text-neutral-500">{taskId === null ? 'No task selected.' : 'Waiting for the publish transaction to confirm…'}</p>
        ))}
    </div>
  )
}
