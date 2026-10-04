import { defineConfig } from 'vite-plus'

export default defineConfig({
  run: {
    tasks: {
      typecheck: {
        command: 'tsc -p tsconfig.json',
        // tsgo's file reads are invisible to Vite+'s automatic tracking (a changed src/ replayed a stale
        // cache hit on 2026-09-26), so the inputs are declared by hand.
        input: [
          { pattern: 'src/**', base: 'package' },
          { pattern: 'scripts/live/**', base: 'package' },
          { pattern: 'scripts/privy/**', base: 'package' },
          { pattern: 'scripts/v1-flows.ts', base: 'package' },
          { pattern: 'scripts/demo-workers.ts', base: 'package' },
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
        // MONAD_TESTNET_RPC_URL enables the tests that read the deployed contracts; unset, they skip.
        env: ['FORK_RPC_TIMEOUT_MS', 'FORK_STARTUP_TIMEOUT_MS', 'MONAD_TESTNET_RPC_URL'],
      },
    },
  },
})
