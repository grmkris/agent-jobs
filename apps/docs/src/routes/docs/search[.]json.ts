import { createFileRoute } from '@tanstack/react-router'
import { source } from '@/lib/source'
import { createFromSource } from 'fumadocs-core/search/server'
const search = createFromSource(source, { language: 'english' })
export const Route = createFileRoute('/docs/search.json')({ server: { handlers: { GET: () => search.staticGET() } } })
