import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export function docsOrigin(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.SIDEQUEST_DOCS_ORIGIN ?? env.SIDEQUEST_ORIGIN
  if (explicit) return new URL(explicit).origin
  if (env.SIDEQUEST_STAGE && /^[a-z0-9-]+$/.test(env.SIDEQUEST_STAGE)) {
    const path = resolve(process.cwd(), '../../infra', `${env.SIDEQUEST_STAGE}.json`)
    if (existsSync(path)) return new URL((JSON.parse(readFileSync(path, 'utf8')) as { origin: string }).origin).origin
  }
  if (env.SIDEQUEST_NETWORK === 'monad-mainnet') return 'https://sidequest.exchange'
  return 'http://localhost:5173'
}

// No Node call at import: the docs' browser bundle reaches this module through docsOrigin(), and a browser stub of
// fileURLToPath throws there. A decoded file-URL pathname is the same absolute path on POSIX.
export const docsDir = decodeURIComponent(new URL('../../../apps/docs/', import.meta.url).pathname)
export function siteDir(root = docsDir): string {
  const output = resolve(root, '.output/public')
  return existsSync(output) ? output : resolve(root, 'dist/client')
}
