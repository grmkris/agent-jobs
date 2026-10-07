import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkMdx from 'remark-mdx'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import { parse } from 'yaml'
import { visit } from 'unist-util-visit'
import type { MdxJsxFlowElement, MdxJsxTextElement } from 'mdast-util-mdx'

const attrs: Record<string, readonly string[]> = {
  Callout: ['type', 'title'], Cards: [], Card: ['title', 'href', 'description'], Steps: [], Step: ['title'], Tabs: [], Tab: ['title'], Origin: ['path', 'link'], ContractAddresses: ['network'],
  a: ['href', 'title'], img: ['src', 'alt', 'title'], table: [], pre: [],
}
const required: Record<string, readonly string[]> = { Card: ['title', 'href'], Step: ['title'], Tab: ['title'], Origin: ['path'], img: ['src', 'alt'], a: ['href'] }
const banned = /\b(?:trustless|contest|pledge|JobHolding|JobPool|FACTORY|hireling)\b/i
const parser = unified().use(remarkParse).use(remarkFrontmatter, ['yaml']).use(remarkMdx).use(remarkGfm)

export function contentErrors(text: string, file = 'page.mdx'): string[] {
  const errors: string[] = []
  const error = (message: string) => errors.push(`${file}: ${message}`)
  if (file.split('/').some(part => /[()]/.test(part))) error('group folders are forbidden')
  if (/0x[0-9a-fA-F]{40}/.test(text)) error('use ContractAddresses instead of raw addresses')
  if (/sidequest\.exchange/i.test(text)) error('use Origin instead of hand-typed origins')
  if (/(?:npm\s+install|pnpm\s+add|bun\s+add)\s+@sidequest\//.test(text)) error('Sidequest packages are private')
  let tree
  try { tree = parser.parse(text) } catch (e) { error(`invalid MDX: ${e instanceof Error ? e.message : String(e)}`); return errors }
  const front = tree.children[0]
  let metadata: Record<string, unknown> = {}
  if (front?.type !== 'yaml') error('frontmatter is required')
  else {
    try { metadata = parse(front.value) ?? {} } catch { error('invalid frontmatter') }
    for (const key of ['title', 'description']) if (typeof metadata[key] !== 'string' || !(metadata[key] as string).trim()) error(`frontmatter ${key} is required`)
    if ('slug' in metadata) error('frontmatter slug is forbidden')
    if (metadata.legacy === true) error('legacy pages are not allowed in this docs track')
    if (metadata.mcp !== undefined && typeof metadata.mcp !== 'boolean') error('mcp must be boolean')
  }
  if (metadata.legacy !== true && banned.test(text)) error('legacy or unsupported terminology')
  visit(tree, (node, _index, parent) => {
    if (node.type === 'mdxjsEsm') error('imports and exports are forbidden')
    if (node.type === 'mdxFlowExpression' || node.type === 'mdxTextExpression') error('expressions are forbidden in prose')
    if (node.type === 'text' && node.value.includes('{')) error('braces are forbidden in prose')
    if (node.type === 'code') { if (node.lang === 'npm') error('npm code fences are forbidden'); if (/\btab\s*=/.test(node.meta ?? '')) error('code tab metadata is forbidden') }
    if (node.type !== 'code' && node.type !== 'inlineCode' && 'value' in node && typeof node.value === 'string' && node.value.includes('{{SIDEQUEST_ORIGIN}}')) error('origin tokens are allowed only inside code')
    if (node.type === 'link' || node.type === 'definition' || node.type === 'image') {
      if (node.url.includes('{{SIDEQUEST_ORIGIN}}')) error('origin tokens are allowed only inside code')
      if (/^(?:javascript|data|vbscript):/i.test(node.url)) error('unsafe URL')
      if (node.type === 'image' && !/^\.?\/?images\/[^.]/.test(node.url)) error('images must live under content/docs/images')
    }
    if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') {
      const element = node as MdxJsxFlowElement | MdxJsxTextElement
      const name = element.name ?? ''
      const allowed = attrs[name]
      if (!allowed) { error(`component ${name || 'fragment'} is forbidden`); return }
      const values = new Map<string, string | null>()
      for (const attr of element.attributes) {
        if (attr.type !== 'mdxJsxAttribute' || (attr.value !== null && typeof attr.value !== 'string')) { error('component attributes must be static'); continue }
        if (!allowed.includes(attr.name)) error(`attribute ${attr.name} is forbidden on ${name}`)
        if (values.has(attr.name)) error(`duplicate attribute ${attr.name}`)
        values.set(attr.name, attr.value)
        if (typeof attr.value === 'string' && /^(?:javascript|data|vbscript):/i.test(attr.value)) error('unsafe URL')
      }
      for (const key of required[name] ?? []) if (typeof values.get(key) !== 'string' || !values.get(key)?.trim()) error(`${name} requires ${key}`)
      if (name === 'Callout' && values.has('type') && !['info', 'warn', 'error', 'success'].includes(values.get('type') ?? '')) error('invalid Callout type')
      if (name === 'Origin') {
        const path = values.get('path') ?? ''
        if (!path.startsWith('/') || path.startsWith('//')) error('Origin path must be root-relative')
        if (values.has('link') && values.get('link') !== null) error('Origin link is a boolean attribute')
      }
      if (name === 'img' && !/^\.?\/?images\/[^.]/.test(values.get('src') ?? '')) error('images must live under content/docs/images')
      const container = name === 'Card' ? 'Cards' : name === 'Step' ? 'Steps' : name === 'Tab' ? 'Tabs' : undefined
      if (container && (!(parent?.type === 'mdxJsxFlowElement' || parent?.type === 'mdxJsxTextElement') || parent.name !== container)) error(`${name} must be a direct child of ${container}`)
      if (['Cards', 'Steps', 'Tabs'].includes(name)) {
        const expected = name === 'Cards' ? 'Card' : name === 'Steps' ? 'Step' : 'Tab'
        if (!element.children.some(child => (child.type === 'mdxJsxFlowElement' || child.type === 'mdxJsxTextElement') && child.name === expected)) error(`${name} must contain ${expected}`)
        for (const child of element.children) if (!(child.type === 'text' && !child.value.trim()) && !((child.type === 'mdxJsxFlowElement' || child.type === 'mdxJsxTextElement') && child.name === expected)) error(`${name} accepts only ${expected}`)
      }
    }
  })
  return errors
}
