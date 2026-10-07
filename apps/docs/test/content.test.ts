import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { contentErrors } from '../src/lib/content-contract.ts'
const root = fileURLToPath(new URL('../content/docs/', import.meta.url))
const files = readdirSync(root, { recursive: true }).map(String)
const pages = files.filter(file => /\.(md|mdx)$/.test(file))
const metadata = files.filter(file => file.endsWith('meta.json')).map(file => ({ dir: dirname(join(root, file)), pages: (JSON.parse(readFileSync(join(root, file), 'utf8')) as { pages?: string[] }).pages ?? [] }))
const valid = '---\ntitle: Test\ndescription: Test page.\n---\n\n'
describe('docs content contract', () => {
  it.each(pages)('%s obeys the content contract and is listed in metadata', (file) => {
    expect(contentErrors(readFileSync(join(root, file), 'utf8'), file)).toEqual([])
    const path = join(root, file).replace(/\.(md|mdx)$/, '')
    expect(metadata.some(meta => meta.pages.includes(relative(meta.dir, path)))).toBe(true)
  })
  it.each([
    'import X from "x"', 'export const x = 1', '{doWork()}', '<Unknown />', '<Callout onClick="x" />', '<Callout title={"x"} />', '<Callout type="danger" />', '<Origin path="//evil.example" />', '<Card title="T" href="/docs" />', '<Steps>prose</Steps>', '<Step title="T">body</Step>', '<img src="https://elsewhere.example/img.png" alt="x" />', '[link](javascript:alert)', '```npm\nx\n```', '```sh tab="a"\nx\n```', 'pnpm add @sidequest/sdk', '0x1111111111111111111111111111111111111111', 'https://dev.sidequest.exchange/mcp', 'A trustless contest',
  ])('rejects %s', (bad) => expect(contentErrors(`${valid}${bad}`)).not.toEqual([]))
  it('rejects missing frontmatter and a legacy escape hatch', () => { expect(contentErrors('hello')).not.toEqual([]); expect(contentErrors(valid.replace('---\n\n', 'legacy: true\n---\n\n') + 'contest')).not.toEqual([]) })
  it('refuses a body H1, which doubles the template title', () => expect(contentErrors(`${valid}# Test\n\nBody.`)).toEqual(['page.mdx: no H1 in the body: the frontmatter title is the page heading']))
  it('allows code tokens and the component contract', () => expect(contentErrors(`${valid}<Callout type="warn" title="Check">Read the terms.</Callout>\n\n<Origin path="/mcp" link />\n\n<ContractAddresses />\n\n\`{{SIDEQUEST_ORIGIN}}/mcp\`\n\n\`\`\`sh title="Connect"\ncurl {{SIDEQUEST_ORIGIN}}/start.md\n\`\`\``)).toEqual([]))
})
