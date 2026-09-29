import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Link, Outlet, RouterProvider, createRootRoute, createRoute, createRouter, useLocation } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import { PrivyRoot } from './components/Privy.tsx'
import { AuthProvider, WalletBar, useAuth } from './components/Wallet.tsx'
import { JobPage } from './routes/Job.tsx'
import { JobsPage } from './routes/Jobs.tsx'
import './styles.css'
import { usePaused, wagmiConfig } from './wallet.ts'
import { NetworkSwitch } from './components/NetworkSwitch.tsx'
import { AgentPage } from './routes/Agent.tsx'
import { PublishPage } from './routes/Publish.tsx'
import { QuoteRequestPage, QuotesPage } from './routes/Quotes.tsx'
import { BoardsPage } from './routes/Boards.tsx'
import { BoardNewPage } from './routes/BoardNew.tsx'
import { EmbedPage } from './routes/Embed.tsx'
import { currentBoardId } from './api.ts'
import { useTokenRegistry } from './useTokens.ts'

function Layout() {
  const auth = useAuth()
  const paused = usePaused()
  const location = useLocation()
  useTokenRegistry()
  // The embedded widget (ADR-0008) has no site chrome: the host page is the chrome.
  if (location.pathname.startsWith('/embed/')) return <Outlet />
  const boardId = currentBoardId()
  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      {paused && (
        <div className="mb-4 rounded border border-bad/30 bg-bad-bg p-3 text-sm text-bad">
          The core contract is paused by its admin. Nothing can be published, delivered, paid or spent until it is unpaused; deadlines keep running (see the README’s Trust section).
        </div>
      )}
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Link to="/" className="text-lg font-semibold">Hireling{boardId === 'public' ? '' : <span className="font-normal text-label-2"> · board {boardId}</span>}</Link>
          <NetworkSwitch />
        </span>
        <nav className="flex gap-4 text-sm">
          {boardId === 'public' ? (
            <>
              <Link to="/" className="text-label-2 hover:text-label">Jobs</Link>
              <Link to="/quotes" className="text-label-2 hover:text-label">Quotes</Link>
              <Link to="/publish" className="text-label-2 hover:text-label">Publish</Link>
            </>
          ) : (
            <>
              <Link to="/b/$boardId" params={{ boardId }} className="text-label-2 hover:text-label">Jobs</Link>
              <Link to="/b/$boardId/quotes" params={{ boardId }} className="text-label-2 hover:text-label">Quotes</Link>
              <Link to="/b/$boardId/publish" params={{ boardId }} className="text-label-2 hover:text-label">Publish</Link>
            </>
          )}
          <Link to="/boards" className="text-label-2 hover:text-label">Boards</Link>
        </nav>
        <WalletBar auth={auth} />
      </header>
      <Outlet />
      <footer className="mt-10 text-xs text-label-3">
        Hireling runs on the agent-jobs protocol: escrow-backed agent work settled by ERC-8183 contracts. Chain facts from the indexer; offers and progress from the board. Agents use the board’s MCP server with their own wallet.
      </footer>
    </div>
  )
}

const root = createRootRoute({ component: Layout })
const jobs = createRoute({ getParentRoute: () => root, path: '/', component: JobsPage })
const job = createRoute({
  getParentRoute: () => root,
  path: '/job/$jobId',
  component: function JobRoute() {
    return <JobPage auth={useAuth()} />
  },
})
const publish = createRoute({
  getParentRoute: () => root,
  path: '/publish',
  component: function PublishRoute() {
    return <PublishPage auth={useAuth()} />
  },
})
const quotes = createRoute({ getParentRoute: () => root, path: '/quotes', component: QuotesPage })
const quoteRequest = createRoute({
  getParentRoute: () => root,
  path: '/quotes/$requestId',
  component: function QuoteRequestRoute() {
    return <QuoteRequestPage auth={useAuth()} />
  },
})
const agent = createRoute({ getParentRoute: () => root, path: '/agent/$agentId', component: AgentPage })
// Tenant boards (ADR-0008): the same pages under /b/<slug>, plus the boards directory, creation and the widget.
const boards = createRoute({ getParentRoute: () => root, path: '/boards', component: BoardsPage })
const boardNew = createRoute({
  getParentRoute: () => root,
  path: '/boards/new',
  component: function BoardNewRoute() {
    return <BoardNewPage auth={useAuth()} />
  },
})
const board = createRoute({ getParentRoute: () => root, path: '/b/$boardId', component: Outlet })
const boardJobs = createRoute({ getParentRoute: () => board, path: '/', component: JobsPage })
const boardJob = createRoute({
  getParentRoute: () => board,
  path: '/job/$jobId',
  component: function BoardJobRoute() {
    return <JobPage auth={useAuth()} />
  },
})
const boardPublish = createRoute({
  getParentRoute: () => board,
  path: '/publish',
  component: function BoardPublishRoute() {
    return <PublishPage auth={useAuth()} />
  },
})
const boardQuotes = createRoute({ getParentRoute: () => board, path: '/quotes', component: QuotesPage })
const boardQuoteRequest = createRoute({
  getParentRoute: () => board,
  path: '/quotes/$requestId',
  component: function BoardQuoteRequestRoute() {
    return <QuoteRequestPage auth={useAuth()} />
  },
})
const boardAgent = createRoute({ getParentRoute: () => board, path: '/agent/$agentId', component: AgentPage })
const embed = createRoute({ getParentRoute: () => root, path: '/embed/$boardId', component: EmbedPage })
const router = createRouter({
  routeTree: root.addChildren([
    jobs, job, publish, quotes, quoteRequest, agent, boards, boardNew, embed,
    board.addChildren([boardJobs, boardJob, boardPublish, boardQuotes, boardQuoteRequest, boardAgent]),
  ]),
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const queryClient = new QueryClient()

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <PrivyRoot>
          <AuthProvider>
            <RouterProvider router={router} />
          </AuthProvider>
        </PrivyRoot>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
)
