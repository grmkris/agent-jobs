import { expect, it } from 'vitest'
import { docsOrigin } from '../src/lib/origin.ts'
import { markdownUrl } from '../src/lib/urls.ts'
it('resolves origin by explicit override, deployment stage, network, then local', () => {
  expect(
    docsOrigin({ SIDEQUEST_DOCS_ORIGIN: 'https://preview.example/path', SIDEQUEST_ORIGIN: 'https://other.example' }),
  ).toBe('https://preview.example')
  expect(docsOrigin({ SIDEQUEST_ORIGIN: 'https://other.example' })).toBe('https://other.example')
  expect(docsOrigin({ SIDEQUEST_STAGE: 'dev' })).toBe('https://dev.sidequest.exchange')
  expect(docsOrigin({ SIDEQUEST_NETWORK: 'monad-mainnet' })).toBe('https://sidequest.exchange')
  expect(docsOrigin({})).toBe('http://localhost:5173')
})
it('maps docs links to absolute Markdown and keeps fragments', () => {
  expect(markdownUrl('/docs/x#y', 'https://example.org')).toBe('https://example.org/docs/x.md#y')
  expect(markdownUrl('/docs', 'https://example.org')).toBe('https://example.org/docs/index.md')
  expect(markdownUrl('/mcp', 'https://example.org')).toBe('https://example.org/mcp')
  expect(markdownUrl('https://elsewhere.example')).toBe('https://elsewhere.example')
})
