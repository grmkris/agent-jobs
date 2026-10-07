import { createFileRoute, notFound } from '@tanstack/react-router'
import { source } from '@/lib/source'
import { decodeMarkdownUrl } from '@/lib/shared'
import { pageMarkdown } from '@/lib/markdown'
export const Route = createFileRoute('/docs/{$}.md')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const page = source.getPage(decodeMarkdownUrl(params._splat?.split('/') ?? []))
        if (!page) throw notFound()
        return new Response(await pageMarkdown(page), { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } })
      },
    },
  },
})
