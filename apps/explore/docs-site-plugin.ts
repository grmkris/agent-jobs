import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { Plugin } from 'vite'
import { docsDir, siteDir } from '../docs/site-output.mjs'
import { docsOrigin } from '../docs/src/lib/origin.ts'
import { serveDocs, docsRoute } from './docs-handler.ts'
import { localAssets } from './scripts/local-assets.ts'

export function docsOutputFiles(root: string): string[] {
  if (!existsSync(root)) throw new Error(`Missing docs output: ${root}`)
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name).slice(root.length + 1).replaceAll('\\', '/')).filter(file => file === 'docs.html' || file.startsWith('docs/') || file.startsWith('__tsr/staticServerFnCache/') || file === 'llms.txt' || file === 'llms-full.txt').toSorted()
}
export function assertDocsCollisions(files: string[], bundle: Record<string, unknown>, publicDir: string | false): void {
  for (const file of files) if (file in bundle || (publicDir !== false && existsSync(join(publicDir, file)))) throw new Error(`Docs output collides with Explore asset: ${file}`)
}
function runDocs(args: string[]): void {
  const result = spawnSync(process.execPath, args, { cwd: docsDir, env: { ...process.env, SIDEQUEST_DOCS_ORIGIN: docsOrigin() }, stdio: 'inherit' })
  if (result.error || result.status !== 0) throw new Error(`Docs build/verification failed (${result.status ?? result.error?.message ?? 'unknown'})`)
}
export function docsSite(): Plugin {
  let output: string[] = []
  let root: string
  let publicDir: string | false = false
  return {
    name: 'sidequest-docs-site', apply: 'build',
    configResolved(config) { publicDir = config.publicDir },
    buildStart() {
      if (this.environment.name !== 'client') return
      if (process.env.SIDEQUEST_DOCS_PREBUILT !== '1') runDocs([resolve(docsDir, 'node_modules/vite/bin/vite.js'), 'build'])
      runDocs([resolve(docsDir, 'scripts/verify-output.mjs')])
      root = siteDir()
      output = docsOutputFiles(root)
    },
    generateBundle(_options, bundle) {
      if (this.environment.name !== 'client') return
      assertDocsCollisions(output, bundle, publicDir)
      for (const file of output) this.emitFile({ type: 'asset', fileName: file, source: readFileSync(join(root, file)) })
    },
  }
}
export function docsDev(): Plugin {
  return {
    name: 'sidequest-docs-dev', apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => { void (async () => {
        const origin = `http://${req.headers.host ?? 'localhost'}`
        const route = docsRoute(new URL(req.url ?? '/', origin).pathname)
        if (!route) return next()
        try {
          const root = siteDir()
          if (!existsSync(join(root, 'docs.html'))) { res.statusCode = 404; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end('Docs output is missing. Run bun run --cwd apps/docs build, or use the docs dev server.'); return }
          const headers = new Headers()
          for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(',') : value)
          const result = await serveDocs(new Request(new URL(req.url ?? '/', origin), { method: req.method ?? 'GET', headers }), { ASSETS: localAssets(root) }, route)
          res.statusCode = result.status
          for (const [key, value] of result.headers) res.setHeader(key, value)
          res.end(Buffer.from(await result.arrayBuffer()))
        } catch (error) { next(error instanceof Error ? error : new Error(String(error))) }
      })() })
    },
  }
}
