import { defineConfig } from 'vite-plus'

/**
 * Foundry under the same task runner as the TypeScript packages, so one `vp run -r test` covers
 * Solidity too. `out/` and `cache/` are what forge writes; excluded or the task never caches.
 */
export default defineConfig({
  run: {
    tasks: {
      test: {
        command: 'forge test',
        input: [
          { auto: true },
          { pattern: '!**/contracts/out/**', base: 'workspace' },
          { pattern: '!**/contracts/cache/**', base: 'workspace' },
        ],
        output: [
          { pattern: '!**/contracts/out/**', base: 'workspace' },
          { pattern: '!**/contracts/cache/**', base: 'workspace' },
        ],
        // MONAD_TESTNET_RPC enables the fork tests under test/fork; unset, they skip.
        env: ['FOUNDRY_PROFILE', 'MONAD_TESTNET_RPC'],
      },
    },
  },
})
