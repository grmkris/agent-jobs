import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { KindGlyph } from './KindGlyph.tsx'

describe('KindGlyph', () => {
  it('draws the kind in words with what identifies it, and a decorative glyph', () => {
    const html = renderToStaticMarkup(<KindGlyph kind="git" label="Git commit" detail="o/r @ aaaaaaa" />)
    expect(html).toContain('Git commit')
    expect(html).toContain('o/r @ aaaaaaa')
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/)
  })

  it('marks a model and media apart from their kind', () => {
    expect(renderToStaticMarkup(<KindGlyph kind="artifact" model label="3D model" detail="duck.glb" />)).toContain(
      'lucide-box',
    )
    expect(renderToStaticMarkup(<KindGlyph kind="artifact" media="video" label="File" detail="cut.mp4" />)).toContain(
      'lucide-film',
    )
  })
})
