import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
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

/**
 * The agent skills (the repo's `skill/<role>/SKILL.md`) at `/skills/<role>/SKILL.md`, so an operator can `curl` the
 * skill that matches this deploy (the Run your agent page shows how). Emitted into the build; served from the repo in
 * dev.
 */
const SKILL_ROLES = ['worker', 'publisher', 'arbitrator'] as const
const skillSource = (role: string) => readFileSync(fileURLToPath(new URL(`../../skill/${role}/SKILL.md`, import.meta.url)), 'utf8')
function skills() {
  return {
    name: 'hireling-skills',
    configureServer(server: { middlewares: { use(fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void): void } }) {
      server.middlewares.use((req, res, next) => {
        const role = /^\/skills\/([a-z]+)\/SKILL\.md$/.exec((req.url ?? '').split('?')[0] ?? '')?.[1]
        if (role === undefined || !(SKILL_ROLES as readonly string[]).includes(role)) return next()
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
        res.end(skillSource(role))
      })
    },
    generateBundle(this: { emitFile(f: { type: 'asset'; fileName: string; source: string }): void }) {
      for (const role of SKILL_ROLES) this.emitFile({ type: 'asset', fileName: `skills/${role}/SKILL.md`, source: skillSource(role) })
    },
  }
}

// Alchemy's Cloudflare.Website.Vite injects the Cloudflare plugin at deploy; `worker.ts` is the Worker entry.
export default defineConfig({
  plugins: [react(), tailwindcss(), manifest(), skills()],
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
