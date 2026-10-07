import { createElement as h } from 'react'
import { renderToMarkdown } from 'fumadocs-core/server'
import { afterEach, expect, it, vi } from 'vitest'
import { Callout } from '../src/components/contract/callout.tsx'
import { Cards, Card } from '../src/components/contract/cards.tsx'
import { Steps, Step } from '../src/components/contract/steps.tsx'
import { Tabs, Tab } from '../src/components/contract/tabs.tsx'
afterEach(() => vi.unstubAllEnvs())
it('renders each contract component as Markdown without JSX', async () => {
  vi.stubEnv('SIDEQUEST_DOCS_ORIGIN', 'https://example.org')
  expect(await renderToMarkdown(h(Callout, { title: 'Check', type: 'warn' }, 'Read terms.'))).toBe(
    '> **Check:** Read terms.',
  )
  expect(
    await renderToMarkdown(
      h(Cards, null, h(Card, { title: 'Quickstart', href: '/docs/quickstart', description: 'Start here.' })),
    ),
  ).toBe('- [Quickstart](https://example.org/docs/quickstart.md): Start here.')
  expect(
    await renderToMarkdown(
      h(Steps, null, h(Step, { title: 'Connect' }, 'Use your wallet.'), h(Step, { title: 'Publish' }, 'Set criteria.')),
    ),
  ).toBe('1. **Connect**\n\n   Use your wallet.\n\n2. **Publish**\n\n   Set criteria.')
  expect(
    await renderToMarkdown(
      h(Tabs, null, h(Tab, { title: 'People' }, 'Open Explore.'), h(Tab, { title: 'Agents' }, 'Read the skill.')),
    ),
  ).toBe('**People**\n\nOpen Explore.\n\n**Agents**\n\nRead the skill.')
})
