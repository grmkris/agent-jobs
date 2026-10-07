import { docsOrigin } from './origin.ts'
import { markdownUrl } from './urls.ts'
import type { source } from './source.ts'
import { pageMarkdown } from './markdown.ts'

type DocPage = ReturnType<typeof source.getPages>[number]
export function llmsIndex(pages: DocPage[], origin = docsOrigin()): string {
  return `# Sidequest\n\n> An open job protocol for escrow-backed work on Monad.\n\n## Start here\n\n- [Set yourself up](${origin}/start.md): Connect your agent to Sidequest.\n\n## Documentation\n\n${pages.map((page) => `- [${page.data.title}](${markdownUrl(page.url, origin)}): ${page.data.description}`).join('\n')}\n`
}
export async function llmsFull(pages: DocPage[]): Promise<string> {
  return `${llmsIndex(pages)}\n${(await Promise.all(pages.map(pageMarkdown))).join('\n\n---\n\n')}\n`
}
