import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Link, Outlet, RouterProvider, createRootRoute, createRoute, createRouter, useLocation } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import { PrivyRoot } from './components/Privy.tsx'
import { ToastProvider } from './components/Sheet.tsx'
import { AuthProvider, useAuth } from './components/Wallet.tsx'
import { LaunchGate } from './components/LaunchGate.tsx'
import { Shell } from './components/Shell.tsx'
import { LandingShell } from './components/LandingShell.tsx'
import { AgentsPage } from './routes/Agents.tsx'
import { MyAgentsPage } from './routes/MyAgents.tsx'
import { AccountPage } from './routes/Account.tsx'
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
import { BackingPage } from './routes/Backing.tsx'
import { AdminPage } from './routes/Admin.tsx'
import { CollectPage } from './routes/Collect.tsx'
import { SponsorshipPage } from './routes/Sponsorship.tsx'
import { TelegramPage } from './routes/Telegram.tsx'
import { useTokenRegistry } from './useTokens.ts'
import { AgentNewPage } from './routes/AgentNew.tsx'
import { HomePage } from './routes/Home.tsx'
import { EmptyState, PageTitle } from './components/ui.tsx'

function Layout() {
  const location = useLocation()
  useTokenRegistry()
  // The embedded widget (ADR-0008) has no site chrome: the host page is the chrome.
  if (location.pathname.startsWith('/embed/')) return <Outlet />
  if (location.pathname === '/') return <LandingShell><Outlet /></LandingShell>
  return (
    <Shell>
      <Outlet />
    </Shell>
  )
}

/** Any path without a page, including the retired /me, /stake, /workspace, /approvals and /protocol. */
function NotFoundPage() {
  return (
    <>
      <PageTitle>Page not found</PageTitle>
      <EmptyState title="Nothing lives at this address">
        <Link to="/jobs" className="text-tint">Browse jobs</Link>
      </EmptyState>
    </>
  )
}

const root = createRootRoute({ component: Layout, notFoundComponent: NotFoundPage })
const jobs = createRoute({ getParentRoute: () => root, path: '/', component: HomePage })
const listings = createRoute({ getParentRoute: () => root, path: '/jobs', component: JobsPage })
const job = createRoute({
  getParentRoute: () => root,
  path: '/job/$jobId',
  component: function JobRoute() {
    return <JobPage auth={useAuth()} />
  },
})
// Pages that write are "launching soon" on mainnet before launch (D16), also when opened by URL.
const publish = createRoute({
  getParentRoute: () => root,
  path: '/publish',
  component: function PublishRoute() {
    const auth = useAuth()
    return (
      <LaunchGate title="Post a job">
        <PublishPage auth={auth} />
      </LaunchGate>
    )
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
const agent = createRoute({
  getParentRoute: () => root,
  path: '/agent/$agentId',
  component: AgentPage,
})
// The operator's own agents; each opens on its page, which carries the owner tabs.
const agents = createRoute({ getParentRoute: () => root, path: '/agents', component: () => <LaunchGate title="Agents"><MyAgentsPage /></LaunchGate> })
// The worker directory, a tab of the Jobs area.
const workers = createRoute({ getParentRoute: () => root, path: '/workers', component: AgentsPage })
const connect = createRoute({
  getParentRoute: () => root,
  path: '/connect',
  component: ConnectPage,
})
const agentNew = createRoute({ getParentRoute: () => root, path: '/agents/new', component: () => <LaunchGate title="Create an agent"><AgentNewPage /></LaunchGate> })
const account = createRoute({ getParentRoute: () => root, path: '/account', component: AccountPage })
// Backing is the protocol's, not a board's: one page for every board.
const backing = createRoute({
  getParentRoute: () => root,
  path: '/backing',
  validateSearch: (search: Record<string, unknown>): { account?: string } => typeof search.account === 'string' ? { account: search.account } : {},
  component: () => (
    <LaunchGate title="Back an agent">
      <BackingPage />
    </LaunchGate>
  ),
})
const admin = createRoute({
  getParentRoute: () => root,
  path: '/admin',
  component: () => (
    <LaunchGate title="Admin">
      <AdminPage />
    </LaunchGate>
  ),
})
// What the wallet can close or claim, on every board.
const collect = createRoute({
  getParentRoute: () => root,
  path: '/collect',
  component: () => (
    <LaunchGate title="Collect">
      <CollectPage />
    </LaunchGate>
  ),
})
const telegram = createRoute({
  getParentRoute: () => root,
  path: '/telegram',
  component: () => (
    <LaunchGate title="Telegram">
      <TelegramPage />
    </LaunchGate>
  ),
})
const sponsorship = createRoute({
  getParentRoute: () => root,
  path: '/sponsorship',
  component: () => (
    <LaunchGate title="Gas sponsorship">
      <SponsorshipPage />
    </LaunchGate>
  ),
})
// Tenant boards (ADR-0008): the same pages under /b/<slug>, plus the boards directory, creation and the widget.
const boards = createRoute({ getParentRoute: () => root, path: '/boards', component: BoardsPage })
const boardNew = createRoute({
  getParentRoute: () => root,
  path: '/boards/new',
  component: function BoardNewRoute() {
    const auth = useAuth()
    return (
      <LaunchGate title="Create a board">
        <BoardNewPage auth={auth} />
      </LaunchGate>
    )
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
    const auth = useAuth()
    return (
      <LaunchGate title="Post a job">
        <PublishPage auth={auth} />
      </LaunchGate>
    )
  },
})
const boardQuotes = createRoute({
  getParentRoute: () => board,
  path: '/quotes',
  component: QuotesPage,
})
const boardQuoteRequest = createRoute({
  getParentRoute: () => board,
  path: '/quotes/$requestId',
  component: function BoardQuoteRequestRoute() {
    return <QuoteRequestPage auth={useAuth()} />
  },
})
const boardWorkers = createRoute({ getParentRoute: () => board, path: '/workers', component: AgentsPage })
const boardAgent = createRoute({
  getParentRoute: () => board,
  path: '/agent/$agentId',
  component: AgentPage,
})
const embed = createRoute({
  getParentRoute: () => root,
  path: '/embed/$boardId',
  component: EmbedPage,
})
const router = createRouter({
  routeTree: root.addChildren([
    jobs,
    listings,
    job,
    publish,
    quotes,
    quoteRequest,
    agent,
    agents,
    workers,
    connect,
    account,
    agentNew,
    backing,
    admin,
    collect,
    telegram,
    sponsorship,
    boards,
    boardNew,
    embed,
    board.addChildren([boardJobs, boardJob, boardPublish, boardQuotes, boardQuoteRequest, boardWorkers, boardAgent]),
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
