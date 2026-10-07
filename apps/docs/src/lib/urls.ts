import { docsOrigin } from './origin.ts'

export function markdownUrl(url: string, origin = docsOrigin()): string {
  if (!url.startsWith('/') || url.startsWith('//')) return url
  const parsed = new URL(url, origin)
  if (parsed.pathname === '/docs') parsed.pathname = '/docs/index.md'
  else if (parsed.pathname.startsWith('/docs/') && !parsed.pathname.endsWith('.md')) parsed.pathname += '.md'
  return parsed.href
}
