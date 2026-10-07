import { bondHorizonMessage, readUnstakeDelay } from '@sidequest/sdk'
import { useQuery } from '@tanstack/react-query'
import { stakeContext } from '../stake-context.ts'

const ctx = stakeContext()

function bondHorizonCopy(delay: number | undefined): string {
  return delay === undefined
    ? 'A bonded job must end within the vault’s unstake period, including delivery, review, dispute, arbitration and the expiry margin. The current limit is unavailable; the board checks it before approval.'
    : bondHorizonMessage(delay)
}

/** The deployed immutable delay is authoritative even while the next deployment's config differs. */
export function BondHorizonNotice({ bonded }: { bonded: boolean }) {
  const delay = useQuery({
    queryKey: ['bond-horizon', ctx.deployment.chainId, ctx.deployment.sidequest?.vault],
    queryFn: () => readUnstakeDelay(ctx),
    enabled: bonded,
    staleTime: Infinity,
  })
  if (!bonded) return null
  return <p className="text-sm leading-relaxed text-muted-foreground">{bondHorizonCopy(delay.data)}</p>
}
