import { defineConfig } from 'vite-plus'

/**
 * `test` deploys the whole stack into local workerd through alchemy's test harness, so its inputs
 * reach past this package (the stack file at the root). The scratch paths vitest and alchemy write
 * are excluded from the fingerprint or the task never caches (see cloudflare-os for the history).
 */
export default defineConfig({
  run: {
    tasks: {
      typecheck: {
        command: 'tsc -p tsconfig.json',
      },
      test: {
        command: 'vitest run',
        input: [
          { auto: true },
          { pattern: 'alchemy.run.ts', base: 'workspace' },
          { pattern: '!**/node_modules/.vite/**', base: 'workspace' },
          { pattern: '!**/node_modules/.vite-temp/**', base: 'workspace' },
          { pattern: '!**/.alchemy/**', base: 'workspace' },
        ],
        output: [
          { pattern: '!**/node_modules/.vite/**', base: 'workspace' },
          { pattern: '!**/node_modules/.vite-temp/**', base: 'workspace' },
          { pattern: '!**/.alchemy/**', base: 'workspace' },
        ],
        env: ['CI', 'ALCHEMY_STAGE'],
      },
    },
  },
})
