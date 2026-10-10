import type { Address } from 'viem'
import { useDelegations } from '../../delegation-query.ts'
import { useManagedAgents } from '../../managed.ts'
import type { OnboardingFacts } from '../../onboarding.ts'
import { sidequest } from '../../sidequest.ts'
import { useWalletBalances } from '../../wallet-balances.ts'
import { deployed } from '../../wallet.ts'

/**
 * What the chain and the board say about a signed-in operator's setup: whether the wallet holds anything, whether
 * they have an agent with its Agent ID, and whether they back an agent (a position in a wallet other than their own).
 */
export function useOnboardingFacts(address: Address): OnboardingFacts {
  const { rows } = useWalletBalances(address)
  const agents = useManagedAgents()
  const positions = useDelegations(sidequest, address, deployed)
  const owner = address.toLowerCase()
  const backed =
    positions.data === undefined
      ? null
      : positions.data.positions.some(
          ({ position }) => position.activeShares > 0n && position.account.toLowerCase() !== owner,
        )
  const holds = rows.some((r) => (r.value ?? 0n) > 0n)
  const reading = rows.some((r) => r.status === 'loading')
  return {
    funded: holds || backed === true ? true : reading ? null : false,
    hasAgent: agents.data === undefined ? null : agents.data.agents.some((a) => a.agent_id !== null),
    backed,
  }
}
