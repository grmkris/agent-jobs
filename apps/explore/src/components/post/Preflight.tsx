import * as sdk from '@agent-jobs/sdk'
import { Link } from '@tanstack/react-router'
import { erc20Abi, zeroAddress } from 'viem'
import { useBalance, useReadContract } from 'wagmi'
import { amount, formatNumber, tokenInfo } from '../../format.ts'
import { hireling } from '../../hireling.ts'
import { useToken } from '../../useTokens.ts'
import { chain, isMainnet } from '../../wallet.ts'
import { Group, ListRow, Section } from '../ui.tsx'
import { Mark } from './parts.tsx'

type Hex = `0x${string}`

/**
 * "Ready to publish", read live from the wallet: MON for gas, the reward (a hire escrows it at publish), and the
 * creator bond, a reservation of stake: the check is the stake still free in the vault, with the way to stake more.
 * A quote request locks nothing yet, so its bond is what picking a quote will need. Advisory: a shortfall is shown,
 * not enforced, since the transaction says the same if it happens.
 */
export function Preflight({
  address,
  token,
  reward,
  bond,
  later = false,
}: {
  address: Hex | undefined
  token?: string | undefined
  reward?: bigint | null | undefined
  bond: bigint | null
  later?: boolean
}) {
  const on = address !== undefined
  const metadata = useToken(token)
  const who = address ?? zeroAddress
  const q = { refetchInterval: 15_000 }
  const mon = useBalance({ address: who, chainId: chain.id, query: { ...q, enabled: on } })
  const free = useReadContract({ address: hireling.vault, abi: sdk.stakeVaultAbi, functionName: 'availableOf', args: [who], chainId: chain.id, query: { ...q, enabled: on } })
  const held = useReadContract({
    address: (token ?? zeroAddress) as Hex,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [who],
    chainId: chain.id,
    query: { ...q, enabled: on && token !== undefined && token !== '' },
  })

  const note = isMainnet
    ? 'Read live from your wallet.'
    : 'Read live from your wallet. Testnet MON comes from faucet.monad.xyz; FACTORY is transferred by the ecosystem/coordinator, and mUSD/mEUR each have an on-chain faucet().'
  if (!on) {
    return (
      <Section title="Ready to publish" note={token === undefined ? 'Sign in, and this checks your wallet has the gas and the bond.' : 'Sign in, and this checks your wallet has the gas, the reward and the bond.'}>
        <Group>
          <ListRow>
            <Mark tone="none" />
            <span className="flex-1 text-label-2">Sign in to check your balances</span>
          </ListRow>
        </Group>
      </Section>
    )
  }

  const monValue = mon.data?.value
  const tokenHeld = held.data as bigint | undefined
  const sym = tokenInfo(token).symbol
  const prefix = later ? 'When you pick a quote · ' : ''

  return (
    <Section title="Ready to publish" note={note}>
      <Group>
        <ListRow inset>
          <Mark tone={monValue === undefined ? 'wait' : monValue > 0n ? 'ok' : 'warn'} />
          <span className="min-w-0 flex-1">
            <span className="block">Gas</span>
            {monValue === 0n && <span className="block text-ui text-warn">Add {chain.nativeCurrency.symbol} to pay for the transactions.</span>}
          </span>
          <span className="tabular text-label-2">{monValue === undefined ? '…' : `${formatNumber(monValue, 18)} ${chain.nativeCurrency.symbol}`}</span>
        </ListRow>
        {token !== undefined && reward !== undefined && (
          <ListRow inset>
            <Mark tone={reward === null || tokenHeld === undefined ? (reward === null ? 'none' : 'wait') : tokenHeld >= reward ? 'ok' : 'warn'} />
            <span className="min-w-0 flex-1">
              <span className="block">Reward · {reward === null ? `— ${sym}` : amount(reward.toString(), token)}</span>
              {reward !== null && tokenHeld !== undefined && tokenHeld < reward && (
                <span className="block text-ui text-warn">You need {amount((reward - tokenHeld).toString(), token)} more.</span>
              )}
            </span>
            <span className="tabular text-right text-label-2">{tokenHeld === undefined || typeof metadata === 'string' ? 'Token amount unavailable' : `You hold ${formatNumber(tokenHeld, metadata.decimals)} ${metadata.symbol}`}</span>
          </ListRow>
        )}
        <StakeRow prefix={prefix} need={bond ?? 0n} free={free.data} unavailable={free.isError} />
      </Group>
    </Section>
  )
}

/** The bond is reserved from stake, so what counts is the stake still free (not reserved, not unstaking). */
function StakeRow({ prefix, need, free, unavailable }: { prefix: string; need: bigint; free: bigint | undefined; unavailable: boolean }) {
  return (
    <ListRow inset>
      <Mark tone={free === undefined ? (unavailable ? 'bad' : 'wait') : free >= need ? 'ok' : 'warn'} />
      <span className="min-w-0 flex-1">
        <span className="block">
          {prefix}
          {need > 0n ? `Your bond · ${formatNumber(need, 18)} FACTORY from backing` : 'No bond from you'}
        </span>
        {free !== undefined && free < need && (
          <span className="block text-ui text-warn">
            Delegate {formatNumber(need - free, 18)} FACTORY more.{' '}
            <Link to="/backing" className="font-semibold text-tint">
              Back an agent
            </Link>
          </span>
        )}
        {unavailable && <span className="block text-ui text-warn">Available backing cannot be read right now.</span>}
      </span>
      <span className="tabular text-right text-label-2">{free === undefined ? '…' : `${formatNumber(free, 18)} free`}</span>
    </ListRow>
  )
}
