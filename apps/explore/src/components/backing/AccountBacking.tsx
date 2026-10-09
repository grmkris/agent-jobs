/**
 * The parts of backing that only Account › Backing shows, beside `BackingManager`: the backing form and the agent
 * picker as sheets, the gas warning above the form, and bringing the confirm step into view once a sheet closes into it.
 * Presentation only; the transactions stay in `BackingManager`.
 */
import { Link } from '@tanstack/react-router'
import { type ReactNode, useEffect } from 'react'
import { type Address, formatEther, parseEther } from 'viem'
import type { BackableAgent } from '../../backing-agents.ts'
import { deployment } from '../../wallet.ts'
import { Sheet } from '../Sheet.tsx'
import { Alert, AlertDescription } from '../ui/alert.tsx'
import { Button } from '../ui/button.tsx'
import { AgentPicker } from './AgentPicker.tsx'

/** About one backing send at testnet gas prices, with room to spare: backing is not gas-sponsored. */
const BACKING_GAS = parseEther('0.03')

/** Backing is sent from the wallet itself, so it needs MON for gas; said before the form, not after a failed send. */
export function GasWarning({ mon }: { mon: bigint | undefined }) {
  if (mon === undefined || mon >= BACKING_GAS) return null
  return (
    <Alert>
      <AlertDescription>
        Backing is sent from your wallet, which pays the gas in MON; Sidequest does not sponsor it. Your wallet holds{' '}
        {Number(formatEther(mon)).toLocaleString(undefined, { maximumFractionDigits: 4 })} MON and a backing costs about
        0.02.{' '}
        {deployment.testnetFaucet !== null ? (
          <Link to="/account" className="underline underline-offset-2">
            Get test tokens
          </Link>
        ) : (
          'Add MON to your wallet first.'
        )}
      </AlertDescription>
    </Alert>
  )
}

export function BackingSheets({
  open,
  onClose,
  mode,
  own,
  name,
  form,
  busy,
  agents,
  onPick,
}: {
  open: 'form' | 'pick' | null
  onClose: () => void
  mode: 'add' | 'leave'
  /** The form is for the signed-in wallet's own account. */
  own: boolean
  /** The backed account's name, for the form's title. */
  name: string
  form: ReactNode
  busy: boolean
  agents: readonly BackableAgent[]
  onPick: (wallet: Address) => void
}) {
  return (
    <>
      <Sheet
        open={open === 'form'}
        onClose={onClose}
        title={mode === 'leave' ? `Leave ${name}` : own ? 'Back your wallet' : `Back ${name}`}
        walletPrompt={busy}
      >
        {form}
      </Sheet>
      <Sheet open={open === 'pick'} onClose={onClose} title="Back an agent">
        <AgentPicker agents={agents} onPick={onPick} />
      </Sheet>
    </>
  )
}

/** Scroll the confirm step (`id`) into view when an operation is saved or restored, honouring reduced motion. */
export function useReveal(id: string, key: string | undefined) {
  useEffect(() => {
    if (key === undefined) return
    document.getElementById(id)?.scrollIntoView({
      block: 'start',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    })
  }, [id, key])
}

/** The positions' chain reads failed: say what that does and does not mean, and offer a retry. */
export function PositionsUnavailable({ lastKnown, onRetry }: { lastKnown: boolean; onRetry: () => void }) {
  return (
    <output className="grid gap-2 rounded-xl bg-warning/14 p-4 text-sm text-warning-text">
      <p>
        {lastKnown
          ? 'Showing last-known positions. Actions are paused until chain facts refresh.'
          : 'Your positions could not be read. This does not mean they are gone.'}
      </p>
      <Button variant="secondary" onClick={onRetry}>
        Retry
      </Button>
    </output>
  )
}
