import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { stakeContext } from '../stake-context.ts'
import { BondHorizonNotice } from './BondHorizonNotice.tsx'

function noticeMarkup(bonded: boolean, delay?: number): string {
  const client = new QueryClient()
  const ctx = stakeContext()
  client.setQueryData(['bond-horizon', ctx.deployment.chainId, ctx.deployment.sidequest?.vault], delay)
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <BondHorizonNotice bonded={bonded} />
    </QueryClientProvider>,
  )
}

it.each([
  [259200, '3 days'],
  [1209600, '14 days'],
])('displays the actual vault delay %s', (delay, label) => {
  expect(noticeMarkup(true, delay)).toContain(`within ${label} (the unstake period)`)
})

it('omits the limit for an unbonded offer', () => {
  expect(noticeMarkup(false, 1209600)).toBe('')
})

it('does not claim a duration when the deployed delay is unavailable', () => {
  const copy = noticeMarkup(true)
  expect(copy).toContain('delivery, review, dispute, arbitration and the expiry margin')
  expect(copy).not.toContain('14 days')
})
