import type { Address } from 'viem'
import { formatNumber } from '../format.ts'
import { useOperatorBalances } from '../operator-balances.ts'
import { useToken } from '../useTokens.ts'
import { deployment } from '../wallet.ts'

const value = (balance: bigint | undefined, decimals: number) => (balance === undefined ? 'Unavailable' : formatNumber(balance, decimals))

export function OperatorBalances({ operator, token = deployment.rewardTokens[0]! }: { operator: Address | undefined; token?: string }) {
  const balances = useOperatorBalances(operator, token)
  const meta = useToken(token)
  const rewardSymbol = typeof meta === 'object' ? meta.symbol : 'Job token'
  return (
    <div className="grid gap-2 text-sm" aria-label="Your operator wallet balances">
      <p className="text-muted-foreground">In your operator wallet</p>
      <dl className="flex flex-wrap gap-x-5 gap-y-2 tabular-nums">
        <div>
          <dt className="text-muted-foreground">SIDE</dt>
          <dd className="font-semibold">{value(balances.factory, 18)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{rewardSymbol}</dt>
          <dd className="font-semibold">{value(balances.reward, typeof meta === 'object' ? meta.decimals : 18)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">MON</dt>
          <dd className="font-semibold">{value(balances.native, 18)}</dd>
        </div>
      </dl>
    </div>
  )
}
