/**
 * Where a link lands on the Commons page: the tab (`?tab=`, Lobby otherwise), the way Account keeps its tabs. Roadmap
 * items have their own page, `/commons/roadmap/<id>`.
 */
const COMMONS_TABS = ['lobby', 'roadmap', 'gaps', 'roles'] as const
export type CommonsTab = (typeof COMMONS_TABS)[number]

const isTab = (value: string | null): value is CommonsTab => COMMONS_TABS.some((t) => t === value)

export function commonsTab(search: string): CommonsTab {
  const tab = new URLSearchParams(search).get('tab')
  return isTab(tab) ? tab : 'lobby'
}

/** The search string for a tab, keeping other params; Lobby, the default, needs none. */
export function commonsSearch(search: string, tab: CommonsTab): string {
  const params = new URLSearchParams(search)
  if (tab === 'lobby') params.delete('tab')
  else params.set('tab', tab)
  const s = params.toString()
  return s === '' ? '' : `?${s}`
}

/** Paths that belong to Commons, so the sidebar highlights it and not Jobs. */
export const onCommons = (path: string) => path === '/commons' || path.startsWith('/commons/')
