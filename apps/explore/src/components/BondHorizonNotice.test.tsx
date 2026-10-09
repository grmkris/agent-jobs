import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { stakeContext } from '../stake-context.ts'
import { BondHorizonNotice } from './BondHorizonNotice.tsx'

function noticeMarkup(bonded: boolean, delay: number | undefined, tone: 'rule' | 'fix'): string {
  const client = new QueryClient()
  const ctx = stakeContext()
  client.setQueryData(['bond-horizon', ctx.deployment.chainId, ctx.deployment.sidequest?.vault], delay)
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <BondHorizonNotice bonded={bonded} tone={tone} />
    </QueryClientProvider>,
  )
}

it.each([
  [259200, '3 days'],
  [1209600, '14 days'],
])('displays the actual vault delay %s', (delay, label) => {
  expect(noticeMarkup(true, delay, 'fix')).toContain(`within ${label} (the unstake period)`)
  expect(noticeMarkup(true, delay, 'rule')).toContain(`within ${label}, the backing unstake period`)
})

it('omits the limit for an unbonded offer', () => {
  expect(noticeMarkup(false, 1209600, 'fix')).toBe('')
})

it('does not claim a duration when the deployed delay is unavailable', () => {
  const copy = noticeMarkup(true, undefined, 'fix')
  expect(copy).toContain('delivery, review, dispute, arbitration and the expiry margin')
  expect(copy).not.toContain('14 days')
})

it('uses a visitor-facing rule without an imperative fix', () => {
  const copy = noticeMarkup(true, 259200, 'rule')
  expect(copy).toContain('Bonded jobs finish within 3 days, the backing unstake period.')
  expect(copy).not.toContain('Shorten the deadline')
})

it('keeps the imperative copy in actionable flows', () => {
  expect(noticeMarkup(true, 259200, 'fix')).toContain('Shorten the deadline or windows.')
})

it('omits the rule for an unbonded offer', () => {
  expect(noticeMarkup(false, 259200, 'rule')).toBe('')
})

it('uses a duration-free rule when the deployed delay is unavailable', () => {
  const copy = noticeMarkup(true, undefined, 'rule')
  expect(copy).toContain('Bonded jobs finish within the backing unstake period.')
  expect(copy).not.toContain('3 days')
  expect(copy).not.toContain('Shorten the deadline')
})

it.each([
  [86400, '1 day'],
  [3600, '3600 seconds'],
])('formats the viewer rule for delay %s', (delay, label) => {
  expect(noticeMarkup(true, delay, 'rule')).toContain(`within ${label}, the backing unstake period`)
})
