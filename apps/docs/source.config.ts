import { defineConfig } from 'fumadocs-mdx/config'
import { remarkOrigin } from './src/lib/remark-origin.ts'
import { remarkAddresses } from './src/lib/remark-addresses.ts'

// Compiler plugins stay outside the application's browser bundle.
export default defineConfig({
  mdxOptions: {
    remarkPlugins: [remarkOrigin, remarkAddresses],
    remarkCodeTabOptions: false,
    remarkNpmOptions: false,
    rehypeCodeOptions:
      process.env.SIDEQUEST_DOCS_EXPORT === '1' ? false : { themes: { light: 'github-light', dark: 'github-dark' } },
  },
})
