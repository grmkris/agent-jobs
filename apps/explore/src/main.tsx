import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from './components/ui/empty.tsx'
import { PageTitle, textLinkClass } from './components/kit.tsx'
import { Button } from './components/ui/button.tsx'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  type ErrorComponentProps,
  Link,
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useLocation,
} from '@tanstack/react-router'
import { Component, type ReactNode, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import { PrivyRoot } from './components/Privy.tsx'
import { ToastProvider } from './components/Sheet.tsx'
import { AuthProvider, useAuth } from './components/Wallet.tsx'
import { LaunchGate } from './components/LaunchGate.tsx'
import { Shell } from './components/Shell.tsx'
import { LandingShell } from './components/LandingShell.tsx'
import { MyAgentsPage } from './routes/MyAgents.tsx'
import { AccountPage } from './routes/Account.tsx'
import { JobPage } from './routes/Job.tsx'
import { JobsPage } from './routes/Jobs.tsx'
import './styles.css'
import { wagmiConfig } from './wallet.ts'
import { AgentPage } from './routes/Agent.tsx'
import { ConnectPage } from './routes/Connect.tsx'
import { QuoteRequestPage } from './routes/Request.tsx'
import { BoardsPage } from './routes/Boards.tsx'
import { BoardNewPage } from './routes/BoardNew.tsx'
import { EmbedPage } from './routes/Embed.tsx'
import { AdminPage } from './routes/Admin.tsx'
import { SponsorshipPage } from './routes/Sponsorship.tsx'
import { useTokenRegistry } from './useTokens.ts'
import { AgentNewPage } from './routes/AgentNew.tsx'
import { AgentApprovePage } from './routes/AgentApprove.tsx'
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

/** A page that failed to render: say so and offer a reload, instead of a blank screen. */
function ErrorPage({ error }: ErrorComponentProps) {
  return (
    <>
      <PageTitle>Something went wrong</PageTitle>

      <Empty>
        <EmptyHeader>
          <EmptyTitle>This page could not be shown</EmptyTitle>
          <EmptyDescription className="[overflow-wrap:anywhere]">
            {error instanceof Error ? error.message : 'An unexpected error'}
          </EmptyDescription>
        </EmptyHeader>
        <Button variant="secondary" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </Empty>
    </>
  )
}

const root = createRootRoute({ component: Layout, notFoundComponent: NotFoundPage, errorComponent: ErrorPage })
const jobs = createRoute({ getParentRoute: () => root, path: '/', component: HomePage })
const listings = createRoute({ getParentRoute: () => root, path: '/jobs', component: JobsPage })
const job = createRoute({
  getParentRoute: () => root,
  path: '/job/$jobId',
  component: function JobRoute() {
    return <JobPage auth={useAuth()} />
  },
})
const request = createRoute({
  getParentRoute: () => root,
  path: '/request/$requestId',
  component: function QuoteRequestRoute() {
    return <QuoteRequestPage auth={useAuth()} />
  },
})
// Quote requests are rows of the Jobs list now; their old links (feed, Telegram, bookmarks) still land.
const quotes = createRoute({
  getParentRoute: () => root,
  path: '/quotes',
  beforeLoad: () => {
    throw redirect({ to: '/jobs', search: { view: 'open' } as never, replace: true })
  },
})
const quoteRequest = createRoute({
  getParentRoute: () => root,
  path: '/quotes/$requestId',
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/request/$requestId', params: { requestId: params.requestId }, replace: true })
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
const connect = createRoute({
  getParentRoute: () => root,
  path: '/connect',
  component: ConnectPage,
})
// /agents/<id> is a natural guess for an agent's page (the list is /agents); the page lives at /agent/<id>.
const agentsAlias = createRoute({
  getParentRoute: () => root,
  path: '/agents/$agentId',
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/agent/$agentId', params: { agentId: params.agentId }, replace: true })
  },
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
const agentApprove = createRoute({
  getParentRoute: () => root,
  path: '/agents/approve/$agentKey',
  component: () => (
    <LaunchGate title="Approve your agent">
      <AgentApprovePage />
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
const boardRequest = createRoute({
  getParentRoute: () => board,
  path: '/request/$requestId',
  component: function BoardQuoteRequestRoute() {
    return <QuoteRequestPage auth={useAuth()} />
  },
})
const boardQuotes = createRoute({
  getParentRoute: () => board,
  path: '/quotes',
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/b/$boardId',
      params: { boardId: params.boardId },
      search: { view: 'open' } as never,
      replace: true,
    })
  },
})
const boardQuoteRequest = createRoute({
  getParentRoute: () => board,
  path: '/quotes/$requestId',
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/b/$boardId/request/$requestId',
      params: { boardId: params.boardId, requestId: params.requestId },
      replace: true,
    })
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
    request,
    quotes,
    quoteRequest,
    agent,
    agents,
    connect,
    account,
    agentNew,
    agentApprove,
    agentsAlias,
    admin,
    sponsorship,
    boards,
    boardNew,
    embed,
    board.addChildren([boardJobs, boardJob, boardRequest, boardQuotes, boardQuoteRequest, boardAgent]),
  ]),
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

/**
 * The last resort for an error outside the pages (Privy's modal, the providers): a reload offer instead of a blank
 * screen. Pages have the router's ErrorPage; this has no router, so it is plain markup.
 */
class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error('An unexpected error') }
  }
  override render() {
    if (this.state.error === null) return this.props.children
    return (
      <main className="mx-auto grid max-w-md gap-4 p-8">
        <h1 className="text-xl font-bold">Something went wrong</h1>
        <p className="text-muted-foreground [overflow-wrap:anywhere]">{this.state.error.message}</p>
        <Button variant="secondary" className="justify-self-start" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </main>
    )
  }
}

const queryClient = new QueryClient()

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <AppErrorBoundary>
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
    </AppErrorBoundary>
  </StrictMode>,
)
