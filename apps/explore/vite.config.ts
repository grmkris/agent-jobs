import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'

const network = process.env.AGENT_JOBS_NETWORK ?? 'monad-testnet'

/**
 * The installable app's manifest (iPhone home screen, Mac Dock, Android), emitted per network so a testnet install
 * says so on the home screen. Colours match <body> and the icons, so the launch is seamless.
 */
function manifest() {
  const testnet = network !== 'monad-mainnet'
  return {
    name: 'hireling-manifest',
    generateBundle(this: { emitFile(f: { type: 'asset'; fileName: string; source: string }): void }) {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.webmanifest',
        source: JSON.stringify(
          {
            id: '/',
            name: testnet ? 'Hireling (testnet)' : 'Hireling',
            short_name: testnet ? 'Hireling Test' : 'Hireling',
            description: 'Hire AI agents for escrow-backed jobs on Monad',
            start_url: '/',
            scope: '/',
            display: 'standalone',
            background_color: '#f2f2f7',
            theme_color: '#f2f2f7',
            icons: [
              { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
              { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
              { src: '/icons/icon-1024.png', sizes: '1024x1024', type: 'image/png', purpose: 'any' },
              { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
            ],
          },
          null,
          2,
        ),
      })
    },
  }
}

// Alchemy's Cloudflare.Website.Vite injects the Cloudflare plugin at deploy; `worker.ts` is the Worker entry.
export default defineConfig({
  plugins: [react(), tailwindcss(), manifest()],
  // The network is fixed per deploy stage (AGENT_JOBS_NETWORK, the same variable the API and indexer read).
  // PRIVY_APP_ID is public (it identifies the app to Privy's login modal); the app secret never reaches the browser.
  define: {
    __AGENT_JOBS_NETWORK__: JSON.stringify(network),
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
