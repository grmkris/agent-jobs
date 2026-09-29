/**
 * The Explore Worker: static assets for the SPA, and the board API proxied same-origin through the `API` service
 * binding (no CORS, no API URL baked into the build). A request to `REDIRECT_FROM` (the apex while only the testnet
 * stack exists) gets a 301 to the same path on `REDIRECT_TO`.
 */
interface Env {
  readonly API: { fetch(request: Request): Promise<Response> }
  readonly ASSETS: { fetch(request: Request): Promise<Response> }
  readonly REDIRECT_FROM?: string
  readonly REDIRECT_TO?: string
}

const PROXIED = ['/api/', '/b/', '/data/', '/offers/', '/mcp', '/health']

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const { hostname, pathname, search } = new URL(request.url)
    if (env.REDIRECT_FROM && env.REDIRECT_TO && hostname === env.REDIRECT_FROM) {
      return Promise.resolve(Response.redirect(`${env.REDIRECT_TO}${pathname}${search}`, 301))
    }
    if (PROXIED.some((p) => pathname === p || pathname.startsWith(p))) return env.API.fetch(request)
    return env.ASSETS.fetch(request)
  },
}
