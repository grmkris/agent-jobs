/** x402 v2 exact USDC payments, from the agent's own balance. */
import * as sdk from '@sidequest/sdk'
import { type Address, type Hex, isAddress } from 'viem'
import { AgentFailure } from './agent-failure.ts'

export const X402_PAYMENT_CAP = 5_000_000
export const X402_DAILY_CAP = 20_000_000
export const transferWithAuthorizationTypes = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  ],
} as const

export interface X402Resource { url: string; description?: string; mimeType?: string }
export interface X402Requirement {
  scheme: 'exact'; network: string; amount: string; asset: Address; payTo: Address; maxTimeoutSeconds: number
  extra: { name: 'USDC'; version: '2' }
}
export interface X402Required { x402Version: 2; error?: string; resource: X402Resource; accepts: X402Requirement[] }
export interface X402Authorization { from: Address; to: Address; value: string; validAfter: string; validBefore: string; nonce: Hex }
export interface X402Payload {
  x402Version: 2; resource: X402Resource; accepted: X402Requirement
  payload: { signature: Hex; authorization: X402Authorization }
}

export function x402Failure(message: string): AgentFailure {
  return new AgentFailure('invalid', message, 'x402-payment', 'new-key')
}

export function x402Object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw x402Failure('Malformed x402 object')
  return value as Record<string, unknown>
}

export function encodeX402Header(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
}

export function decodeX402Header(header: string): unknown {
  try {
    if (header.length > 65_536) throw new Error('Too large')
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(header), char => char.charCodeAt(0))))
  } catch { throw x402Failure('Malformed base64 x402 header') }
}

export function x402Deployment(deployment: sdk.Deployment): NonNullable<sdk.Deployment['x402']> {
  if (deployment.network !== 'monad-testnet' || deployment.chainId !== 10143 || deployment.x402 === null) {
    throw new AgentFailure('forbidden', 'x402 payments are available only on the configured testnet', 'outside-policy', 'none')
  }
  return deployment.x402
}

/** Keep the selected entry intact: it is the accepted requirement sent to the facilitator. */
export function chooseX402Payment(deployment: sdk.Deployment, input: unknown, resource?: unknown): { resource: X402Resource; accepted: X402Requirement } {
  const config = x402Deployment(deployment)
  const required = x402Object(typeof input === 'string' ? decodeX402Header(input) : input)
  const target = x402Object(required.resource)
  if (required.x402Version !== 2 || !Array.isArray(required.accepts)) throw x402Failure('Expected x402Version 2 and payment accepts')
  if (typeof target.url !== 'string' || target.url.length > 4096 || !/^https?:\/\//.test(target.url)
    || (target.description !== undefined && typeof target.description !== 'string') || (target.mimeType !== undefined && typeof target.mimeType !== 'string')) throw x402Failure('Invalid x402 resource')
  try {
    const url = new URL(target.url)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid scheme')
  } catch { throw x402Failure('Invalid x402 resource URL') }
  if (resource !== undefined && resource !== target.url) throw x402Failure('The requested resource differs from PAYMENT-REQUIRED')
  const accepted = required.accepts.find((entry: unknown) => {
    const e = typeof entry === 'object' && entry !== null ? entry as Record<string, unknown> : {}
    const extra = typeof e.extra === 'object' && e.extra !== null ? e.extra as Record<string, unknown> : {}
    return e.scheme === 'exact' && e.network === `eip155:${deployment.chainId}` && typeof e.asset === 'string'
      && e.asset.toLowerCase() === config.usdc.toLowerCase() && extra.name === 'USDC' && extra.version === '2'
  }) as X402Requirement | undefined
  if (accepted === undefined) throw x402Failure('No exact payment for this chain and configured USDC domain (USDC, version 2)')
  if (typeof accepted.amount !== 'string' || !/^[1-9][0-9]{0,77}$/.test(accepted.amount)) throw x402Failure('Payment amount must be positive atomic units')
  if (BigInt(accepted.amount) > BigInt(X402_PAYMENT_CAP)) throw new AgentFailure('forbidden', 'An x402 payment may spend at most 5 USDC', 'cap', 'after-operator')
  if (typeof accepted.payTo !== 'string' || !isAddress(accepted.payTo) || !Number.isSafeInteger(accepted.maxTimeoutSeconds) || accepted.maxTimeoutSeconds < 1) throw x402Failure('Invalid payment recipient or timeout')
  return { resource: target as unknown as X402Resource, accepted }
}

export function x402TypedData(deployment: sdk.Deployment, authorization: X402Authorization): string {
  const config = x402Deployment(deployment)
  return sdk.typedDataJson({ name: 'USDC', version: '2', chainId: deployment.chainId, verifyingContract: config.usdc }, transferWithAuthorizationTypes, 'TransferWithAuthorization', authorization)
}
