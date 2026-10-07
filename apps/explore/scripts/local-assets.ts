import { readFile } from 'node:fs/promises'
async function tryRead(candidate: string) {
  try {
    return await readFile(candidate)
  } catch {
    return undefined
  }
}
import { resolve, sep, extname } from 'node:path'
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
}
/** Local emulator for the same auto-trailing-slash and SPA fallback used by Cloudflare Assets. */
export function localAssets(directory: string) {
  const root = resolve(directory)
  return {
    async fetch(request: Request): Promise<Response> {
      const { pathname } = new URL(request.url)
      let path: string
      try {
        path = decodeURIComponent(pathname)
      } catch {
        return new Response('not found', { status: 404 })
      }
      const file = resolve(root, `.${path}`)
      if (!file.startsWith(`${root}${sep}`) && file !== root) return new Response('not found', { status: 404 })
      let body = await tryRead(file)
      let served = file
      if (body === undefined && !extname(file)) {
        body = await tryRead(`${file}.html`)
        served = `${file}.html`
        if (body === undefined) {
          body = await tryRead(resolve(file, 'index.html'))
          served = resolve(file, 'index.html')
        }
      }
      if (body === undefined) {
        body = await tryRead(resolve(root, 'index.html'))
        served = resolve(root, 'index.html')
      }
      if (body === undefined) return new Response('not found', { status: 404 })
      return new Response(request.method === 'HEAD' ? null : body, {
        headers: {
          'Content-Type': TYPES[extname(served)] ?? 'application/octet-stream',
          'Content-Length': String(body.byteLength),
          ETag: 'local-static-asset',
        },
      })
    },
  }
}
