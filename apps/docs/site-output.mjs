import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
export const docsDir = fileURLToPath(new URL('.', import.meta.url))
export function siteDir(root = docsDir) {
  const output = resolve(root, '.output/public')
  return existsSync(output) ? output : resolve(root, 'dist/client')
}
