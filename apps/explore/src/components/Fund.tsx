import * as sdk from '@agent-jobs/sdk'
import { useState } from 'react'
import { formatEther, formatUnits } from 'viem'
import { useBalance, useReadContracts } from 'wagmi'
import { formatNumber, tokenInfo } from '../format.ts'
import { chain, deployment, isMainnet } from '../wallet.ts'
import { Address, Button, CopyButton, Group, ListRow, Section } from './ui.tsx'

/**
 * The signed-in Privy wallet's balances and how to fund it: people send MON (gas) and the reward/bond tokens to this
 * address from any wallet they already have. The site never connects that other wallet.
 */
export function FundButton({ address }: { address: `0x${string}` }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <Button variant="outline" onClick={() => setOpen((o) => !o)}>Fund</Button>
      {open && <FundPanel address={address} onClose={() => setOpen(false)} />}
    </div>
  )
}

function FundPanel({ address, onClose }: { address: `0x${string}`; onClose: () => void }) {
  const mon = useBalance({ address, chainId: chain.id, query: { refetchInterval: 10_000 } })
  const tokens = [deployment.factory, ...deployment.rewardTokens]
  const balances = useReadContracts({
    contracts: tokens.map((t) => ({ address: t, abi: sdk.factoryTokenAbi, functionName: 'balanceOf', args: [address], chainId: chain.id }) as const),
    query: { refetchInterval: 10_000 },
  })
  const [copied, setCopied] = useState(false)
  return (
    <div className="absolute right-0 z-20 mt-2 w-80 rounded-lg border border-sep bg-surface p-4 text-sm shadow-lg">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium">Your wallet</span>
        <button type="button" className="text-label-3 hover:text-label" onClick={onClose}>✕</button>
      </div>
      <p className="mb-2 text-xs text-label-2">
        Send {chain.nativeCurrency.symbol} for gas and the tokens you publish or bond with to this address on {chain.name}, from any wallet you
        already have.
      </p>
      <div className="mb-3 flex items-center gap-2">
        <code className="break-all rounded bg-fill px-2 py-1 text-xs">{address}</code>
        <Button variant="outline" onClick={async () => { await navigator.clipboard.writeText(address); setCopied(true) }}>{copied ? 'Copied' : 'Copy'}</Button>
      </div>
      <ul className="mb-3 space-y-1">
        <li className="flex justify-between"><span>{chain.nativeCurrency.symbol}</span><span>{mon.data === undefined ? '…' : Number(formatEther(mon.data.value)).toFixed(4)}</span></li>
        {tokens.map((t, i) => {
          const v = balances.data?.[i]?.result as bigint | undefined
          const info = t === deployment.factory ? { symbol: 'FACTORY', decimals: 18 } : tokenInfo(t)
          return <li key={t} className="flex justify-between"><span>{info.symbol}</span><span>{v === undefined ? '…' : formatUnits(v, info.decimals)}</span></li>
        })}
      </ul>
      {!isMainnet && (
        <p className="text-xs text-label-2">
          Testnet: MON for gas from <a className="underline" href="https://faucet.monad.xyz" target="_blank" rel="noreferrer">faucet.monad.xyz</a>;
          FACTORY v2 is transferred to your copied wallet address by the ecosystem/coordinator; mUSD and mEUR each have an on-chain <code>faucet()</code>.
        </p>
      )}
      <p className="mt-2 text-xs text-label-3">Explorer: <Address value={address} /></p>
    </div>
  )
}

/** The wallet as a section of Me: the full address to fund, live balances, and where testnet tokens come from. */
export function WalletCard({ address }: { address: `0x${string}` }) {
  const mon = useBalance({ address, chainId: chain.id, query: { refetchInterval: 10_000 } })
  const tokens = [deployment.factory, ...deployment.rewardTokens]
  const balances = useReadContracts({
    contracts: tokens.map((t) => ({ address: t, abi: sdk.factoryTokenAbi, functionName: 'balanceOf', args: [address], chainId: chain.id }) as const),
    query: { refetchInterval: 10_000 },
  })
  const rows: Array<[string, string, string | undefined]> = [
    [chain.nativeCurrency.symbol, 'Gas', mon.data === undefined ? undefined : formatNumber(mon.data.value, 18)],
    ...tokens.map((t, i): [string, string, string | undefined] => {
      const v = balances.data?.[i]?.result as bigint | undefined
      const info = t === deployment.factory ? { symbol: 'FACTORY', decimals: 18 } : tokenInfo(t)
      return [info.symbol, t === deployment.factory ? 'For bonds' : 'Reward token', v === undefined ? undefined : formatNumber(v, info.decimals)]
    }),
  ]
  return (
    <Section
      title="Wallet"
      note={
        isMainnet ? (
          <>Send {chain.nativeCurrency.symbol} for gas and the tokens you pay or bond with to this address, from any wallet you already have.</>
        ) : (
          <>
            Testnet: MON from{' '}
            <a className="text-tint" href="https://faucet.monad.xyz" target="_blank" rel="noreferrer">
              faucet.monad.xyz
            </a>
            ; FACTORY v2 is transferred to this address by the ecosystem/coordinator; mUSD and mEUR each have an on-chain faucet(). Test tokens have no value.
          </>
        )
      }
    >
      <Group>
        <ListRow>
          <span className="min-w-0 flex-1 font-mono text-ui break-all text-label-2">{address}</span>
          <CopyButton value={address} label="Copy address" />
        </ListRow>
        {rows.map(([symbol, what, value]) => (
          <ListRow key={symbol}>
            <span className="flex-1">
              {symbol}
              <span className="block text-xs text-label-3">{what}</span>
            </span>
            <span className="tabular text-label">{value ?? '…'}</span>
          </ListRow>
        ))}
      </Group>
    </Section>
  )
}
