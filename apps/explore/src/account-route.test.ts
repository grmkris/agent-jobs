import { describe, expect, it } from 'vitest'
import { accountSearch, accountTab } from './account-route.ts'

describe('account route', () => {
  it('reads the tab, Wallet otherwise', () => {
    expect(accountTab('')).toBe('wallet')
    expect(accountTab('?tab=backing')).toBe('backing')
    expect(accountTab('?tab=notifications')).toBe('notifications')
    expect(accountTab('?tab=settings')).toBe('settings')
    expect(accountTab('?tab=nonsense')).toBe('wallet')
  })

  it('opens the tab an existing section anchor points at, unless the search names one', () => {
    expect(accountTab('', '#backing')).toBe('backing')
    expect(accountTab('', '#wallet')).toBe('wallet')
    expect(accountTab('', '#notifications')).toBe('notifications')
    expect(accountTab('', '#elsewhere')).toBe('wallet')
    expect(accountTab('?tab=settings', '#backing')).toBe('settings')
  })

  it('keeps other params and leaves the default tab out of the URL', () => {
    expect(accountSearch('?resume=t1', 'backing')).toBe('?resume=t1&tab=backing')
    expect(accountSearch('?tab=backing&resume=t1', 'wallet')).toBe('?resume=t1')
    expect(accountSearch('', 'wallet')).toBe('')
    expect(accountSearch('?tab=settings', 'notifications')).toBe('?tab=notifications')
  })
})
