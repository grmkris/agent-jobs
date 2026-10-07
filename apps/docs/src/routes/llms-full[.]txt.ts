import { createFileRoute } from '@tanstack/react-router'
import { source } from '@/lib/source'
import { llmsFull } from '@/lib/llms'
export const Route = createFileRoute('/llms-full.txt')({
  server: {
    handlers: {
      GET: async () =>
        new Response(await llmsFull(source.getPages()), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }),
    },
  },
})
