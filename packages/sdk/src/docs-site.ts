import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

export const docsDir = fileURLToPath(new URL('../../../apps/docs/', import.meta.url))
export function siteDir(root = docsDir): string {
  const output = resolve(root, '.output/public')
  return existsSync(output) ? output : resolve(root, 'dist/client')
}
