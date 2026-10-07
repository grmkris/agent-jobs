import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { docsDir, siteDir } from '../site-output.mjs'

export async function verifyOutput(root = siteDir()) {
  const pages = readdirSync(join(docsDir, 'content/docs'), { recursive: true })
    .map(String)
    .filter((file) => /\.(md|mdx)$/.test(file))
    .map((file) => file.replace(/\.(md|mdx)$/, ''))
  const required = [
    'docs/not-found.html',
    'docs/search.json',
    'llms.txt',
    'llms-full.txt',
    ...pages.flatMap((slug) => [slug === 'index' ? 'docs.html' : `docs/${slug}.html`, `docs/${slug}.md`]),
  ]
  for (const file of required) if (!existsSync(join(root, file))) throw new Error(`Missing docs output: ${file}`)
  for (const dir of ['docs/_assets', '__tsr/staticServerFnCache'])
    if (!existsSync(join(root, dir)) || readdirSync(join(root, dir)).length === 0)
      throw new Error(`Missing docs output: ${dir}`)
  for (const file of readdirSync(root, { recursive: true })
    .map(String)
    .filter((candidate) => candidate.endsWith('.html'))) {
    const html = readFileSync(join(root, file), 'utf8')
    if (!html.includes('content="sidequest-docs"')) throw new Error(`Missing docs marker: ${file}`)
    if (html.includes('$RC(') || html.includes('<template id="B:')) throw new Error(`Unresolved boundary: ${file}`)
    // Stylesheets, scripts and preloads must ship in this output, or Explore serves the page unstyled or broken.
    for (const [, ref] of html.matchAll(
      /<(?:link|script)\b[^>]*\b(?:href|src)="(\/(?:docs\/_assets|assets)\/[^"?#]+)"/g,
    )) {
      if (!existsSync(join(root, ref))) throw new Error(`Missing referenced asset ${ref}: ${file}`)
    }
  }
  const llms = readFileSync(join(root, 'llms.txt'), 'utf8')
  for (const [, link] of llms.matchAll(/\]\((https?:\/\/[^)]+)\)/g)) {
    const path = new URL(link).pathname
    if (path.startsWith('/docs/') && !existsSync(join(root, path))) throw new Error(`Missing llms target: ${path}`)
  }
  for (const slug of pages) {
    const markdown = readFileSync(join(root, `docs/${slug}.md`), 'utf8')
    const prose = markdown.replace(/^(`{3,}|~{3,}).*\n[\s\S]*?^\1[^\n]*$/gm, '')
    if (/<[A-Z][A-Za-z]*\b/.test(prose)) throw new Error(`Unrendered JSX: ${slug}`)
  }
  JSON.parse(readFileSync(join(root, 'docs/search.json'), 'utf8'))
  const generated = resolve(docsDir, '../api/src/generated/docs.ts')
  if (existsSync(generated)) {
    const { DOCS } = await import(pathToFileURL(generated).href)
    const origin = new URL(/\]\((https?:\/\/[^)]+)\/start\.md\)/.exec(llms)?.[1] ?? 'http://localhost:5173').origin
    for (const page of DOCS) {
      const slug = page.slug || 'index'
      const served = readFileSync(join(root, `docs/${slug}.md`), 'utf8')
      if (served !== page.markdown.replaceAll('https://sidequest.origin.invalid', origin))
        throw new Error(`MCP Markdown parity failed: ${slug}`)
    }
  }
  return required
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const files = await verifyOutput()
  console.log(`verified ${files.length} docs outputs, assets, cache, and Markdown in ${siteDir()}`)
}
