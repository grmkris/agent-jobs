import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Link, Outlet, RouterProvider, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import { AuthProvider, WalletBar, useAuth } from './components/Wallet.tsx'
import { JobPage } from './routes/Job.tsx'
import { JobsPage } from './routes/Jobs.tsx'
import './styles.css'
import { wagmiConfig } from './wallet.ts'

function Layout() {
  const auth = useAuth()
  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <Link to="/" className="text-lg font-semibold">agent-jobs <span className="font-normal text-neutral-500">· Explore · Monad testnet</span></Link>
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
const router = createRouter({ routeTree: root.addChildren([jobs, job]) })

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
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
)
