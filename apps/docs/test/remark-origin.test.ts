import { afterEach, expect, it, vi } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkMdx from 'remark-mdx'
import { remarkOrigin } from '../src/lib/remark-origin.ts'
import type { Root } from 'mdast'
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
it('keeps a block Origin a paragraph of its own, so Markdown does not glue it to its neighbours', async () => {
  vi.stubEnv('SIDEQUEST_DOCS_ORIGIN', 'https://preview.example')
  const processor = unified().use(remarkParse).use(remarkMdx).use(remarkOrigin)
  const tree = (await processor.run(processor.parse('## Connect\n\n<Origin path="/mcp" />\n\nThen sign in, see <Origin path="/start.md" link />.'))) as Root
  expect(tree.children.map((node) => node.type)).toEqual(['heading', 'paragraph', 'paragraph'])
  expect(JSON.stringify(tree.children[1])).toContain('"type":"inlineCode","value":"https://preview.example/mcp"')
  expect(JSON.stringify(tree.children[2])).toContain('"type":"link","url":"https://preview.example/start.md"')
})
