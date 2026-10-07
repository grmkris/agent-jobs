import { createFileRoute } from '@tanstack/react-router'
import { source } from '@/lib/source'
import { llmsIndex } from '@/lib/llms'
export const Route = createFileRoute('/llms.txt')({
  server: {
    handlers: {
      GET: async () =>
        new Response(await llmsIndex(source.getPages()), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }),
    },
  },
})
