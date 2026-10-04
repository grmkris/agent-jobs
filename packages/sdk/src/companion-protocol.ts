/** Shared, dependency-free protocol primitives for the local Hireling companion.
 *
 * The local key is a P-256 authorization key (K), never the agent wallet's Ethereum
 * key (W). The server verifies the exact request envelope before forwarding it to
 * Privy. Keep these helpers deterministic so a downloaded companion and API agree.
 */
import { createHash, createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify } from 'node:crypto'
import type { KeyObject } from 'node:crypto'

export type CompanionHeaders = Readonly<Record<string, string>>
export interface AuthorizationEnvelope {
  readonly v: 1
  readonly method: string
  readonly url: string
  readonly headers: CompanionHeaders
  readonly body: string
  readonly expiresAt: number
  readonly nonce: string
  readonly signature: string
  readonly publicKey: string
}

/** Canonical bytes signed by K. Header names are lower-cased and sorted. */
export function canonicalAuthorizationRequest(input: Omit<AuthorizationEnvelope, 'signature' | 'publicKey'>): string {
  const headers = Object.entries(input.headers)
    .map(([k, v]) => [k.toLowerCase(), String(v).trim()] as const)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v}`)
    .join('\n')
  return [
    'hireling-authorization-v1',
    input.method.toUpperCase(),
    new URL(input.url).toString(),
    headers,
    createHash('sha256').update(input.body).digest('hex'),
    String(input.expiresAt),
    input.nonce,
  ].join('\n')
}

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}
export function fromBase64url(value: string): Buffer { return Buffer.from(value, 'base64url') }

/** DER signature; Privy/API adapters can translate to their required wire form. */
export function signAuthorizationRequest(privateKey: KeyObject, input: Omit<AuthorizationEnvelope, 'signature' | 'publicKey'>): string {
  return base64url(nodeSign('sha256', Buffer.from(canonicalAuthorizationRequest(input)), privateKey))
}

/** Privy's API authorization signature payload. RFC 8785's relevant subset is
 * deliberately assembled with fixed key order and no insignificant whitespace. */
export function privyAuthorizationPayload(input: {
  readonly method: string
  readonly url: string
  readonly body: string
  readonly headers: Readonly<Record<string, string>>
  readonly expiresAt: string
  readonly idempotencyKey?: string
}): string {
  const allowed = new Set(['privy-app-id', 'privy-request-expiry', 'privy-idempotency-key'])
  const headers = Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), String(v)] as const).filter(([k]) => allowed.has(k)))
  if (input.expiresAt !== '') headers['privy-request-expiry'] = input.expiresAt
  if (input.idempotencyKey !== undefined) headers['privy-idempotency-key'] = input.idempotencyKey
  return canonicalJson({ version: 1, method: input.method.toUpperCase(), url: input.url, body: JSON.parse(input.body) as unknown, headers })
}
export function signPrivyAuthorization(privateKey: KeyObject, input: Parameters<typeof privyAuthorizationPayload>[0]): string {
  return lowSDer(nodeSign('sha256', Buffer.from(privyAuthorizationPayload(input)), privateKey)).toString('base64')
}

/** JSON values only: reject non-finite/undefined rather than signing another value. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) return `{${Object.keys(value).toSorted().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  throw new Error('authorization payload must contain only JSON values')
}

const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
/** Provider requires low-S ECDSA in ASN.1 DER; Node supplies DER with either S. */
export function lowSDer(der: Uint8Array): Buffer {
  const b = Buffer.from(der)
  if (b[0] !== 0x30 || b[2] !== 2) throw new Error('invalid ECDSA DER')
  const rLength = b[3] ?? 0
  const r = b.subarray(4, 4 + rLength)
  if (b[4 + rLength] !== 2) throw new Error('invalid ECDSA DER')
  const s = BigInt(`0x${b.subarray(6 + rLength).toString('hex')}`)
  const normalized = s > P256_ORDER / 2n ? P256_ORDER - s : s
  let sBytes = Buffer.from(normalized.toString(16).padStart(64, '0'), 'hex')
  while (sBytes.length > 1 && sBytes[0] === 0 && ((sBytes[1] ?? 0) & 0x80) === 0) sBytes = sBytes.subarray(1)
  if (((sBytes[0] ?? 0) & 0x80) !== 0) sBytes = Buffer.concat([Buffer.from([0]), sBytes])
  return Buffer.concat([Buffer.from([0x30, 4 + r.length + sBytes.length, 2, r.length]), r, Buffer.from([2, sBytes.length]), sBytes])
}
export function verifyAuthorizationRequest(publicKey: KeyObject, input: AuthorizationEnvelope): boolean {
  return nodeVerify('sha256', Buffer.from(canonicalAuthorizationRequest(input)), publicKey, fromBase64url(input.signature))
}

export function publicKeyPem(key: KeyObject): string { return (key.type === 'public' ? key : createPublicKey(key)).export({ type: 'spki', format: 'pem' }).toString() }
export function publicKeyFingerprint(pem: string): string { return createHash('sha256').update(pem).digest('hex') }
export function privateKeyFromPem(pem: string): KeyObject { return createPrivateKey(pem) }
export function publicKeyFromPem(pem: string): KeyObject { return createPublicKey(pem) }

/** Explicit allow-list used by the gateway and companion. */
export const COMPANION_OPERATIONS = ['submit', 'dispute'] as const
export type CompanionOperation = (typeof COMPANION_OPERATIONS)[number]
export function assertCompanionOperation(operation: string): asserts operation is CompanionOperation {
  if (!(COMPANION_OPERATIONS as readonly string[]).includes(operation)) throw new Error(`companion operation refused: ${operation}`)
}
export function assertTestnetChain(chainId: number): void {
  if (chainId !== 10143) throw new Error(`companion only supports Monad testnet (10143), got ${chainId}`)
}

export interface PairingRequest { readonly code: string; readonly publicKey: string; readonly fingerprint: string; readonly clientVersion: string }
export interface PairingResponse { readonly pairingId: string; readonly agentId: string; readonly agentName: string; readonly walletAddress: string; readonly walletId?: string; readonly apiBase: string; readonly chainId: 10143; readonly expiresAt: number }
export interface HealthRequest { readonly launchId: string; readonly state: 'launched' | 'ready' | 'healthy' | 'stopped'; readonly pid?: number; readonly promptHash?: string; readonly version: string; readonly at: number; readonly signature: string }
