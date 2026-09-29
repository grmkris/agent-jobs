import { defineConfig } from 'vite-plus'

export default defineConfig({
  run: {
    tasks: {
      typecheck: {
        command: 'tsc -p tsconfig.json && tsc -p tsconfig.tools.json',
        input: [
          { pattern: 'workflows/ci-evidence/**', base: 'workspace' },
          { pattern: 'packages/sdk/src/**', base: 'workspace' },
          { pattern: 'packages/board/src/**', base: 'workspace' },
          { pattern: 'contracts/config/**', base: 'workspace' },
          { pattern: 'tsconfig.base.json', base: 'workspace' },
          { pattern: 'pnpm-lock.yaml', base: 'workspace' },
        ],
        output: [],
      },
      test: { command: 'vitest run', input: [{ auto: true }], output: [] },
    },
  },
})
