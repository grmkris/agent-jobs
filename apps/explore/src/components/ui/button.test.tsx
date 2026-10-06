import { Button } from './button.tsx'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'

test('a busy button keeps its label as its whole accessible name', () => {
  const html = renderToStaticMarkup(<Button busy>Sign</Button>)
  expect(html).toContain('aria-busy="true"')
  expect(html).toContain('disabled=""')
  // The spinner is decoration here: hidden, and neither a status region nor a "Loading" label inside the name.
  expect(html).toMatch(/<svg[^>]*aria-hidden="true"/)
  expect(html).not.toContain('role="status"')
  expect(html).not.toContain('Loading')
})
