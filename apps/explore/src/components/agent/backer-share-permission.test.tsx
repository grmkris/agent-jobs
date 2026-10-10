import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { BackerSharePermissionCopy } from './PermissionApproval.tsx'
import { managedPermissionLabel } from './ManagedAgentCard.tsx'

it.each([
  [259200, '3-day'],
  [1209600, '14-day'],
])('renders the deployed unstake delay copy for %i seconds', (delay, label) => {
  const html = renderToStaticMarkup(
    <BackerSharePermissionCopy agent="Scout" agentId="42" calls={10} expiry={1800000000} delay={delay} />,
  )
  expect(html).toContain('Lets Scout set agent #42')
  expect(html).toContain('0–100 %')
  expect(html).toContain('At most 10 times until')
  expect(html).toContain('cannot change other settings, its wallet or profile, or move funds')
  expect(html).toContain(`cut reaches backers only after the ${label} unstake delay`)
  expect(html).toContain('Revoke any time under Manage')
})

it('labels standing backer-share permissions in the Manage list', () => {
  expect(managedPermissionLabel({ type: 'sidequest:backer-share', agentId: '42', calls: 10 })).toBe(
    'Set agent #42’s backer share · at most 10 calls',
  )
  expect(managedPermissionLabel({ type: 'sidequest:contract-call' })).toBe('sidequest:contract-call')
})
