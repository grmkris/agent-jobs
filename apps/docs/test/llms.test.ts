import { expect, it } from 'vitest'
import { llmsIndex } from '../src/lib/llms.ts'
const pages = [{ slugs: [], url: '/docs', data: { title: 'Home', description: 'Read this.' } }, { slugs: ['quickstart'], url: '/docs/quickstart', data: { title: 'Quickstart', description: 'Start here.' } }] as Parameters<typeof llmsIndex>[0]
it('lists start.md first and each docs page exactly once as Markdown', () => { const output = llmsIndex(pages, 'https://example.org'); expect(output).toMatch(/^# Sidequest\n\n> /); expect(output.match(/\]\(([^)]+)\)/g)?.[0]).toBe('](https://example.org/start.md)'); expect(output.match(/https:\/\/example.org\/docs\/[^)]+\.md/g)).toEqual(['https://example.org/docs/index.md', 'https://example.org/docs/quickstart.md']) })
