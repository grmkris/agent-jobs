import { Button } from './ui/button.tsx'
import { Input } from './ui/input.tsx'
import { Alert, AlertDescription } from './ui/alert.tsx'
import { Address as AddressText, Section, Segmented } from './kit.tsx'
import type { Address } from 'viem'
import { duration } from '../duration.ts'
import { factoryAmount } from '../stake.ts'

import { factoryValue } from './DelegationPositions.tsx'

export function DelegationForm({
  account,
  owner,
  mode,
  text,
  wallet,
  active,
  cooldown,
  disabled,
  busy,
  error,
  onMode,
  onText,
  onSubmit,
}: {
  account: Address
  owner: Address
  mode: 'add' | 'leave'
  text: string
  wallet: bigint | undefined
  active: bigint | undefined
  cooldown: number | undefined
  disabled: boolean
  busy: boolean
  error: string | null
  onMode: (mode: 'add' | 'leave') => void
  onText: (text: string) => void
  onSubmit: () => void
}) {
  const value = factoryAmount(text)
  const maximum = mode === 'add' ? wallet : active
  const invalid = text.trim() !== '' && value === null
  const tooMuch = value !== null && maximum !== undefined && value > maximum
  return (
    <Section title={mode === 'add' ? account.toLowerCase() === owner.toLowerCase() ? 'Back my wallet' : 'Back this agent' : 'Leave this position'}>
      <form
        className="grid gap-3 rounded-xl bg-card p-4"
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit()
        }}
      >
        <div className="grid gap-1 text-sm text-muted-foreground">
          <span>
            Backing wallet <AddressText value={account} />
          </span>
          <span>
            Your position belongs to <AddressText value={owner} />. Only you can leave and withdraw it.
          </span>
        </div>
        <Segmented
          label="Add or leave"
          value={mode}
          onChange={onMode}
          options={[
            ['add', 'Add backing'],
            ['leave', 'Leave'],
          ]}
        />
        <label className="grid gap-1.5 text-sm">
          <span>Amount of SIDE</span>
          <span className="flex gap-2">
            <Input
              id="stake-amount"
              inputMode="decimal"
              autoComplete="off"
              value={text}
              placeholder="0"
              onChange={(event) => onText(event.target.value)}
              className="min-w-0 flex-1 tabular-nums"
            />
            <Button
              variant="secondary"
              disabled={disabled || maximum === undefined}
              onClick={() => maximum !== undefined && onText(exactFactory(maximum))}
            >
              Max
            </Button>
          </span>
        </label>
        <p className="text-sm text-muted-foreground">
          {mode === 'add'
            ? 'Review the exact amount, then confirm the backing in your wallet. Your wallet pays the gas in MON.'
            : `Leaving starts ${cooldown === undefined ? 'the vault cooldown' : `a ${duration(cooldown)} cooldown`} for all your queued shares, including any already leaving. Deposits at risk do not prevent requesting to leave; they may delay withdrawal.`}
        </p>
        {invalid && (
          <Alert variant="destructive">
            <AlertDescription>Enter a positive SIDE amount with up to 18 decimal places.</AlertDescription>
          </Alert>
        )}
        {tooMuch && (
          <Alert variant="destructive">
            <AlertDescription>
              {mode === 'add' ? 'That is more SIDE than your wallet holds.' : 'That is more than your active position.'}
            </AlertDescription>
          </Alert>
        )}
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Button type="submit" size="lg" busy={busy} disabled={disabled || maximum === undefined || value === null || tooMuch}>
          {mode === 'add' ? `Back with ${value === null ? 'SIDE' : factoryValue(value)}` : value === null ? 'Leave' : `Leave ${factoryValue(value)}`}
        </Button>
      </form>
    </Section>
  )
}

export function exactFactory(value: bigint): string {
  const digits = value.toString().padStart(19, '0')
  const fraction = digits.slice(-18).replace(/0+$/, '')
  return `${digits.slice(0, -18)}${fraction === '' ? '' : `.${fraction}`}`
}
