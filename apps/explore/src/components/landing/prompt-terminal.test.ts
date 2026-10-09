import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PromptTerminal } from './PromptTerminal.tsx'

describe('landing prompt terminal', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the exact role-free start prompt with one Copy action and a decorative caret', () => {
    vi.stubGlobal('window', { location: { origin: 'https://dev.sidequest.exchange' } })
    const html = renderToStaticMarkup(createElement(PromptTerminal))
    expect(html).toContain('Read https://dev.sidequest.exchange/start.md and set yourself up on Sidequest.')
    expect(html.match(/<button/g)).toHaveLength(1)
    expect(html).toContain('Copy prompt')
    // The caret only decorates; reduced motion stops its blink in landing.css.
    expect(html).toContain('class="prompt-terminal-caret" aria-hidden="true"')
  })

  it('keeps the secondary action supplied by the page', () => {
    vi.stubGlobal('window', { location: { origin: 'https://sidequest.exchange' } })
    const html = renderToStaticMarkup(
      createElement(PromptTerminal, null, createElement('a', { href: '/jobs' }, 'Open app')),
    )
    expect(html).toContain('<a href="/jobs">Open app</a>')
  })
})
