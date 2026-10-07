import { isMarkdownPreferred } from 'fumadocs-core/negotiation'

export interface DocsEnv {
  readonly ASSETS: { fetch(request: Request): Promise<Response> }
}
export type DocsRoute =
  | { kind: 'page'; path: string; markdown: string }
  | { kind: 'markdown' | 'static' | 'search' | 'text'; path: string }
  | { kind: 'redirect'; location: string; status: 301 | 308 }
const COMMON = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Frame-Options': 'DENY',
  Vary: 'Accept',
}
const TEXT_CSP = "default-src 'none'; frame-ancestors 'none'"

export function docsRoute(path: string): DocsRoute | undefined {
  if (path === '/docs/') return { kind: 'redirect', location: '/docs', status: 308 }
  if (path === '/docs.html' || /^\/docs\/.*\.html$/.test(path))
    return { kind: 'redirect', location: path.slice(0, -5), status: 301 }
  if (path === '/docs/search.json') return { kind: 'search', path }
  if (path.startsWith('/docs/_assets/') || path.startsWith('/__tsr/staticServerFnCache/'))
    return { kind: 'static', path }
  if (path === '/llms.txt' || path === '/llms-full.txt') return { kind: 'text', path }
  if (path === '/docs.md') return { kind: 'markdown', path: '/docs/index.md' }
  if (path.startsWith('/docs/') && path.endsWith('.md')) return { kind: 'markdown', path }
  if (path === '/docs' || path.startsWith('/docs/'))
    return { kind: 'page', path, markdown: path === '/docs' ? '/docs/index.md' : `${path}.md` }
  return undefined
}
function isHtml(response: Response): boolean {
  return response.headers.get('content-type')?.toLowerCase().startsWith('text/html') === true
}
function makeResponse(request: Request, body: BodyInit | null, status: number, headers: HeadersInit): Response {
  const result = new Headers(headers)
  for (const [key, value] of Object.entries(COMMON)) result.set(key, value)
  result.delete('Content-Length')
  result.delete('ETag')
  return new Response(request.method === 'HEAD' ? null : body, { status, headers: result })
}
function text(
  request: Request,
  body: string,
  status = 200,
  type = 'text/plain; charset=utf-8',
  extra: HeadersInit = {},
): Response {
  const headers = new Headers(extra)
  headers.set('Content-Type', type)
  headers.set('Content-Security-Policy', TEXT_CSP)
  headers.set('Access-Control-Allow-Origin', '*')
  return makeResponse(request, body, status, headers)
}
function html(request: Request, body: string, status = 200, extra: HeadersInit = {}): Response {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
  const headers = new Headers(extra)
  headers.set('Content-Type', 'text/html; charset=utf-8')
  headers.set(
    'Content-Security-Policy',
    `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; worker-src 'self'`,
  )
  return makeResponse(request, body.replace(/<script\b/gi, `<script nonce="${nonce}"`), status, headers)
}
const FALLBACK_404 =
  '<!doctype html><html lang="en"><head><meta name="generator" content="sidequest-docs"></head><body><main><h1>Documentation page not found</h1><a href="/docs">Return to the docs</a></main></body></html>'

export async function serveDocs(request: Request, env: DocsEnv, route: DocsRoute): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return text(request, 'method not allowed', 405, undefined, { Allow: 'GET, HEAD' })
  if (route.kind === 'redirect') return text(request, '', route.status, undefined, { Location: route.location })
  const get = (path: string) => env.ASSETS.fetch(new Request(new URL(path, request.url)))
  const markdown = async (path: string) => {
    const asset = await get(path)
    return !asset.ok || isHtml(asset)
      ? text(request, 'not found', 404)
      : text(request, await asset.text(), 200, 'text/markdown; charset=utf-8')
  }
  const notFound = async () => {
    if (isMarkdownPreferred(request)) return text(request, 'not found', 404)
    const asset = await get('/docs/not-found')
    const body = await asset.text()
    return html(
      request,
      asset.ok && isHtml(asset) && body.includes('content="sidequest-docs"') ? body : FALLBACK_404,
      404,
    )
  }
  if (route.kind === 'page') {
    if (isMarkdownPreferred(request)) return markdown(route.markdown)
    const asset = await get(route.path)
    const body = await asset.text()
    if (!asset.ok || !isHtml(asset) || !body.includes('content="sidequest-docs"')) return notFound()
    return html(request, body, 200, {
      Link: `<${new URL(route.markdown, request.url).href}>; rel="alternate"; type="text/markdown"`,
    })
  }
  if (route.kind === 'markdown') return markdown(route.path)
  const asset = await get(route.path)
  if (!asset.ok || isHtml(asset)) return text(request, 'not found', 404)
  if (route.kind === 'search')
    return text(request, await asset.text(), 200, 'application/json; charset=utf-8', {
      'Cache-Control': 'public, max-age=300',
    })
  if (route.kind === 'text') return text(request, await asset.text())
  const headers = new Headers(asset.headers)
  headers.set('Content-Security-Policy', TEXT_CSP)
  headers.set('Access-Control-Allow-Origin', '*')
  if (route.path.startsWith('/docs/_assets/')) headers.set('Cache-Control', 'public, max-age=31536000, immutable')
  return makeResponse(request, await asset.arrayBuffer(), 200, headers)
}
