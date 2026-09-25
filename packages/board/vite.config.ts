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
