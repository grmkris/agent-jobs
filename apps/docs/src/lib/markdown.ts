import type { source } from './source.ts'
import { getMDXComponents } from '../components/mdx.tsx'

export async function pageMarkdown(page: ReturnType<typeof source.getPages>[number]): Promise<string> {
  const text = await page.data.getText('processed', { components: getMDXComponents() })
  return `# ${page.data.title}\n\n> ${page.data.description}\n\n${text}`
}
