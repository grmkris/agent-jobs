import { type Address, zeroAddress } from 'viem'
import { formatNumber } from '../format.ts'
import { useOperatorBalances } from '../operator-balances.ts'
import { useToken } from '../useTokens.ts'
import { deployment } from '../wallet.ts'
import { TokenIcon } from './token/TokenIcon.tsx'
import { TokenAmount } from './token/TokenAmount.tsx'

export function OperatorBalances({
  operator,
  token = deployment.rewardTokens[0]!,
}: {
  operator: Address | undefined
  token?: string
}) {
  const balances = useOperatorBalances(operator, token)
  const meta = useToken(token)
  const rewardSymbol = typeof meta === 'object' ? meta.symbol : 'Job token'
  return (
    <div className="grid gap-2 text-sm" aria-label="Your operator wallet balances">
      <p className="text-muted-foreground">In your operator wallet</p>
      <dl className="flex flex-wrap gap-x-5 gap-y-2 tabular-nums">
        <div>
          <dt className="text-muted-foreground">SIDE</dt>
          <dd className="font-semibold">
            <TokenAmount
              value={balances.factory}
              token={deployment.factory}
              static
              text={balances.factory === undefined ? 'Unavailable' : undefined}
            />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{rewardSymbol}</dt>
          <dd className="font-semibold">
            <TokenAmount
              value={balances.reward}
              token={token}
              static
              text={balances.reward === undefined ? 'Unavailable' : undefined}
            />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">MON</dt>
          <dd className="inline-flex items-center gap-1.5 font-semibold">
            <TokenIcon token={zeroAddress} />
            {balances.native === undefined ? 'Unavailable' : formatNumber(balances.native, 18)}
          </dd>
        </div>
      </dl>
    </div>
  )
}
