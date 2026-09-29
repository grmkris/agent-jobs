/**
 * Phase 0 spike for the execution budget (ADR-0005) on Monad testnet, with a throwaway Privy server wallet standing in
 * for a creator's embedded wallet. Proves, on eip155:10143:
 *   1. a policy with the budget rule is accepted;
 *   2. a wallet owned by one key quorum can carry the board's quorum as an additional signer under that policy;
 *   3. the board key alone sends an in-cap mUSD transfer;
 *   4. the policy refuses: over the cap, `approve` instead of `transfer`, the wrong token, after the expiry;
 *   5. the app secret alone cannot send from an owned wallet;
 *   6. once the owner removes the signer, the board key is refused.
 * A deliberate live run (it sends testnet transactions), never a task.
 *
 *   bun packages/board/scripts/budget-spike.ts   (from the repo root; reads .env.local itself)
 */
import { readFileSync } from 'node:fs'
import * as sdk from '@agent-jobs/sdk'
import { type Address, type Hex, encodeFunctionData, erc20Abi, parseEther, parseUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { budgetPolicyBody } from '../src/budget-policy.ts'
import { PrivyApiError, authorizationSignature, generateAuthorizationKey, PRIVY_API, privyFetch, signedPrivyFetch } from '../src/privy.ts'

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
const rpc = env('MONAD_TESTNET_RPC_URL')
const d = sdk.deployment('monad-testnet')
const [mUSD, mEUR] = d.rewardTokens as [Address, Address]
const ctx = sdk.context('monad-testnet', 'main', rpc)
const funder = sdk.wallet('monad-testnet', privateKeyToAccount(env('TESTNET_CREATOR_PRIVATE_KEY') as Hex), rpc)
const sink = env('TESTNET_WORKER_ADDRESS') as Address

// 1. Owner quorum (stands in for the creator) and the policy.
const owner = await generateAuthorizationKey()
const ownerQuorum = await privyFetch<{ id: string }>(app, {
  method: 'POST',
  path: '/key_quorums',
  body: { authorization_threshold: 1, display_name: 'agent-jobs-spike-owner', public_keys: [owner.publicKey] },
})
log(`owner quorum ${ownerQuorum.id}`)
const decimals = await ctx.publicClient.readContract({ address: mUSD, abi: erc20Abi, functionName: 'decimals' })
const cap = parseUnits('1', decimals)
const expiresAt = Math.floor(Date.now() / 1000) + 3600
const grant = { taskId: 'spike', chainId: 10143, token: mUSD, cap, expiresAt }
const policy = await privyFetch<{ id: string; rules: unknown[] }>(app, {
  method: 'POST',
  path: '/policies',
  body: budgetPolicyBody('0x0000000000000000000000000000000000000001', [grant]),
})
check('policy with the budget rule accepted', typeof policy.id === 'string', policy.id)

// 2. The wallet: owned by the owner quorum, board quorum as additional signer under the policy.
const wallet = await privyFetch<{ id: string; address: Address; additional_signers?: unknown[] }>(app, {
  method: 'POST',
  path: '/wallets',
  body: { chain_type: 'ethereum', owner_id: ownerQuorum.id, additional_signers: [{ signer_id: boardQuorum, override_policy_ids: [policy.id] }] },
})
log(`wallet ${wallet.id} ${wallet.address} signers ${JSON.stringify(wallet.additional_signers)}`)
check('wallet carries the board signer', JSON.stringify(wallet.additional_signers ?? []).includes(boardQuorum))

// Fund: MON for gas and 3 mUSD + 1 mEUR from the testnet creator.
for (const tx of [
  () => funder.sendTransaction({ to: wallet.address, value: parseEther('0.2') }),
  () => funder.writeContract({ address: mUSD, abi: erc20Abi, functionName: 'transfer', args: [wallet.address, parseUnits('3', decimals)] }),
  () => funder.writeContract({ address: mEUR, abi: erc20Abi, functionName: 'transfer', args: [wallet.address, parseUnits('1', decimals)] }),
]) {
  await ctx.publicClient.waitForTransactionReceipt({ hash: await tx() })
}
log('funded')

const send = (to: Address, data: Hex, key: string | null, idem: string) => {
  const body = { method: 'eth_sendTransaction', caip2: 'eip155:10143', params: { transaction: { to, data, value: '0x0' } } }
  return key === null
    ? privyFetch<{ data: { hash: Hex } }>(app, { method: 'POST', path: `/wallets/${wallet.id}/rpc`, body, idempotencyKey: idem })
    : signedPrivyFetch<{ data: { hash: Hex } }>(app, key, { method: 'POST', path: `/wallets/${wallet.id}/rpc`, body, idempotencyKey: idem })
}
const transfer = (to: Address, amount: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] })
const refused = async (what: string, p: Promise<unknown>) => {
  try {
    const r = await p
    check(`${what} refused`, false, `sent: ${JSON.stringify(r)}`)
  } catch (e) {
    check(`${what} refused`, e instanceof PrivyApiError, e instanceof PrivyApiError ? `${e.status} ${e.body.slice(0, 160)}` : String(e))
  }
}

// 3. In-cap transfer, board key only.
const t0 = Date.now()
const ok = await send(mUSD, transfer(sink, parseUnits('0.5', decimals)), boardKey, `spike-ok-${t0}`)
const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: ok.data.hash })
check('board key sends an in-cap transfer', receipt.status === 'success', `${ok.data.hash} in ${Date.now() - t0} ms`)
// Idempotency: the same key returns the same hash, no second send.
const again = await send(mUSD, transfer(sink, parseUnits('0.5', decimals)), boardKey, `spike-ok-${t0}`).catch((e: Error) => ({ data: { hash: e.message as Hex } }))
check('same idempotency key does not send twice', again.data.hash === ok.data.hash, again.data.hash)

// 4. Refusals.
await refused('over the cap (1.5 of 1)', send(mUSD, transfer(sink, parseUnits('1.5', decimals)), boardKey, `spike-over-${t0}`))
await refused(
  'approve instead of transfer',
  send(mUSD, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [sink, 1n] }), boardKey, `spike-approve-${t0}`),
)
await refused('the wrong token (mEUR)', send(mEUR, transfer(sink, 1n), boardKey, `spike-token-${t0}`))

// 5. App secret alone on an owned wallet.
await refused('app secret alone', send(mUSD, transfer(sink, 1n), null, `spike-nosig-${t0}`))

// Expiry: move the rule's expiry into the past (the policy is app-owned, so the app secret edits it).
await privyFetch(app, { method: 'PATCH', path: `/policies/${policy.id}`, body: { rules: budgetPolicyBody(sink, [{ ...grant, expiresAt: expiresAt - 7200 }]).rules } })
await refused('after the expiry', send(mUSD, transfer(sink, 1n), boardKey, `spike-expired-${t0}`))
await privyFetch(app, { method: 'PATCH', path: `/policies/${policy.id}`, body: { rules: budgetPolicyBody(sink, [grant]).rules } })

// 6. Owner removes the signer; the board key is refused afterwards.
const patchBody = { additional_signers: [] }
const ownerSig = await authorizationSignature(owner.privateKey, { method: 'PATCH', url: `${PRIVY_API}/wallets/${wallet.id}`, body: patchBody, appId: app.appId })
const after = await privyFetch<{ additional_signers?: unknown[] }>(app, { method: 'PATCH', path: `/wallets/${wallet.id}`, body: patchBody, signatures: [ownerSig] })
check('owner removes the signer', (after.additional_signers ?? []).length === 0, JSON.stringify(after.additional_signers))
await refused('board key after removal', send(mUSD, transfer(sink, 1n), boardKey, `spike-removed-${t0}`))

console.log(failures === 0 ? 'all checks passed' : `${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
