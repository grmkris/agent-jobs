import { defineConfig } from 'vite-plus'

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
