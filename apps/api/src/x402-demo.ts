/** A testnet proof resource. Only the configured facilitator is fetched, never a client-supplied URL. */
import type { Deployment } from '@sidequest/sdk'
import { canonicalAgentArgs, decodeX402Header, encodeX402Header, x402Object, type X402Payload, type X402Required } from '@sidequest/board'
import { isAddress } from 'viem'

export interface X402DemoReply { status: number; body: Record<string, unknown>; headers: Record<string, string> }
export interface X402DemoDeps { deployment: Deployment; fetch?: typeof fetch; now?: () => number }

export async function x402Demo(url: string, header: string | undefined, deps: X402DemoDeps): Promise<X402DemoReply> {
  const { deployment } = deps
  const config = deployment.x402
  const headers = { 'cache-control': 'no-store' }
  if (deployment.network !== 'monad-testnet' || deployment.chainId !== 10143 || config === null || deployment.sidequest === null) return { status: 404, body: { ok: false }, headers }
  const required: X402Required = {
    x402Version: 2, resource: { url, description: 'Sidequest x402 demo', mimeType: 'application/json' },
    accepts: [{ scheme: 'exact', network: `eip155:${deployment.chainId}`, amount: '10000', asset: config.usdc,
      payTo: deployment.sidequest.safe, maxTimeoutSeconds: 120, extra: { name: 'USDC', version: '2' } }],
  }
  const refuse = (errorReason?: string): X402DemoReply => ({
    status: 402, body: { ...required, ...(errorReason === undefined ? {} : { error: errorReason, errorReason }) },
    headers: { ...headers, 'PAYMENT-REQUIRED': encodeX402Header({ ...required, ...(errorReason === undefined ? {} : { error: errorReason }) }) },
  })
  if (header === undefined) return refuse()
  let payment: X402Payload
  try {
    const p = x402Object(decodeX402Header(header))
    const payload = x402Object(p.payload)
    const a = x402Object(payload.authorization)
    const now = (deps.now ?? (() => Math.floor(Date.now() / 1000)))()
    if (p.x402Version !== 2 || canonicalAgentArgs(p.resource) !== canonicalAgentArgs(required.resource)
      || canonicalAgentArgs(p.accepted) !== canonicalAgentArgs(required.accepts[0])
      || typeof payload.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(payload.signature)
      || typeof a.from !== 'string' || !isAddress(a.from) || a.to !== required.accepts[0]!.payTo || a.value !== '10000'
      || typeof a.nonce !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(a.nonce)
      || typeof a.validAfter !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(a.validAfter)
      || typeof a.validBefore !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(a.validBefore)
      || BigInt(a.validAfter) >= BigInt(now) || BigInt(a.validBefore) <= BigInt(now) || BigInt(a.validBefore) > BigInt(now + 120)) return refuse('payment-mismatch')
    payment = p as unknown as X402Payload
  } catch { return refuse('payment-mismatch') }
  const post = async (path: string): Promise<Record<string, unknown>> => {
    const response = await (deps.fetch ?? fetch)(`${config.facilitator.replace(/\/$/, '')}/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(8000), redirect: 'error',
      body: JSON.stringify({ x402Version: 2, paymentPayload: payment, paymentRequirements: required.accepts[0] }),
    })
    if (!response.ok) throw new Error('Facilitator unavailable')
    return x402Object(await response.json())
  }
  try {
    const verified = await post('verify')
    if (verified.isValid !== true || typeof verified.payer !== 'string' || verified.payer.toLowerCase() !== payment.payload.authorization.from.toLowerCase()) return refuse('verification-failed')
  } catch { return refuse('verification-failed') }
  try {
    const settled = await post('settle')
    if (settled.success !== true || typeof settled.transaction !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(settled.transaction)
      || settled.network !== required.accepts[0]!.network || typeof settled.payer !== 'string'
      || settled.payer.toLowerCase() !== payment.payload.authorization.from.toLowerCase()) return refuse('settlement-failed')
    const settlement = { success: true, transaction: settled.transaction, network: settled.network, payer: settled.payer }
    return { status: 200, body: { ok: true, transaction: settled.transaction }, headers: { ...headers, 'PAYMENT-RESPONSE': encodeX402Header(settlement) } }
  } catch { return refuse('settlement-failed') }
}
