import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from './components/ui/empty.tsx'
import { PageTitle, textLinkClass } from './components/kit.tsx'
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
import { QuoteRequestPage, QuotesPage } from './routes/Quotes.tsx'
import { BoardsPage } from './routes/Boards.tsx'
import { BoardNewPage } from './routes/BoardNew.tsx'
import { EmbedPage } from './routes/Embed.tsx'
import { AdminPage } from './routes/Admin.tsx'
import { SponsorshipPage } from './routes/Sponsorship.tsx'
import { useTokenRegistry } from './useTokens.ts'
import { AgentNewPage } from './routes/AgentNew.tsx'
import { HomePage } from './routes/Home.tsx'

function Layout() {
  const location = useLocation()
  useTokenRegistry()
  // The embedded widget (ADR-0008) has no site chrome: the host page is the chrome.
  if (location.pathname.startsWith('/embed/')) return <Outlet />
  if (location.pathname === '/')
    return (
      <LandingShell>
        <Outlet />
      </LandingShell>
    )
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

      <Empty>
        <EmptyHeader>
          <EmptyTitle>Nothing lives at this address</EmptyTitle>
          <EmptyDescription>
            <Link to="/jobs" className={textLinkClass}>
              Browse jobs
            </Link>
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
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
const agents = createRoute({
  getParentRoute: () => root,
  path: '/agents',
  component: () => (
    <LaunchGate title="Agents">
      <MyAgentsPage />
    </LaunchGate>
  ),
})
// The worker directory, a tab of the Jobs area.
const workers = createRoute({ getParentRoute: () => root, path: '/workers', component: AgentsPage })
const connect = createRoute({
  getParentRoute: () => root,
  path: '/connect',
  component: ConnectPage,
})
const agentNew = createRoute({
  getParentRoute: () => root,
  path: '/agents/new',
  component: () => (
    <LaunchGate title="Create an agent">
      <AgentNewPage />
    </LaunchGate>
  ),
})
const account = createRoute({ getParentRoute: () => root, path: '/account', component: AccountPage })
const admin = createRoute({
  getParentRoute: () => root,
  path: '/admin',
  component: () => (
    <LaunchGate title="Admin">
      <AdminPage />
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
    quotes,
    quoteRequest,
    agent,
    agents,
    workers,
    connect,
    account,
    agentNew,
    admin,
    sponsorship,
    boards,
    boardNew,
    embed,
    board.addChildren([boardJobs, boardJob, boardQuotes, boardQuoteRequest, boardWorkers, boardAgent]),
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
