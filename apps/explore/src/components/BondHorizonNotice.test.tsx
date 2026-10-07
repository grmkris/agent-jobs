import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { BondHorizonNotice } from './BondHorizonNotice.tsx'

const query = vi.hoisted(() => {
  const result: { data: number | undefined } = { data: undefined }
  return result
})
vi.mock('@tanstack/react-query', () => ({ useQuery: () => query }))

it.each([
  [259200, '3 days'],
  [1209600, '14 days'],
])('displays the actual vault delay %s', (delay, label) => {
  query.data = Number(delay)
  expect(renderToStaticMarkup(<BondHorizonNotice bonded />)).toContain(`within ${label} (the unstake period)`)
})

it('omits the limit for an unbonded offer', () => {
  query.data = 1209600
  expect(renderToStaticMarkup(<BondHorizonNotice bonded={false} />)).toBe('')
})

it('does not claim a duration when the deployed delay is unavailable', () => {
  query.data = undefined
  const html = renderToStaticMarkup(<BondHorizonNotice bonded />)
  expect(html).toContain('delivery, review, dispute, arbitration and the expiry margin')
  expect(html).not.toContain('14 days')
})
