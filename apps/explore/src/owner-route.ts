/**
 * Where an operator's link lands on their agent's page: the tab (`?tab=`, Overview otherwise; the old Connect tab now
 * lives in Manage) and the approval to bring into view (`&approval=`, the link in an agent's approveUrl, its inbox
 * event and the operator's Telegram notice).
 */
const OWNER_TABS = ['overview', 'approvals', 'manage'] as const
export type OwnerTab = (typeof OWNER_TABS)[number]

export function ownerTab(search: string): OwnerTab {
  const params = new URLSearchParams(search)
  const tab = params.get('tab')
  if (tab === 'connect') return 'manage'
  if (tab === null && params.has('approval')) return 'approvals'
  return OWNER_TABS.find((t) => t === tab) ?? 'overview'
}

/** The approval a link points at, or null; only on the Approvals tab. */
export function focusedApproval(search: string): string | null {
  if (ownerTab(search) !== 'approvals') return null
  const id = new URLSearchParams(search).get('approval')
  return id === null || id === '' ? null : id
}

/** The page's query once the tab changes: Overview drops `tab`, and leaving Approvals drops `approval`. */
export function ownerSearch(search: string, tab: OwnerTab): string {
  const params = new URLSearchParams(search)
  if (tab === 'overview') params.delete('tab')
  else params.set('tab', tab)
  if (tab !== 'approvals') params.delete('approval')
  const s = params.toString()
  return s === '' ? '' : `?${s}`
}

/** The element id of an approval on the Approvals tab, waiting card or past row alike. */
export const approvalAnchor = (id: string) => `approval-${id}`
