import { Button } from './ui/button.tsx'
import { Item, ItemGroup, ItemContent, ItemDescription } from './ui/item.tsx'
import { Details, Address, CopyButton, Section, shortAddress, textLinkClass } from './kit.tsx'
import { TestnetFaucet } from './TestnetFaucet.tsx'
import * as sdk from '@sidequest/sdk'
import { useState } from 'react'
import { formatEther, formatUnits } from 'viem'
import { useBalance, useReadContracts } from 'wagmi'
import { formatNumber, tokenInfo } from '../format.ts'
import { TokenIcon } from './token/TokenIcon.tsx'
import { chain, deployment, isMainnet } from '../wallet.ts'

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
  const tokens = [deployment.factory, ...deployment.rewardTokens]
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
          <span>{chain.nativeCurrency.symbol}</span>
          <span>{mon.data === undefined ? '…' : Number(formatEther(mon.data.value)).toFixed(4)}</span>
        </li>
        {tokens.map((t, i) => {
          const v = balances.data?.[i]?.result as bigint | undefined
          const info = t === deployment.factory ? { symbol: 'SIDE', decimals: 18 } : tokenInfo(t)
          return (
            <li key={t} className="flex justify-between">
              <span>
                <TokenIcon token={t} className="mr-1.5" />
                {info.symbol}
              </span>
              <span className="tabular-nums">{v === undefined ? '…' : formatUnits(v, info.decimals)}</span>
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
  const tokens = [deployment.factory, ...deployment.rewardTokens]
  const balances = useReadContracts({
    contracts: tokens.map(
      (t) => ({ address: t, abi: sdk.factoryTokenAbi, functionName: 'balanceOf', args: [address], chainId: chain.id }) as const,
    ),
    query: { refetchInterval: 10_000 },
  })
  const rows: Array<[string, string, string | undefined]> = [
    [chain.nativeCurrency.symbol, 'Gas', mon.data === undefined ? undefined : formatNumber(mon.data.value, 18)],
    ...tokens.map((t, i): [string, string, string | undefined] => {
      const v = balances.data?.[i]?.result as bigint | undefined
      const info = t === deployment.factory ? { symbol: 'SIDE', decimals: 18 } : tokenInfo(t)
      return [
        info.symbol,
        t === deployment.factory ? 'For deposits at risk' : 'Paid in',
        v === undefined ? undefined : formatNumber(v, info.decimals),
      ]
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
      <div className="flex items-center gap-1">
        <span className="font-mono text-ui">{shortAddress(address)}</span>
        <CopyButton value={address} label="Copy address" />
      </div>
      <Details summary="Technical details">
        <p className="break-all font-mono text-ui">{address}</p>
        <Address value={address} />
      </Details>
      <ItemGroup>
        {rows.map(([symbol, what, value]) => (
          <Item key={symbol}>
            <ItemContent className="flex-1">
              {symbol}
              <ItemDescription className="block text-xs text-muted-foreground">{what}</ItemDescription>
            </ItemContent>
            <span className="tabular-nums text-foreground">{value ?? '…'}</span>
          </Item>
        ))}
      </ItemGroup>
      <TestnetFaucet address={address} />
    </Section>
  )
}
