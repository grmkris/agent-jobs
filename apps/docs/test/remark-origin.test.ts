import { afterEach, expect, it, vi } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkMdx from 'remark-mdx'
import { remarkOrigin } from '../src/lib/remark-origin.ts'
afterEach(() => vi.unstubAllEnvs())
it('rewrites code, inline code, links, and Origin elements', async () => {
  vi.stubEnv('SIDEQUEST_DOCS_ORIGIN', 'https://preview.example')
  const processor = unified().use(remarkParse).use(remarkMdx).use(remarkOrigin)
  const tree = await processor.run(processor.parse('```sh\ncurl {{SIDEQUEST_ORIGIN}}/mcp\n```\n\n`{{SIDEQUEST_ORIGIN}}/mcp`\n\n[link]({{SIDEQUEST_ORIGIN}}/mcp)\n\n<Origin path="/mcp" />\n\n<Origin path="/start.md" link />'))
  const json = JSON.stringify(tree)
  expect(json).not.toContain('{{SIDEQUEST_ORIGIN}}')
  expect(json).toContain('https://preview.example/mcp')
  expect(json).toContain('https://preview.example/start.md')
  expect(json).not.toContain('"name":"Origin"')
})
