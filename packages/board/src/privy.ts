/**
 * Privy for the execution budget (ADR-0005): the board holds one P-256 authorization key, registered with Privy as a
 * key quorum. A creator's embedded wallet adds that quorum as a session signer restricted to a policy; the board then
 * signs wallet RPC requests with the key. WebCrypto only, so it runs in Workers and Node alike.
 *
 * Authorization signature (Privy's `formatRequestForAuthorizationSignature`): RFC 8785 JSON of
 * `{version: 1, method, url, body, headers: {privy-app-id, privy-idempotency-key?}}` (an empty body becomes `""`),
 * ECDSA P-256 over SHA-256, low-S, DER, base64, sent as `privy-authorization-signature`.
 */
import { canonicalJson } from './terms.ts'

export const PRIVY_API = 'https://api.privy.io/v1'

export interface PrivyApp {
  readonly appId: string
  readonly appSecret: string
}

export class PrivyApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message: string,
  ) {
    super(message)
  }
}

export interface SignatureInput {
  readonly method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  readonly url: string
  readonly body: unknown
  readonly appId: string
  readonly idempotencyKey?: string
}

/** The exact bytes Privy verifies (and the browser's `generateAuthorizationSignature` signs). */
export function signaturePayload(input: SignatureInput): Uint8Array {
  const body = typeof input.body === 'object' && input.body !== null && Object.keys(input.body).length === 0 ? '' : input.body
  const headers: Record<string, string> = { 'privy-app-id': input.appId }
  if (input.idempotencyKey !== undefined) headers['privy-idempotency-key'] = input.idempotencyKey
  return new TextEncoder().encode(canonicalJson({ version: 1, method: input.method, url: input.url, body, headers }))
}

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n

const bytesToBig = (b: Uint8Array) => b.reduce((acc, x) => (acc << 8n) | BigInt(x), 0n)

function bigToBytes(n: bigint): number[] {
  const out: number[] = []
  for (let v = n; v > 0n; v >>= 8n) out.unshift(Number(v & 0xffn))
  if (out.length === 0) out.push(0)
  if ((out[0] as number) & 0x80) out.unshift(0)
  return out
}

/** WebCrypto's IEEE P1363 `r||s` as a low-S DER signature. */
export function p1363ToDer(sig: Uint8Array): Uint8Array {
  const r = bytesToBig(sig.slice(0, 32))
  let s = bytesToBig(sig.slice(32, 64))
  if (s > P256_N / 2n) s = P256_N - s
  const rb = bigToBytes(r)
  const sb = bigToBytes(s)
  const body = [0x02, rb.length, ...rb, 0x02, sb.length, ...sb]
  return new Uint8Array([0x30, body.length, ...body])
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0))

/** `pkcs8` is the base64 PKCS#8 private key with no PEM headers (Privy's format; a `wallet-auth:` prefix is accepted). */
export async function authorizationSignature(pkcs8: string, input: SignatureInput): Promise<string> {
  const key = await crypto.subtle.importKey('pkcs8', unb64(pkcs8.replace(/^wallet-auth:/, '')), { name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
  ])
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, signaturePayload(input)))
  return b64(p1363ToDer(sig))
}

/** A fresh P-256 pair in Privy's formats: SPKI (public) and PKCS#8 (private), base64 without PEM headers. */
export async function generateAuthorizationKey(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  return {
    publicKey: b64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))),
    privateKey: b64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))),
  }
}

export interface PrivyRequest {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  /** Path under `/v1`, e.g. `/policies`. */
  readonly path: string
  readonly body?: unknown
  readonly idempotencyKey?: string
  /** Signatures to send, e.g. the board key's and/or one the owner produced in the browser. */
  readonly signatures?: readonly string[]
}

/** One Privy REST call with app-secret Basic auth; throws `PrivyApiError` with Privy's own body on refusal. */
export async function privyFetch<T>(app: PrivyApp, req: PrivyRequest, fetchFn: typeof fetch = fetch): Promise<T> {
  const headers: Record<string, string> = {
    authorization: `Basic ${btoa(`${app.appId}:${app.appSecret}`)}`,
    'privy-app-id': app.appId,
    'content-type': 'application/json',
  }
  if (req.idempotencyKey !== undefined) headers['privy-idempotency-key'] = req.idempotencyKey
  if (req.signatures !== undefined && req.signatures.length > 0) headers['privy-authorization-signature'] = req.signatures.join(',')
  const res = await fetchFn(`${PRIVY_API}${req.path}`, {
    method: req.method,
    headers,
    ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
  })
  const text = await res.text()
  if (!res.ok) throw new PrivyApiError(res.status, text, `privy ${req.method} ${req.path}: HTTP ${res.status} ${text.slice(0, 300)}`)
  return (text === '' ? {} : JSON.parse(text)) as T
}

/** A signed request: the board key signs exactly what is sent. */
export async function signedPrivyFetch<T>(
  app: PrivyApp,
  pkcs8: string,
  req: Omit<PrivyRequest, 'signatures' | 'method'> & { method: 'POST' | 'PATCH' | 'DELETE' },
  fetchFn: typeof fetch = fetch,
): Promise<T> {
  const signature = await authorizationSignature(pkcs8, {
    method: req.method,
    url: `${PRIVY_API}${req.path}`,
    body: req.body ?? {},
    appId: app.appId,
    ...(req.idempotencyKey === undefined ? {} : { idempotencyKey: req.idempotencyKey }),
  })
  return privyFetch<T>(app, { ...req, signatures: [signature] }, fetchFn)
}

const b64urlToBytes = (s: string) => unb64(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='))

/**
 * Verifies a Privy access token (ES256 JWT from the browser's `getAccessToken`) against the app's published JWKS and
 * returns the user's DID. Issuer `privy.io`, audience the app id, not expired.
 */
export async function verifyAccessToken(appId: string, token: string, now: number, fetchFn: typeof fetch = fetch): Promise<string> {
  const [h, p, sig] = token.split('.')
  if (h === undefined || p === undefined || sig === undefined) throw new Error('not a JWT')
  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h))) as { alg?: string; kid?: string }
  const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p))) as { iss?: string; aud?: string | string[]; sub?: string; exp?: number }
  if (header.alg !== 'ES256') throw new Error('unexpected token algorithm')
  const res = await fetchFn(`https://auth.privy.io/api/v1/apps/${appId}/jwks.json`)
  const { keys } = (await res.json()) as { keys: Array<{ kid?: string; kty?: string; crv?: string; x?: string; y?: string }> }
  const jwk = keys.find((k) => k.kid === header.kid)
  if (jwk === undefined) throw new Error('unknown signing key')
  if (jwk.x === undefined || jwk.y === undefined) throw new Error('signing key has no point')
  const point = Uint8Array.from([0x04, ...b64urlToBytes(jwk.x), ...b64urlToBytes(jwk.y)])
  const key = await crypto.subtle.importKey('raw', point, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64urlToBytes(sig), new TextEncoder().encode(`${h}.${p}`))
  if (!ok) throw new Error('bad signature')
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  if (payload.iss !== 'privy.io' || !aud.includes(appId)) throw new Error('token is not for this app')
  if (payload.exp === undefined || payload.exp <= now) throw new Error('token expired')
  if (payload.sub === undefined) throw new Error('token has no subject')
  return payload.sub
}
