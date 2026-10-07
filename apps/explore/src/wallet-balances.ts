import { erc20Abi } from 'viem'
import { useSyncExternalStore } from 'react'
import { type Address, zeroAddress } from 'viem'
import { useBalance, useReadContracts } from 'wagmi'
import { useDelegations } from './delegation-query.ts'
import { rewardTokenList, subscribeTokens, tokenInfo, tokenRegistryVersion } from './format.ts'
import { sidequest } from './sidequest.ts'
import { usdPerUnit, usdValue, useSidePrice } from './usd.ts'
import { useTokenList } from './useTokens.ts'
import { chain, deployed, deployment } from './wallet.ts'

/** Configured and board-known wallet tokens, kept in address order and deduplicated without guessing by symbol. */
export function useWalletTokens(): `0x${string}`[] {
  useSyncExternalStore(subscribeTokens, tokenRegistryVersion, tokenRegistryVersion)
  const tokens = [...new Set([
    deployment.factory,
    ...deployment.rewardTokens,
    ...(deployment.market === null ? [] : [deployment.market.quote]),
    ...(deployment.x402 === null ? [] : [deployment.x402.usdc]),
    ...rewardTokenList().map(([address]) => address),
  ].filter((address) => address !== zeroAddress).map((address) => address.toLowerCase() as `0x${string}`))]
  useTokenList(tokens)
  return tokens
}

export type BalanceStatus = 'loading' | 'unavailable' | 'value'

export interface BalanceRow {
  /** The token, or null for the chain's native coin. */
  token: Address | null
  symbol: string
  decimals: number
  /** SIDE is put at risk as deposits and staked behind agents, the other tokens pay, the native coin pays gas. */
  role: 'bond' | 'pay' | 'gas'
  value: bigint | undefined
  status: BalanceStatus
  /** Dollars, when both the balance and a price are known (see `usd.ts`). */
  usd: number | undefined
}

export interface WalletBalances {
  /** SIDE, then the payment tokens in the deployment's order, then the native coin. */
  rows: BalanceRow[]
  /** SIDE staked behind agents: every position's value, unstaking included. Undefined until the index answers. */
  staked: { value: bigint | undefined; usd: number | undefined }
  /** Every priced amount, staked SIDE included; tokens without a price are left out. Undefined while none is known. */
  totalUsd: number | undefined
}

const status = (value: unknown, pending: boolean): BalanceStatus => (value !== undefined ? 'value' : pending ? 'loading' : 'unavailable')

/** A wallet's balances of every token Explore knows, and of SIDE staked behind agents, with dollar estimates. */
export function useWalletBalances(address: Address): WalletBalances {
  const native = useBalance({ address, chainId: chain.id, query: { refetchInterval: 10_000 } })
  const tokens = useWalletTokens()
  const reads = useReadContracts({
    contracts: tokens.map(
      (t) => ({ address: t, abi: erc20Abi, functionName: 'balanceOf', args: [address], chainId: chain.id }) as const,
    ),
    query: { refetchInterval: 10_000 },
  })
  const delegations = useDelegations(sidequest, address, deployed)
  const sidePrice = useSidePrice()
  const side = deployment.factory.toLowerCase()

  const tokenRows = tokens.map((t, i): BalanceRow => {
    const read = reads.data?.[i]
    const value = !reads.isError && read?.status === 'success' ? (read.result as bigint) : undefined
    const info = t === side ? { symbol: 'SIDE', decimals: 18 } : tokenInfo(t)
    return {
      token: t,
      symbol: info.symbol,
      decimals: info.decimals,
      role: t === side ? 'bond' : 'pay',
      value,
      status: status(value, reads.isPending),
      usd: usdValue(value, info.decimals, usdPerUnit(t, sidePrice)),
    }
  })
  const nativeValue = native.isError ? undefined : native.data?.value
  const rows: BalanceRow[] = [
    ...tokenRows.filter((r) => r.role === 'bond'),
    ...tokenRows.filter((r) => r.role === 'pay'),
    {
      token: null,
      symbol: chain.nativeCurrency.symbol,
      decimals: chain.nativeCurrency.decimals,
      role: 'gas',
      value: nativeValue,
      status: status(nativeValue, native.isPending),
      usd: undefined,
    },
  ]

  const stakedValue = delegations.data?.positions.reduce((sum, p) => sum + p.position.value, 0n)
  const staked = { value: stakedValue, usd: usdValue(stakedValue, 18, usdPerUnit(deployment.factory, sidePrice)) }
  const priced = [...rows, staked].flatMap((r) => (r.usd === undefined ? [] : [r.usd]))
  return { rows, staked, totalUsd: priced.length === 0 ? undefined : priced.reduce((a, b) => a + b, 0) }
}
