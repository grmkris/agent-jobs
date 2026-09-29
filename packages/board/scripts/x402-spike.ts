/**
 * Spike for the x402 execution budget on Monad testnet, with a throwaway Privy server wallet standing in for a
 * creator's embedded wallet. Proves, on eip155:10143, against the real Privy policy engine:
 *   1. a policy with the x402 rule (eth_signTypedData_v4 on the chain's USDC, value ≤ per-payment cap) is accepted;
 *   2. the board key alone gets an EIP-3009 TransferWithAuthorization signed, and it recovers to the wallet;
 *   3. the policy refuses: over the per-payment cap, another verifying contract, and a USDC Permit;
 *   4. Monad's x402 facilitator accepts the payload's shape (with no USDC in the wallet it must say insufficient funds,
 *      not invalid signature).
 * Sends no transaction. A deliberate live run, never a task.
 *
 *   bun packages/board/scripts/x402-spike.ts   (from the repo root; reads .env.local itself)
 */
import { readFileSync } from 'node:fs'
import * as sdk from '@agent-jobs/sdk'
import { type Address, type Hex, getAddress, verifyTypedData } from 'viem'
import { TRANSFER_WITH_AUTHORIZATION, budgetPolicyBody } from '../src/budget-policy.ts'
import { PrivyApiError, generateAuthorizationKey, privyFetch, signedPrivyFetch } from '../src/privy.ts'

const local = readFileSync('.env.local', 'utf8').split('\n')
/** `.env.local` wins over the shell: ~/.config/secrets.env exports another project's PRIVY_APP_ID (found 28 Sep). */
const env = (n: string) => {
  const v = local.find((l) => l.startsWith(`${n}=`))?.slice(n.length + 1).trim() || process.env[n]
  if (v === undefined || v === '') throw new Error(`${n} is not set`)
  return v
}
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`)
let failures = 0
const check = (what: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  log(`${ok ? '✓' : '✗'} ${what}${detail === '' ? '' : `: ${detail}`}`)
}

const app = { appId: env('PRIVY_APP_ID'), appSecret: env('PRIVY_APP_SECRET') }
const boardKey = env('BUDGET_SIGNER_PRIVATE_KEY')
const boardQuorum = env('BUDGET_SIGNER_QUORUM_ID')
const d = sdk.deployment('monad-testnet')
const x402 = d.x402 as { usdc: Address; facilitator: string }
const perCall = 250_000n // 0.25 USDC
const expiresAt = Math.floor(Date.now() / 1000) + 3600

// 1. Owner quorum (stands in for the creator), the x402 policy, the wallet with the board as additional signer.
const owner = await generateAuthorizationKey()
const ownerQuorum = await privyFetch<{ id: string }>(app, {
  method: 'POST',
  path: '/key_quorums',
  body: { authorization_threshold: 1, display_name: 'agent-jobs-x402-spike-owner', public_keys: [owner.publicKey] },
})
const policy = await privyFetch<{ id: string }>(app, {
  method: 'POST',
  path: '/policies',
  body: budgetPolicyBody('0x0000000000000000000000000000000000000001', [{ kind: 'x402', taskId: 'x402-spike', chainId: 10143, token: x402.usdc, perCall, expiresAt }]),
}).catch((e: unknown) => {
  check('policy with the x402 rule accepted', false, e instanceof PrivyApiError ? `${e.status} ${e.body.slice(0, 300)}` : String(e))
  process.exit(1)
})
check('policy with the x402 rule accepted', typeof policy.id === 'string', policy.id)
const wallet = await privyFetch<{ id: string; address: Address }>(app, {
  method: 'POST',
  path: '/wallets',
  body: { chain_type: 'ethereum', owner_id: ownerQuorum.id, additional_signers: [{ signer_id: boardQuorum, override_policy_ids: [policy.id] }] },
})
log(`wallet ${wallet.id} ${wallet.address}`)

const domain = { name: 'USDC', version: '2', chainId: 10143, verifyingContract: x402.usdc }
const payTo = getAddress('0x000000000000000000000000000000000000dEaD')
const nonce = () => `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('')}` as Hex
const authorization = (value: bigint) => ({
  from: wallet.address,
  to: payTo,
  value: value.toString(),
  validAfter: '0',
  validBefore: String(Math.floor(Date.now() / 1000) + 300),
  nonce: nonce(),
})
const sign = (typed_data: Record<string, unknown>, idem: string) =>
  signedPrivyFetch<{ data: { signature: Hex } }>(app, boardKey, {
    method: 'POST',
    path: `/wallets/${wallet.id}/rpc`,
    body: { method: 'eth_signTypedData_v4', params: { typed_data } },
    idempotencyKey: idem,
  })
const tw = (msg: ReturnType<typeof authorization>, dom: Record<string, unknown> = domain) => ({
  domain: dom,
  types: { TransferWithAuthorization: [...TRANSFER_WITH_AUTHORIZATION] },
  primary_type: 'TransferWithAuthorization',
  message: msg,
})
const refused = async (what: string, p: Promise<unknown>) => {
  try {
    const r = await p
    check(`${what} refused`, false, `signed: ${JSON.stringify(r).slice(0, 120)}`)
  } catch (e) {
    check(`${what} refused`, e instanceof PrivyApiError, e instanceof PrivyApiError ? `${e.status} ${e.body.slice(0, 160)}` : String(e))
  }
}

// 2. In-cap authorization, board key only; it recovers to the wallet.
const t0 = Date.now()
const msg = authorization(100_000n)
const ok = await sign(tw(msg), `x402-ok-${t0}`)
const valid = await verifyTypedData({
  address: wallet.address,
  domain,
  types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION },
  primaryType: 'TransferWithAuthorization',
  message: { ...msg, value: BigInt(msg.value), validAfter: 0n, validBefore: BigInt(msg.validBefore) },
  signature: ok.data.signature,
})
check('board key gets an in-cap authorization signed, recovering to the wallet', valid, `${Date.now() - t0} ms`)

// 3. Refusals.
await refused('over the per-payment cap (0.3 of 0.25)', sign(tw(authorization(300_000n)), `x402-over-${t0}`))
await refused('another verifying contract', sign(tw(authorization(1n), { ...domain, verifyingContract: payTo }), `x402-contract-${t0}`))
await refused(
  'a USDC Permit (same domain, value within the cap)',
  sign(
    {
      domain,
      types: {
        Permit: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      primary_type: 'Permit',
      message: { owner: wallet.address, spender: payTo, value: '1', nonce: '0', deadline: String(expiresAt) },
    },
    `x402-permit-${t0}`,
  ),
)

// 4. The facilitator reads the payload: no USDC in the wallet, so a correct payload fails on funds, not the signature.
const accepted = { scheme: 'exact', network: 'eip155:10143', amount: msg.value, asset: x402.usdc, payTo, maxTimeoutSeconds: 300, extra: { name: 'USDC', version: '2' } }
const verify = await fetch(`${x402.facilitator}/verify`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    x402Version: 2,
    paymentPayload: { x402Version: 2, accepted, payload: { signature: ok.data.signature, authorization: msg } },
    paymentRequirements: accepted,
  }),
})
const verdict = (await verify.json().catch(() => ({}))) as { isValid?: boolean; invalidReason?: string }
log(`facilitator /verify ${verify.status}: ${JSON.stringify(verdict)}`)
check('the facilitator rejects it for funds, not for the signature', /insufficient|balance|fund/i.test(verdict.invalidReason ?? ''), verdict.invalidReason ?? '')

console.log(failures === 0 ? 'all checks passed' : `${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
