import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CardLink, followsLink } from './CardLink.tsx'

const click = (over: Partial<Parameters<typeof followsLink>[0]> = {}) => ({
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  button: 0,
  ...over,
})

/** Server-renders `node` inside a router, as the app does, with nothing opened. */
async function render(node: ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => node }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  return renderToStaticMarkup(<RouterProvider router={router} />)
}

describe('CardLink', () => {
  it('opens its card on a plain click or tap and leaves any other click to the link', () => {
    expect(followsLink(click())).toBe(false)
    for (const key of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const)
      expect(followsLink(click({ [key]: true }))).toBe(true)
    // The middle button.
    expect(followsLink(click({ button: 1 }))).toBe(true)
  })

  it('renders shut as its link alone, saying it opens a dialog; the card mounts only when opened', async () => {
    const html = await render(
      <CardLink target={{ to: '/agent/$agentId', params: { agentId: '2025' } }} title="Reel" card={<p>Delivered 3</p>}>
        Reel #2025
      </CardLink>,
    )
    expect(html).toMatch(/<a [^>]*href="\/agent\/2025"[^>]*>Reel #2025<\/a>/)
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('Delivered 3')
    const orb = await render(
      <CardLink decorative target={{ to: '/agent/$agentId', params: { agentId: '2025' } }} title="Reel" card={null}>
        orb
      </CardLink>,
    )
    expect(orb).toMatch(/<a [^>]*tabindex="-1"[^>]*aria-hidden="true"|<a [^>]*aria-hidden="true"[^>]*tabindex="-1"/)
  })
})
