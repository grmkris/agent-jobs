/**
 * The testnet MON drip (ADR-0008, D6): a board with `drip` on gives each address that signs in through it a small
 * amount of MON from the relay, once. Players of a game have no MON; without it nothing they sign can be sent. The
 * row is reserved before the transfer (R114-07); a reserved row without a hash is reconciled by the recipient's
 * balance before anything is resent. Never on mainnet.
 */
import { errorDiagnostics } from '@agent-jobs/board'
import * as sdk from '@agent-jobs/sdk'
import type { AsyncSql } from '@agent-jobs/indexer'
import { type Address, type Hex, formatEther, parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { dripFinish, dripReserve, dripState } from './registry.ts'

export const DRIP_MON = '0.05'
/** Below this the relay keeps what it has for rulings and evidence. */
export const RELAY_FLOOR_MON = '0.2'

export interface DripDeps {
  readonly sql: AsyncSql
  readonly network: sdk.Network
  readonly rpcUrl: string
  readonly relayKey: string
  readonly now: () => number
}

export type DripOutcome = { status: 'sent'; txHash: Hex } | { status: 'skipped' | 'failed' | 'already' | 'unavailable'; reason: string }

export async function dripOnce(deps: DripDeps, input: { boardId: string; address: Address }): Promise<DripOutcome> {
  if (deps.network !== 'monad-testnet') return { status: 'unavailable', reason: 'drips are testnet only' }
  if (!/^0x[0-9a-fA-F]{64}$/.test(deps.relayKey) || deps.rpcUrl === '') return { status: 'unavailable', reason: 'no relay configured' }
  const existing = await dripState(deps.sql, input.boardId, input.address)
  if (existing !== undefined && existing.status !== 'reserved' && existing.status !== 'failed') return { status: 'already', reason: existing.status }
  const ctx = sdk.context(deps.network, 'main', deps.rpcUrl)
  const relay = privateKeyToAccount(deps.relayKey as Hex)
  // A reservation without a hash is either in flight or lost: the recipient's balance decides, never a resend on faith.
  if (existing?.status === 'reserved') {
    const has = await ctx.publicClient.getBalance({ address: input.address })
    if (has >= parseEther(DRIP_MON)) {
      await dripFinish(deps.sql, input.boardId, input.address, 'sent', null)
      return { status: 'already', reason: 'funded' }
    }
    return { status: 'skipped', reason: 'a drip is already in flight' }
  }
  const token = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('')
  if (existing?.status === 'failed') await dripFinish(deps.sql, input.boardId, input.address, 'failed', null)
  const own = existing?.status === 'failed' ? true : await dripReserve(deps.sql, input.boardId, input.address, token, deps.now())
  if (!own) return { status: 'skipped', reason: 'another sign-in reserved it' }
  try {
    const [balance, relayBalance] = await Promise.all([ctx.publicClient.getBalance({ address: input.address }), ctx.publicClient.getBalance({ address: relay.address })])
    if (balance >= parseEther(DRIP_MON)) {
      await dripFinish(deps.sql, input.boardId, input.address, 'skipped', null)
      return { status: 'skipped', reason: `already holds ${formatEther(balance)} MON` }
    }
    if (relayBalance < parseEther(RELAY_FLOOR_MON)) {
      await dripFinish(deps.sql, input.boardId, input.address, 'skipped', null)
      return { status: 'skipped', reason: 'the relay is low on MON' }
    }
    const wallet = sdk.wallet(deps.network, relay, deps.rpcUrl)
    const txHash = await wallet.sendTransaction({ to: input.address, value: parseEther(DRIP_MON) })
    await dripFinish(deps.sql, input.boardId, input.address, 'sent', txHash)
    return { status: 'sent', txHash }
  } catch (e) {
    await dripFinish(deps.sql, input.boardId, input.address, 'failed', null)
    console.error(JSON.stringify({ event: 'drip-failed', ...errorDiagnostics(e) }))
    return { status: 'failed', reason: 'the faucet send failed; try again later' }
  }
}
