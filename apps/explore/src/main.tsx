import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Outlet, RouterProvider, createRootRoute, createRoute, createRouter, useLocation } from '@tanstack/react-router'
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
import { MePage } from './routes/Me.tsx'
import { JobPage } from './routes/Job.tsx'
import { JobsPage } from './routes/Jobs.tsx'
import './styles.css'
import { wagmiConfig } from './wallet.ts'
import { AgentPage } from './routes/Agent.tsx'
import { ConnectPage, ProtocolConnectPage } from './routes/Connect.tsx'
import { PublishPage } from './routes/Publish.tsx'
import { QuoteRequestPage, QuotesPage } from './routes/Quotes.tsx'
import { BoardsPage } from './routes/Boards.tsx'
import { BoardNewPage } from './routes/BoardNew.tsx'
import { EmbedPage } from './routes/Embed.tsx'
import { StakePage } from './routes/Stake.tsx'
import { AdminPage } from './routes/Admin.tsx'
import { CollectPage } from './routes/Collect.tsx'
import { SponsorshipPage } from './routes/Sponsorship.tsx'
import { TelegramPage } from './routes/Telegram.tsx'
import { useTokenRegistry } from './useTokens.ts'
import { WorkspacePage } from './routes/Workspace.tsx'
import { ApprovalsPage } from './routes/Approvals.tsx'
import { AgentNewPage } from './routes/AgentNew.tsx'
import { HomePage } from './routes/Home.tsx'

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

const root = createRootRoute({ component: Layout })
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
const agents = createRoute({ getParentRoute: () => root, path: '/agents', component: AgentsPage })
const connect = createRoute({
  getParentRoute: () => root,
  path: '/connect',
  component: ConnectPage,
})
const protocol = createRoute({
  getParentRoute: () => root,
  path: '/protocol',
  component: ProtocolConnectPage,
})
const workspace = createRoute({ getParentRoute: () => root, path: '/workspace', component: () => <LaunchGate title="Workspace"><WorkspacePage /></LaunchGate> })
const approvals = createRoute({ getParentRoute: () => root, path: '/approvals', component: () => <LaunchGate title="Approvals"><ApprovalsPage /></LaunchGate> })
const agentNew = createRoute({ getParentRoute: () => root, path: '/agents/new', component: () => <LaunchGate title="Create an agent"><AgentNewPage /></LaunchGate> })
const me = createRoute({ getParentRoute: () => root, path: '/me', component: MePage })
// Staking is the protocol's, not a board's: one page for every board.
const stake = createRoute({
  getParentRoute: () => root,
  path: '/stake',
  component: () => (
    <LaunchGate title="Stake">
      <StakePage />
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
    connect,
    protocol,
    me,
    workspace,
    approvals,
    agentNew,
    stake,
    admin,
    collect,
    telegram,
    sponsorship,
    boards,
    boardNew,
    embed,
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
