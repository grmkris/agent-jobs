import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { fumadocsMdx } from 'fumadocs-mdx/vite'
import { defineConfig } from 'vite-plus'
import { docsOrigin } from './src/lib/origin.ts'
const pages = readdirSync(fileURLToPath(new URL('./content/docs', import.meta.url)), { recursive: true }).filter((file) => String(file).endsWith('.mdx')).flatMap((file) => {
  const slug = String(file).replace(/\.mdx$/, '')
  const path = slug === 'index' ? '/docs' : `/docs/${slug}`
  return [{ path }, { path: `/docs/${slug}.md` }]
})
export default defineConfig({
  publicDir: false,
  preview: { host: '127.0.0.1' },
  plugins: [fumadocsMdx(), tailwindcss(), tanstackStart({
    spa: { enabled: true },
    prerender: { enabled: true, crawlLinks: true, autoSubfolderIndex: false, filter: ({ path }) => path.startsWith('/docs') || path.startsWith('/llms') || path.startsWith('/__tsr/') },
    pages: [...pages, { path: '/docs/not-found' }, { path: '/docs/search.json' }, { path: '/llms.txt' }, { path: '/llms-full.txt' }],
  }), react()],
  resolve: { tsconfigPaths: true },
  define: { __DOCS_ORIGIN__: JSON.stringify(docsOrigin()) },
  build: { assetsDir: 'docs/_assets' },
  run: { tasks: {
    typecheck: { command: 'tsc -p tsconfig.json', input: [{ pattern: 'src/**', base: 'package' }, { pattern: 'test/**', base: 'package' }, { pattern: 'vite.config.ts', base: 'package' }, { pattern: 'tsconfig.json', base: 'package' }, { pattern: 'content/**', base: 'package' }, { pattern: 'contracts/config/**', base: 'workspace' }, { pattern: 'packages/sdk/src/deployment.ts', base: 'workspace' }, { pattern: 'infra/**', base: 'workspace' }, { pattern: 'pnpm-lock.yaml', base: 'workspace' }], output: [] },
    test: { command: 'vitest run', input: [{ pattern: 'test/**', base: 'package' }, { pattern: 'src/**', base: 'package' }, { pattern: 'content/**', base: 'package' }, { pattern: 'contracts/config/**', base: 'workspace' }, { pattern: 'apps/explore/src/styles.css', base: 'workspace' }, { pattern: 'infra/**', base: 'workspace' }, { pattern: 'pnpm-lock.yaml', base: 'workspace' }], output: [] },
  } },
})
