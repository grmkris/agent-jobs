import { formatPrivyAuthorizationPayload } from '../../src/privy.ts'

export interface PrivyResponse {
  status: number
  json: Record<string, unknown>
  code: string
}

/** Error bodies can echo request data; expose only the HTTP status and a machine code. */
export class PrivyApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly route: string,
  ) {
    super(`Privy ${route}: HTTP ${status} (${code})`)
  }
}

export class PrivyApi {
  constructor(
    readonly appId: string,
    private readonly appSecret: string,
  ) {}

  async request(
    method: string,
    route: string,
    body?: Record<string, unknown>,
    sign?: (payload: string) => Promise<string>,
    idempotencyKey?: string,
  ): Promise<PrivyResponse> {
    if (!/^\/(?:wallets|users|key_quorums|policies)(?:\/|$)/.test(route)) throw new Error('Unexpected Privy route')
    const url = `https://api.privy.io/v1${route}`
    const cleanBody = JSON.parse(JSON.stringify(body ?? {})) as Record<string, unknown>
    const privyHeaders: Record<string, string> = { 'privy-app-id': this.appId }
    if (method !== 'GET') privyHeaders['privy-request-expiry'] = String(Date.now() + 60_000)
    if (idempotencyKey) privyHeaders['privy-idempotency-key'] = idempotencyKey
    const headers: Record<string, string> = {
      ...privyHeaders,
      authorization: `Basic ${btoa(`${this.appId}:${this.appSecret}`)}`,
      'content-type': 'application/json',
    }
    if (sign) {
      headers['privy-authorization-signature'] = await sign(
        formatPrivyAuthorizationPayload({
          method,
          url,
          body: cleanBody,
          headers: privyHeaders,
        }),
      )
    }
    const response = await fetch(url, {
      method,
      headers,
      ...(method === 'GET' ? {} : { body: JSON.stringify(cleanBody) }),
      signal: AbortSignal.timeout(30_000),
    })
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>
    const candidate = json.code ?? json.error
    const code = typeof candidate === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(candidate) ? candidate : 'unspecified'
    return { status: response.status, json, code }
  }

  async checked(...args: Parameters<PrivyApi['request']>): Promise<Record<string, unknown>> {
    const result = await this.request(...args)
    if (result.status < 200 || result.status >= 300) throw new PrivyApiError(result.status, result.code, args[1])
    return result.json
  }
}
