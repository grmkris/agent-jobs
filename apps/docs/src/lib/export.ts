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

export async function exportDocs(): Promise<DocsExportPage[]> {
  const pages: DocsExportPage[] = []
  for (const page of source.getPages()) {
    if (page.data.mcp === false) continue
    const slug = page.slugs.join('/') || 'index'
    const markdown = await pageMarkdown(page)
    const sections = page.data.structuredData?.headings?.map((heading) => ({ heading: heading.content, id: heading.id, text: markdown })) ?? []
    pages.push({ slug, path: page.url, title: page.data.title, description: page.data.description ?? '', markdown, sections })
  }
  return pages
}
