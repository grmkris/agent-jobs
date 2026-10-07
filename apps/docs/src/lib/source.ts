import { loader } from 'fumadocs-core/source'
import { lucideIconsPlugin } from 'fumadocs-core/source/lucide-icons'
import { defineDocs } from 'fumadocs-mdx/macro'
import { pageSchema } from 'fumadocs-core/source/schema'
import { z } from 'zod'
import { defaultHandlers } from 'mdast-util-to-markdown'
import { markdownUrl } from './urls.ts'
import { docsRoute } from './shared.ts'

export const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    async: true,
    schema: pageSchema.extend({
      description: z.string(),
      mcp: z.boolean().default(true),
      legacy: z.boolean().default(false),
    }),
    postprocess: {
      includeProcessedMarkdown: {
        output: 'function',
        headingIds: false,
        handlers: {
          link: (node, parent, state, info) =>
            defaultHandlers.link!({ ...node, url: markdownUrl(node.url) }, parent, state, info),
        },
      },
    },
  },
})

export const source = loader({ source: docs.toFumadocsSource(), baseUrl: docsRoute, plugins: [lucideIconsPlugin()] })
