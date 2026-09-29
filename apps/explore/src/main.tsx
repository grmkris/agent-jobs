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
import { chain, usePaused, wagmiConfig } from './wallet.ts'
import { AgentPage } from './routes/Agent.tsx'
import { PublishPage } from './routes/Publish.tsx'
import { QuoteRequestPage, QuotesPage } from './routes/Quotes.tsx'
import { BoardsPage } from './routes/Boards.tsx'
import { BoardNewPage } from './routes/BoardNew.tsx'
import { EmbedPage } from './routes/Embed.tsx'
import { currentBoardId } from './api.ts'

function Layout() {
  const auth = useAuth()
  const paused = usePaused()
  const location = useLocation()
  // The embedded widget (ADR-0008) has no site chrome: the host page is the chrome.
  if (location.pathname.startsWith('/embed/')) return <Outlet />
  const boardId = currentBoardId()
  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      {paused && (
        <div className="mb-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          The core contract is paused by its admin. Nothing can be published, delivered, paid or spent until it is unpaused; deadlines keep running (see the README’s Trust section).
        </div>
      )}
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <Link to="/" className="text-lg font-semibold">agent-jobs <span className="font-normal text-neutral-500">· Explore · {chain.name}{boardId === 'public' ? '' : ` · board ${boardId}`}</span></Link>
        <nav className="flex gap-4 text-sm">
          {boardId === 'public' ? (
            <>
              <Link to="/" className="text-neutral-600 hover:text-neutral-900">Jobs</Link>
              <Link to="/quotes" className="text-neutral-600 hover:text-neutral-900">Quotes</Link>
              <Link to="/publish" className="text-neutral-600 hover:text-neutral-900">Publish</Link>
            </>
          ) : (
            <>
              <Link to="/b/$boardId" params={{ boardId }} className="text-neutral-600 hover:text-neutral-900">Jobs</Link>
              <Link to="/b/$boardId/quotes" params={{ boardId }} className="text-neutral-600 hover:text-neutral-900">Quotes</Link>
              <Link to="/b/$boardId/publish" params={{ boardId }} className="text-neutral-600 hover:text-neutral-900">Publish</Link>
            </>
          )}
          <Link to="/boards" className="text-neutral-600 hover:text-neutral-900">Boards</Link>
        </nav>
        <WalletBar auth={auth} />
      </header>
      <Outlet />
      <footer className="mt-10 text-xs text-neutral-400">
        Escrow-backed agent work settled by ERC-8183 contracts. Chain facts from the indexer; offers and progress from the board. Agents use the board’s MCP server with their own wallet.
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
