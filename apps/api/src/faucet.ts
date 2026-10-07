/**
 * The testnet "Get test tokens" faucet: the `TestnetFaucet` contract gives an address SIDE and each payment token
 * (mUSD, mEUR) once a day. Anyone may send its `drip(to)`, so a wallet that already holds MON claims from its own
 * wallet; this tool only pays the gas for one that cannot (under `SELF_PAY_MON`), from the relay, and never below
 * `RELAY_RESERVE_MON` so gas sponsorship keeps its floor. The row is reserved before the send (R114-07) and keyed by
 * the faucet's on-chain state for the address, so a retry reconciles instead of sending twice; the contract's
 * per-address cooldown is the guard that cannot be bypassed. Never on mainnet.
 */
import { errorDiagnostics } from '@sidequest/board'
import * as sdk from '@sidequest/sdk'
import type { AsyncSql } from '@sidequest/indexer'
import { type Address, type Hex, decodeFunctionData, parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { type DripDeps, type DripOutcome, dripOnce } from './drip.ts'
import { dripFinish, dripReserve, dripState } from './registry.ts'

/** A wallet holding at least this much MON sends the claim itself. */
const SELF_PAY_MON = '0.02'
/** The relay pays for claims only above this; below it the MON is kept for sponsorship (its floor is 2 MON). */
const RELAY_RESERVE_MON = '2.5'
const DRIP_GAS = 300_000n

export type FaucetOutcome =
  | { status: 'sent'; txHash: Hex; mon?: DripOutcome }
  | { status: 'self'; transaction: { to: Address; data: Hex; chainId: number } }
  | { status: 'cooldown'; nextAt: number }
  | { status: 'pending' | 'unavailable'; reason: string }

/** The chain reads and the relay send the faucet needs; the default is the deployment's RPC and relay key. */
export interface FaucetChain {
  readonly chainId: number
  readonly call: (to: Address) => { to: Address; data: Hex }
  readonly lastDrip: (to: Address) => Promise<bigint>
  readonly nextDripAt: (to: Address) => Promise<number>
  readonly balance: (address: Address) => Promise<bigint>
  readonly relay: Address
  readonly relaySend: (tx: { to: Address; data: Hex }) => Promise<Hex>
  /** 'success' / 'reverted' once mined, undefined while unknown. */
  readonly receipt: (hash: Hex, wait: boolean) => Promise<'success' | 'reverted' | undefined>
  readonly dripMon: (address: Address) => Promise<DripOutcome>
}

export interface FaucetDeps {
  readonly sql: AsyncSql
  readonly network: sdk.Network
  readonly now: () => number
  readonly chain: FaucetChain | undefined
}

export function faucetChain(deps: DripDeps): FaucetChain | undefined {
  if (deps.network !== 'monad-testnet' || !/^0x[0-9a-fA-F]{64}$/.test(deps.relayKey) || deps.rpcUrl === '' || deps.relaySend === undefined) return undefined
  const ctx = sdk.context(deps.network, 'main', deps.rpcUrl)
  const faucet = ctx.deployment.testnetFaucet
  if (faucet === null) return undefined
  const relay = privateKeyToAccount(deps.relayKey as Hex)
  return {
    chainId: ctx.deployment.chainId,
    call: (to) => sdk.dripCall(ctx, to),
    lastDrip: (to) => ctx.publicClient.readContract({ address: faucet, abi: sdk.testnetFaucetAbi, functionName: 'lastDrip', args: [to] }),
    nextDripAt: (to) => sdk.nextDripAt(ctx, to),
    balance: (address) => ctx.publicClient.getBalance({ address }),
    relay: relay.address,
    relaySend: async (tx) => {
      const decoded = decodeFunctionData({ abi: sdk.testnetFaucetAbi, data: tx.data })
      if (decoded.functionName !== 'drip') throw new Error('Invalid faucet method')
      const last = await ctx.publicClient.readContract({ address: faucet, abi: sdk.testnetFaucetAbi, functionName: 'lastDrip', args: [decoded.args[0]] })
      return deps.relaySend!({ ...tx, gas: DRIP_GAS.toString(), key: `faucet:${tx.data}:${last}` })
    },
    receipt: async (hash, wait) => {
      const receipt = wait
        ? await ctx.publicClient.waitForTransactionReceipt({ hash, timeout: 20_000 }).catch(() => undefined)
        : await ctx.publicClient.getTransactionReceipt({ hash }).catch(() => undefined)
      return receipt?.status
    },
    dripMon: (address) => dripOnce(deps, { boardId: 'faucet', address }),
  }
}

export async function claimFaucet(deps: FaucetDeps, input: { address: Address }): Promise<FaucetOutcome> {
  if (deps.network !== 'monad-testnet') return { status: 'unavailable', reason: 'the faucet is testnet only' }
  const chain = deps.chain
  if (chain === undefined) return { status: 'unavailable', reason: 'no faucet is configured' }
  const key = `faucet:${await chain.lastDrip(input.address)}`
  const existing = await dripState(deps.sql, key, input.address)
  if (existing?.status === 'reserved') return { status: 'pending', reason: 'a claim for this address is already in flight' }
  if (existing?.status === 'sent' && existing.tx_hash !== null) {
    // The faucet still shows the old claim time: the send is unconfirmed, or it reverted and may be retried.
    const status = await chain.receipt(existing.tx_hash as Hex, false)
    if (status !== 'reverted') return { status: 'pending', reason: 'your claim is confirming' }
    await dripFinish(deps.sql, key, input.address, 'failed', null)
  }
  const nextAt = await chain.nextDripAt(input.address)
  if (nextAt !== 0) return { status: 'cooldown', nextAt }
  const call = chain.call(input.address)
  if (await chain.balance(input.address) >= parseEther(SELF_PAY_MON)) return { status: 'self', transaction: { ...call, chainId: chain.chainId } }
  if (await chain.balance(chain.relay) < parseEther(RELAY_RESERVE_MON)) {
    return { status: 'unavailable', reason: 'the faucet relay is low on MON; get MON from faucet.monad.xyz and claim from your wallet' }
  }
  const token = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('')
  const own = existing === undefined ? await dripReserve(deps.sql, key, input.address, token, deps.now()) : true
  if (!own) return { status: 'pending', reason: 'another request reserved this claim' }
  try {
    const txHash = await chain.relaySend(call)
    await dripFinish(deps.sql, key, input.address, 'sent', txHash)
    if (await chain.receipt(txHash, true) === 'reverted') return { status: 'unavailable', reason: 'the faucet claim reverted; try again later' }
    // A wallet with no MON cannot use what it was given; the once-per-address MON drip covers its first gas.
    return { status: 'sent', txHash, mon: await chain.dripMon(input.address) }
  } catch (e) {
    await dripFinish(deps.sql, key, input.address, 'failed', null)
    console.error(JSON.stringify({ event: 'faucet-failed', ...errorDiagnostics(e) }))
    return { status: 'unavailable', reason: 'the faucet send failed; try again later' }
  }
}
