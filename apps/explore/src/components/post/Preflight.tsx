import * as sdk from '@agent-jobs/sdk'
import { zeroAddress } from 'viem'
import { useBalance, useReadContract } from 'wagmi'
import { amount, formatNumber, tokenInfo } from '../../format.ts'
import { chain, deployment, isMainnet } from '../../wallet.ts'
import { Group, ListRow, Section } from '../ui.tsx'
import { Mark } from './parts.tsx'

type Hex = `0x${string}`

/**
 * "Ready to publish", read live from the wallet: MON for gas, the reward (a hire or contest escrows it at publish),
 * and FACTORY for the creator bond, which Holding also requires the creator to hold (`minHoldToPublish`) before it
 * takes the bond. A quote request locks nothing yet, so its bond is what picking a quote will need. Advisory: a
 * shortfall is shown, not enforced, since the transaction says the same if it happens.
 */
export function Preflight({
  address,
  stack,
  token,
  reward,
  bond,
  later = false,
}: {
  address: Hex | undefined
  stack: string
  token?: string | undefined
  reward?: bigint | null | undefined
  bond: bigint | null
  later?: boolean
}) {
  const on = address !== undefined
  const who = address ?? zeroAddress
  const holding = deployment.stacks[stack as sdk.StackName]?.holding
  const q = { refetchInterval: 15_000 }
  const mon = useBalance({ address: who, chainId: chain.id, query: { ...q, enabled: on } })
  const factory = useReadContract({ address: deployment.factory, abi: sdk.factoryTokenAbi, functionName: 'balanceOf', args: [who], chainId: chain.id, query: { ...q, enabled: on } })
  const hold = useReadContract({ address: holding ?? zeroAddress, abi: sdk.jobHoldingAbi, functionName: 'minHoldToPublish', chainId: chain.id, query: { enabled: holding !== undefined, staleTime: 300_000 } })
  const held = useReadContract({
    address: (token ?? zeroAddress) as Hex,
    abi: sdk.factoryTokenAbi,
    functionName: 'balanceOf',
    args: [who],
    chainId: chain.id,
    query: { ...q, enabled: on && token !== undefined && token !== '' },
  })

  const note = isMainnet ? 'Read live from your wallet.' : 'Read live from your wallet. Testnet MON, FACTORY and reward tokens come from the faucets under Me → Wallet.'
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
  const minHold = (hold.data as bigint | undefined) ?? 0n
  const factoryHeld = factory.data as bigint | undefined
  const bondNeed = bond ?? 0n
  const factoryNeed = bondNeed > minHold ? bondNeed : minHold
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
            {monValue === 0n && <span className="block text-[0.8rem] text-warn">Add {chain.nativeCurrency.symbol} to pay for the transactions.</span>}
          </span>
          <span className="tabular text-label-2">{monValue === undefined ? '…' : `${formatNumber(monValue, 18)} ${chain.nativeCurrency.symbol}`}</span>
        </ListRow>
        {token !== undefined && reward !== undefined && (
          <ListRow inset>
            <Mark tone={reward === null || tokenHeld === undefined ? (reward === null ? 'none' : 'wait') : tokenHeld >= reward ? 'ok' : 'warn'} />
            <span className="min-w-0 flex-1">
              <span className="block">Reward · {reward === null ? `— ${sym}` : amount(reward.toString(), token)}</span>
              {reward !== null && tokenHeld !== undefined && tokenHeld < reward && (
                <span className="block text-[0.8rem] text-warn">You need {amount((reward - tokenHeld).toString(), token)} more.</span>
              )}
            </span>
            <span className="tabular text-right text-label-2">{tokenHeld === undefined ? '…' : `You hold ${formatNumber(tokenHeld, tokenInfo(token).decimals)}`}</span>
          </ListRow>
        )}
        <ListRow inset>
          <Mark tone={factoryHeld === undefined || hold.isLoading ? 'wait' : factoryHeld >= factoryNeed ? 'ok' : 'warn'} />
          <span className="min-w-0 flex-1">
            <span className="block">
              {prefix}
              {bondNeed > 0n ? `Your bond · ${formatNumber(bondNeed, 18)} FACTORY` : 'FACTORY to publish'}
            </span>
            {minHold > 0n && <span className="block text-[0.8rem] text-label-3">Publishing also needs {formatNumber(minHold, 18)} FACTORY held in your wallet.</span>}
            {factoryHeld !== undefined && factoryHeld < factoryNeed && <span className="block text-[0.8rem] text-warn">You need {formatNumber(factoryNeed - factoryHeld, 18)} FACTORY more.</span>}
          </span>
          <span className="tabular text-right text-label-2">{factoryHeld === undefined ? '…' : `You hold ${formatNumber(factoryHeld, 18)}`}</span>
        </ListRow>
      </Group>
    </Section>
  )
}
