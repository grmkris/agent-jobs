import { Button } from './ui/button.tsx'
import { Item, ItemGroup, ItemContent, ItemDescription } from './ui/item.tsx'
import { Details, Address, CopyButton, Section, textLinkClass } from './kit.tsx'
import { TestnetFaucet } from './TestnetFaucet.tsx'
import { BuyButtons } from './Buy.tsx'
import * as sdk from '@sidequest/sdk'
import { useState, useSyncExternalStore } from 'react'
import { zeroAddress } from 'viem'
import { useBalance, useReadContracts } from 'wagmi'
import { formatNumber, rewardTokenList, subscribeTokens, tokenInfo, tokenRegistryVersion } from '../format.ts'
import { useTokenList } from '../useTokens.ts'
import { TokenIcon } from './token/TokenIcon.tsx'
import { TokenAmount } from './token/TokenAmount.tsx'
import { chain, deployment, explorer, isMainnet } from '../wallet.ts'

/** Configured and board-known wallet tokens, kept in address order and deduplicated without guessing by symbol. */
function useWalletTokens() {
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

/**
 * The signed-in Privy wallet's balances and how to fund it: people send MON (gas) and the reward/bond tokens to this
 * address from any wallet they already have. The site never connects that other wallet.
 */
export function FundButton({ address }: { address: `0x${string}` }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <Button variant="outline" onClick={() => setOpen((o) => !o)}>
        Fund
      </Button>
      {open && <FundPanel address={address} onClose={() => setOpen(false)} />}
    </div>
  )
}

function FundPanel({ address, onClose }: { address: `0x${string}`; onClose: () => void }) {
  const mon = useBalance({ address, chainId: chain.id, query: { refetchInterval: 10_000 } })
  const tokens = useWalletTokens()
  const balances = useReadContracts({
    contracts: tokens.map(
      (t) => ({ address: t, abi: sdk.factoryTokenAbi, functionName: 'balanceOf', args: [address], chainId: chain.id }) as const,
    ),
    query: { refetchInterval: 10_000 },
  })
  const [copied, setCopied] = useState(false)
  return (
    <div className="absolute right-0 z-20 mt-2 w-80 rounded-lg border border-border bg-card p-4 text-sm shadow-lg">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium">Your wallet</span>
        <button type="button" className="text-muted-foreground hover:text-foreground" onClick={onClose}>
          ✕
        </button>
      </div>
      <p className="mb-2 text-xs text-muted-foreground">
        Send {chain.nativeCurrency.symbol} for gas and the tokens you pay with and SIDE for deposits at risk to this address on {chain.name}
        , from any wallet you already have.
      </p>
      <Details summary="Technical details" className="mb-3">
        <div className="flex items-center gap-2">
          <code className="break-all rounded bg-muted px-2 py-1 text-xs">{address}</code>
          <Button
            variant="outline"
            onClick={async () => {
              await navigator.clipboard.writeText(address)
              setCopied(true)
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Explorer: <Address value={address} />
        </p>
      </Details>
      <ul className="mb-3 flex flex-col gap-1">
        <li className="flex justify-between">
          <span className="inline-flex items-center gap-1.5">
            <TokenIcon token={zeroAddress} />
            {chain.nativeCurrency.symbol}
          </span>
          <span>{mon.isError || mon.data === undefined ? (mon.isPending ? '…' : 'Unavailable') : formatNumber(mon.data.value, 18)}</span>
        </li>
        {tokens.map((t, i) => {
          const read = balances.data?.[i]
          const v = !balances.isError && read?.status === 'success' ? read.result as bigint : undefined
          const info = t.toLowerCase() === deployment.factory.toLowerCase() ? { symbol: 'SIDE', decimals: 18 } : tokenInfo(t)
          return (
            <li key={t} className="flex justify-between">
              <span>{info.symbol}</span>
              <TokenAmount
                value={v}
                token={t}
                static
                text={v === undefined ? (balances.isPending ? '…' : 'Unavailable') : undefined}
                className="tabular-nums"
              />
            </li>
          )
        })}
      </ul>
      {!isMainnet && (
        <p className="text-xs text-muted-foreground">
          Testnet: MON for gas from{' '}
          <a className="underline" href="https://faucet.monad.xyz" target="_blank" rel="noreferrer">
            faucet.monad.xyz
          </a>
          ; SIDE, mUSD and mEUR from Get test tokens on your Sidequest Account page.
        </p>
      )}
    </div>
  )
}

/** The wallet as a section of Me: the full address to fund, live balances, and where testnet tokens come from. */
export function WalletCard({ address }: { address: `0x${string}` }) {
  const mon = useBalance({ address, chainId: chain.id, query: { refetchInterval: 10_000 } })
  const tokens = useWalletTokens()
  const balances = useReadContracts({
    contracts: tokens.map(
      (t) => ({ address: t, abi: sdk.factoryTokenAbi, functionName: 'balanceOf', args: [address], chainId: chain.id }) as const,
    ),
    query: { refetchInterval: 10_000 },
  })
  const rows: Array<{
    symbol: string
    what: string
    token: string | null
    value: bigint | undefined
    status: 'loading' | 'unavailable' | 'value'
    decimals: number
  }> = [
    {
      symbol: chain.nativeCurrency.symbol,
      what: 'Gas',
      token: null,
      value: mon.isError ? undefined : mon.data?.value,
      status: !mon.isError && mon.data !== undefined ? 'value' : mon.isPending ? 'loading' : 'unavailable',
      decimals: 18,
    },
    ...tokens.map((t, i): (typeof rows)[number] => {
      const read = balances.data?.[i]
      const v = !balances.isError && read?.status === 'success' ? read.result as bigint : undefined
      const info = t.toLowerCase() === deployment.factory.toLowerCase() ? { symbol: 'SIDE', decimals: 18 } : tokenInfo(t)
      return {
        symbol: info.symbol,
        what: t.toLowerCase() === deployment.factory.toLowerCase() ? 'For deposits at risk' : 'Paid in',
        token: t,
        value: v,
        status: v !== undefined ? 'value' : balances.isPending ? 'loading' : 'unavailable',
        decimals: info.decimals,
      }
    }),
  ]
  return (
    <Section
      title="Wallet"
      note={
        isMainnet ? (
          <>
            Send {chain.nativeCurrency.symbol} for gas and the tokens you pay with and SIDE for deposits at risk to this address, from any
            wallet you already have.
          </>
        ) : (
          <>
            Testnet: SIDE, mUSD and mEUR come from Get test tokens, MON from{' '}
            <a className={textLinkClass} href="https://faucet.monad.xyz" target="_blank" rel="noreferrer">
              faucet.monad.xyz
            </a>
            . Test tokens have no value.
          </>
        )
      }
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl bg-muted/60 px-3 py-2">
        <code className="min-w-0 flex-1 break-all font-mono text-ui">{address}</code>
        <CopyButton value={address} label="Copy address" />
        <a className={textLinkClass} href={explorer('address', address)} target="_blank" rel="noreferrer">
          Explorer
        </a>
      </div>
      <ItemGroup>
        {rows.map(({ symbol, what, token, value, status, decimals }) => (
          <Item key={token ?? symbol}>
            <ItemContent className="min-w-0 flex-1 [overflow-wrap:anywhere]">
              {symbol}
              <ItemDescription className="block text-xs text-muted-foreground">{what}</ItemDescription>
            </ItemContent>
            {token === null ? (
              <span className="inline-flex items-center gap-1.5 tabular-nums text-foreground">
                <TokenIcon token={zeroAddress} />
                {status === 'value' ? formatNumber(value!, decimals) : status === 'loading' ? '…' : 'Unavailable'}
              </span>
            ) : (
              <TokenAmount
                value={value}
                token={token}
                static
                text={status === 'value' ? undefined : status === 'loading' ? '…' : 'Unavailable'}
                className="min-w-0 max-w-[60%] text-right font-medium whitespace-normal [overflow-wrap:anywhere]"
              />
            )}
          </Item>
        ))}
      </ItemGroup>
      <TestnetFaucet address={address} />
      <BuyButtons address={address} />
    </Section>
  )
}
