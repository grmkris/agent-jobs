import { defineConfig } from 'vite-plus'
export default defineConfig({ test: { include: ['test/**/*.test.ts'], exclude: ['node_modules/**'] } })
