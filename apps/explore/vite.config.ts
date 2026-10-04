import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'
import { MAINNET_LIVE } from './src/release.ts'
import { NotDeployedError, deployment } from '../../packages/sdk/src/deployment.ts'

const network = process.env.AGENT_JOBS_NETWORK ?? 'monad-testnet'
/** Whether the network's config has its contracts: false on mainnet until launch day promotes them (as `wallet.ts` reads it). */
const deployed = (() => {
  try {
    deployment(network as 'monad-testnet' | 'monad-mainnet')
    return true
  } catch (error) {
    if (error instanceof NotDeployedError) return false
    throw error
  }
})()

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
 * What this build lets visitors do (D16, PROD-GATE-006), at `/release.json`: the network and `MAINNET_LIVE` from
 * `src/release.ts`, the same value the app is built with. The production artifact pins it and the release checks the
 * built file; post-deploy probes can read it from the live origin. Writes are open on testnet, and on mainnet only
 * once `MAINNET_LIVE` is true and the contracts are in the config, as in the app (`writesOpen` in wallet.ts).
 */
const releaseInfo = () => `${JSON.stringify({ network, mainnetLive: MAINNET_LIVE, writesOpen: (network !== 'monad-mainnet' || MAINNET_LIVE) && deployed }, null, 2)}\n`
function release() {
  return {
    name: 'hireling-release',
    configureServer(server: { middlewares: { use(fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void): void } }) {
      server.middlewares.use((req, res, next) => {
        if ((req.url ?? '').split('?')[0] !== '/release.json') return next()
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(releaseInfo())
      })
    },
    generateBundle(this: { emitFile(f: { type: 'asset'; fileName: string; source: string }): void }) {
      this.emitFile({ type: 'asset', fileName: 'release.json', source: releaseInfo() })
    },
  }
}

/**
 * The agent skills (the repo's `skill/<role>/SKILL.md`) at `/skills/<role>/SKILL.md`, so an operator can `curl` the
 * skill that matches this deploy (the Run your agent page shows how). Emitted into the build; served from the repo in
 * dev.
 */
const SKILL_ROLES = ['connector', 'worker', 'publisher', 'arbitrator'] as const
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

export default defineConfig({
  plugins: [react(), tailwindcss(), manifest(), skills(), release()],
  // The network is fixed per deploy stage (AGENT_JOBS_NETWORK, the same variable the API and indexer read).
  // PRIVY_APP_ID is public (it identifies the app to Privy's login modal); the app secret never reaches the browser.
  define: {
    __AGENT_JOBS_NETWORK__: JSON.stringify(network),
    __PRIVY_APP_ID__: JSON.stringify((network === 'monad-mainnet' ? process.env.HIRELING_PROD_PRIVY_APP_ID : process.env.PRIVY_APP_ID) ?? ''),
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
