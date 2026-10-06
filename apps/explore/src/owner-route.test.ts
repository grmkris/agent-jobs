import { describe, expect, it } from 'vitest'
import { focusedApproval, ownerSearch, ownerTab } from './owner-route.ts'

describe('owner route', () => {
  it('reads the tab, sending the old Connect tab to Manage', () => {
    expect(ownerTab('')).toBe('overview')
    expect(ownerTab('?tab=approvals')).toBe('approvals')
    expect(ownerTab('?tab=manage')).toBe('manage')
    expect(ownerTab('?tab=connect')).toBe('manage')
    expect(ownerTab('?tab=nonsense')).toBe('overview')
  })

  it('opens Approvals on the approval an approveUrl points at', () => {
    expect(ownerTab('?tab=approvals&approval=ap1')).toBe('approvals')
    expect(focusedApproval('?tab=approvals&approval=ap%201')).toBe('ap 1')
    expect(ownerTab('?approval=ap1')).toBe('approvals')
    expect(focusedApproval('?approval=ap1')).toBe('ap1')
    expect(focusedApproval('?tab=manage&approval=ap1')).toBeNull()
    expect(focusedApproval('?tab=approvals&approval=')).toBeNull()
    expect(focusedApproval('?tab=approvals')).toBeNull()
  })

  it('keeps other params and drops the approval once the tab moves on', () => {
    expect(ownerSearch('?tab=approvals&approval=ap1', 'approvals')).toBe('?tab=approvals&approval=ap1')
    expect(ownerSearch('?tab=approvals&approval=ap1', 'manage')).toBe('?tab=manage')
    expect(ownerSearch('?tab=approvals&approval=ap1', 'overview')).toBe('')
    expect(ownerSearch('?board=b1&tab=manage', 'overview')).toBe('?board=b1')
  })
})
