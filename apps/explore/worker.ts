/**
 * The Explore Worker: static assets for the SPA, and the board API proxied same-origin through the `API` service
 * binding (no CORS, no API URL baked into the build).
 */
interface Env {
  readonly API: { fetch(request: Request): Promise<Response> }
  readonly ASSETS: { fetch(request: Request): Promise<Response> }
}

const PROXIED = ['/api/', '/data/', '/offers/', '/mcp', '/health']

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (PROXIED.some((p) => pathname === p || pathname.startsWith(p))) return env.API.fetch(request)
    return env.ASSETS.fetch(request)
  },
}
