import * as sdk from '@sidequest/sdk'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Check, Circle } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { type Address, zeroAddress } from 'viem'
import { usePublicClient } from 'wagmi'
import { waitForTransactionReceipt } from 'wagmi/actions'
import { Button, buttonVariants } from '../ui/button.tsx'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup } from '../ui/item.tsx'
import { Section } from '../kit.tsx'
import { useDelegatorUpgrade } from '../Privy.tsx'
import { useSponsorStatus } from '../../sponsor.ts'
import { useWalletBalances } from '../../wallet-balances.ts'
import { chain, deployment, isMainnet, wagmiConfig } from '../../wallet.ts'
import {
  readSkipped,
  setupOpen,
  setupSteps,
  writeSkipped,
  type SetupFacts,
  type SetupStep,
  type StepState,
} from '../../wallet-setup.ts'

const outline = buttonVariants({ size: 'sm', variant: 'outline' })

/** What the chain and the board say about each step, and the upgrade's own action (null for a non-embedded wallet). */
function useSetupFacts(address: Address): { facts: SetupFacts; upgrade: (() => Promise<void>) | null } {
  const upgrade = useDelegatorUpgrade(address)
  const client = usePublicClient({ chainId: chain.id })
  const delegation = useQuery({
    queryKey: ['delegation', address.toLowerCase()],
    queryFn: () => sdk.delegationOf(client!, address),
    enabled: client !== undefined && upgrade !== null,
  })
  const { rows } = useWalletBalances(address)
  const offered = deployment.relay.toLowerCase() !== zeroAddress
  const sponsor = useSponsorStatus(address, offered)
  const delegated =
    delegation.data === undefined
      ? null
      : delegation.data?.toLowerCase() === deployment.delegation.delegator.toLowerCase()
  const loading = rows.some((r) => r.status === 'loading')
  const sponsored = sponsor.data === undefined ? null : sponsor.data.status === 'live'
  return {
    facts: {
      upgraded: upgrade === null ? undefined : delegated,
      // Funded once it holds anything: gas, test tokens or a payment token.
      funded: rows.some((r) => (r.value ?? 0n) > 0n) ? true : loading ? null : false,
      sponsored: offered ? sponsored : undefined,
    },
    upgrade:
      upgrade === null
        ? null
        : async () => {
            const txHash = await upgrade()
            if (txHash !== null) await waitForTransactionReceipt(wagmiConfig, { hash: txHash, chainId: chain.id })
            await delegation.refetch()
          },
  }
}

const COPY: Record<SetupStep, { title: string; text: string }> = {
  upgrade: {
    title: 'Upgrade your wallet',
    text: 'One signature makes it a smart account, so Sidequest can batch a step into one transaction.',
  },
  fund: isMainnet
    ? { title: `Add ${chain.nativeCurrency.symbol} for gas`, text: 'Send it to your address from any wallet you have.' }
    : { title: 'Get test tokens', text: 'Free and worthless: they pay for practice jobs and their deposits.' },
  sponsor: {
    title: 'Turn on gas sponsorship',
    text: 'Sidequest pays the gas for your Sidequest transactions while the grant lasts.',
  },
}

const SETTLED: Partial<Record<StepState, string>> = { done: 'Done', skipped: 'Skipped' }

function SetupRow({
  step,
  state,
  action,
  onSkip,
}: {
  step: SetupStep
  state: StepState
  action: ReactNode
  onSkip: () => void
}) {
  return (
    <Item>
      {state === 'done' ? (
        <Check aria-label="Done" className="size-4 shrink-0 text-success-text" />
      ) : (
        <Circle aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      )}
      <ItemContent className="min-w-0 flex-1">
        {COPY[step].title}
        <ItemDescription className="block text-xs text-muted-foreground">
          {SETTLED[state] ?? COPY[step].text}
        </ItemDescription>
      </ItemContent>
      {state === 'todo' && (
        <ItemActions className="flex-wrap justify-end">
          {action}
          <Button size="sm" variant="ghost" onClick={onSkip}>
            Skip
          </Button>
        </ItemActions>
      )}
    </Item>
  )
}

/**
 * "Set up your wallet": upgrade it, fund it, turn on gas sponsorship. Each step is done from chain or board state or
 * skipped by the person, and the card leaves once nothing is left to do. Creating an agent needs only the upgrade.
 */
export function WalletSetup({ address }: { address: Address }) {
  const { facts, upgrade } = useSetupFacts(address)
  const [skipped, setSkipped] = useState(() => readSkipped(address))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const steps = setupSteps(facts, skipped)
  if (!setupOpen(steps)) return null
  async function runUpgrade() {
    setBusy(true)
    setError(null)
    try {
      await upgrade?.()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The upgrade did not go through')
    } finally {
      setBusy(false)
    }
  }
  const actions: Record<SetupStep, ReactNode> = {
    upgrade: (
      <Button size="sm" busy={busy} onClick={() => void runUpgrade()}>
        Upgrade
      </Button>
    ),
    // The wallet card below has the address, the faucet and the buy buttons; this only points there.
    fund: (
      <a href="#wallet" className={outline}>
        {isMainnet ? 'Show address' : 'Get tokens'}
      </a>
    ),
    sponsor: (
      <Link to="/sponsorship" className={outline}>
        Review
      </Link>
    ),
  }
  return (
    <Section title="Set up your wallet" note="Each step is optional; skip any you don't need.">
      <ItemGroup>
        {steps.map(({ step, state }) => (
          <SetupRow
            key={step}
            step={step}
            state={state}
            action={actions[step]}
            onSkip={() => {
              const next = new Set(skipped).add(step)
              writeSkipped(address, next)
              setSkipped(next)
            }}
          />
        ))}
      </ItemGroup>
      {error !== null && <p className="text-sm text-destructive-text">{error}</p>}
    </Section>
  )
}
