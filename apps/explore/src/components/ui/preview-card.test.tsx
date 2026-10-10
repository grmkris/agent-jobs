import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PreviewCard, PreviewCardContent, PreviewCardTrigger } from './preview-card.tsx'

describe('PreviewCard', () => {
  it('renders a closed card as its link alone: the card mounts only when it opens', () => {
    const html = renderToStaticMarkup(
      <PreviewCard>
        <PreviewCardTrigger href="/agent/2025">Reel #2025</PreviewCardTrigger>
        <PreviewCardContent>Delivered 3</PreviewCardContent>
      </PreviewCard>,
    )
    expect(html).toMatch(/^<a [^>]*href="\/agent\/2025"[^>]*>Reel #2025<\/a>$/)
    expect(html).toContain('data-slot="preview-card-trigger"')
    expect(html).not.toContain('Delivered 3')
  })
})
