import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'

// Alchemy's Cloudflare.Website.Vite injects the Cloudflare plugin at deploy; `worker.ts` is the Worker entry.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The network is fixed per deploy stage (AGENT_JOBS_NETWORK, the same variable the API and indexer read).
  // PRIVY_APP_ID is public (it identifies the app to Privy's login modal); the app secret never reaches the browser.
  define: {
    __AGENT_JOBS_NETWORK__: JSON.stringify(process.env.AGENT_JOBS_NETWORK ?? 'monad-testnet'),
    __PRIVY_APP_ID__: JSON.stringify(process.env.PRIVY_APP_ID ?? ''),
  },
  run: {
    tasks: {
      typecheck: {
        command: 'tsc -p tsconfig.json',
        input: [
          { pattern: 'src/**', base: 'package' },
          { pattern: 'worker.ts', base: 'package' },
          { pattern: 'routing.ts', base: 'package' },
          { pattern: 'contracts/config/**', base: 'workspace' },
          { pattern: 'tsconfig.json', base: 'package' },
          { pattern: 'tsconfig.base.json', base: 'workspace' },
          { pattern: 'pnpm-lock.yaml', base: 'workspace' },
        ],
        output: [],
      },
      test: {
        command: 'vitest run',
        input: [
          { auto: true },
          { pattern: '!**/node_modules/.vite/**', base: 'workspace' },
          { pattern: '!**/node_modules/.vite-temp/**', base: 'workspace' },
        ],
        output: [
          { pattern: '!**/node_modules/.vite/**', base: 'workspace' },
          { pattern: '!**/node_modules/.vite-temp/**', base: 'workspace' },
        ],
      },
    },
  },
})
