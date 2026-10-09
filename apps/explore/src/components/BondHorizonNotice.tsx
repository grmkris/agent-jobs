import { bondHorizonMessage, readUnstakeDelay } from '@sidequest/sdk'
import { useQuery } from '@tanstack/react-query'
import { stakeContext } from '../stake-context.ts'

const ctx = stakeContext()

function bondHorizonCopy(delay: number | undefined, tone: 'rule' | 'fix'): string {
  if (tone === 'fix')
    return delay === undefined
      ? 'A bonded job must end within the vault’s unstake period, including delivery, review, dispute, arbitration and the expiry margin. The current limit is unavailable; the board checks it before approval.'
      : bondHorizonMessage(delay)
  if (delay === undefined) return 'Bonded jobs finish within the backing unstake period.'
  const days = delay / 86400
  const label = Number.isInteger(days) ? `${days} day${days === 1 ? '' : 's'}` : `${delay} seconds`
  return `Bonded jobs finish within ${label}, the backing unstake period.`
}

/** The deployed immutable delay is authoritative even while the next deployment's config differs. */
export function BondHorizonNotice({ bonded, tone }: { bonded: boolean; tone: 'rule' | 'fix' }) {
  const delay = useQuery({
    queryKey: ['bond-horizon', ctx.deployment.chainId, ctx.deployment.sidequest?.vault],
    queryFn: () => readUnstakeDelay(ctx),
    enabled: bonded,
    staleTime: Infinity,
  })
  if (!bonded) return null
  const copy = bondHorizonCopy(delay.data, tone)
  return tone === 'rule' ? <span>{copy}</span> : <p className="text-sm leading-relaxed text-muted-foreground">{copy}</p>
}
