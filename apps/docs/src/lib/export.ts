import { source } from './source.ts'
import { pageMarkdown } from './markdown.ts'

export type DocsExportPage = {
  slug: string
  path: string
  title: string
  description: string
  markdown: string
  sections: Array<{ heading: string; id: string; text: string }>
}

/** Return the pages exposed to MCP, using the same Markdown renderer as the .md route. */
export async function exportDocs(): Promise<DocsExportPage[]> {
  const exported: DocsExportPage[] = []
  for (const page of source.getPages()) {
    if (page.data.mcp === false) continue
    const slug = page.slugs.join('/') || 'index'
    const markdown = await pageMarkdown(page)
    const structured = typeof page.data.structuredData === 'function'
      ? await page.data.structuredData()
      : page.data.structuredData
    const contents = structured?.contents ?? []
    const sections = (structured?.headings ?? []).map(({ content, id }) => ({
      heading: content,
      id,
      text: contents.filter(item => item.heading === id).map(item => item.content).join('\n\n'),
    }))
    exported.push({
      slug,
      path: page.url,
      title: page.data.title,
      description: page.data.description,
      markdown,
      sections,
    })
  }
  return exported.toSorted((left, right) => left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0)
}
