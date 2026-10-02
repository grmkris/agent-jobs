import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Outlet, RouterProvider, createRootRoute, createRoute, createRouter, useLocation } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import { PrivyRoot } from './components/Privy.tsx'
import { ToastProvider } from './components/Sheet.tsx'
import { AuthProvider, useAuth } from './components/Wallet.tsx'
import { Shell } from './components/Shell.tsx'
import { AgentsPage } from './routes/Agents.tsx'
import { MePage } from './routes/Me.tsx'
import { JobPage } from './routes/Job.tsx'
import { JobsPage } from './routes/Jobs.tsx'
import './styles.css'
import { wagmiConfig } from './wallet.ts'
import { AgentPage } from './routes/Agent.tsx'
import { ConnectPage } from './routes/Connect.tsx'
import { PublishPage } from './routes/Publish.tsx'
import { QuoteRequestPage, QuotesPage } from './routes/Quotes.tsx'
import { BoardsPage } from './routes/Boards.tsx'
import { BoardNewPage } from './routes/BoardNew.tsx'
import { EmbedPage } from './routes/Embed.tsx'
import { StakePage } from './routes/Stake.tsx'
import { AdminPage } from './routes/Admin.tsx'
import { CollectPage } from './routes/Collect.tsx'
import { useTokenRegistry } from './useTokens.ts'

function Layout() {
  const location = useLocation()
  useTokenRegistry()
  // The embedded widget (ADR-0008) has no site chrome: the host page is the chrome.
  if (location.pathname.startsWith('/embed/')) return <Outlet />
  return (
    <Shell>
      <Outlet />
    </Shell>
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
const agents = createRoute({ getParentRoute: () => root, path: '/agents', component: AgentsPage })
const connect = createRoute({ getParentRoute: () => root, path: '/connect', component: ConnectPage })
const me = createRoute({ getParentRoute: () => root, path: '/me', component: MePage })
// Staking is the protocol's, not a board's: one page for every board.
const stake = createRoute({ getParentRoute: () => root, path: '/stake', component: StakePage })
const admin = createRoute({ getParentRoute: () => root, path: '/admin', component: AdminPage })
// What the wallet can close or claim, on every board.
const collect = createRoute({ getParentRoute: () => root, path: '/collect', component: CollectPage })
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
    jobs, job, publish, quotes, quoteRequest, agent, agents, connect, me, stake, admin, collect, boards, boardNew, embed,
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
            <ToastProvider>
              <RouterProvider router={router} />
            </ToastProvider>
          </AuthProvider>
        </PrivyRoot>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
)
