import { createFileRoute, notFound } from '@tanstack/react-router'
import { DocsLayout } from 'fumadocs-ui/layouts/docs'
import { DocsBody, DocsDescription, DocsPage, DocsTitle, MarkdownCopyButton } from 'fumadocs-ui/layouts/docs/page'
import { createServerFn } from '@tanstack/react-start'
import { staticFunctionMiddleware } from '@tanstack/start-static-server-functions'
import { Suspense, use } from 'react'
import { source, docs } from '@/lib/source'
import { baseOptions } from '@/lib/layout.shared'
import { getPageMarkdownUrl } from '@/lib/shared'
import { useMDXComponents } from '@/components/mdx'
import { OpenApp } from '@/components/open-app'
import { useFumadocsLoader } from 'fumadocs-core/source/client'

const loadPage = createServerFn({ method: 'GET' })
  .validator((slugs: string[]) => slugs)
  .middleware([staticFunctionMiddleware])
  .handler(async ({ data: slugs }) => {
    const page = source.getPage(slugs)
    if (!page) throw notFound()
    return {
      path: page.path,
      url: page.url,
      title: page.data.title,
      description: page.data.description,
      markdownUrl: getPageMarkdownUrl(page).url,
      pageTree: await source.serializePageTree(source.getPageTree()),
    }
  })
export const Route = createFileRoute('/docs/$')({
  component: Page,
  loader: async ({ params }) => {
    const data = await loadPage({ data: params._splat?.split('/') ?? [] })
    await docs.getPage(data.path)?.preload()
    return data
  },
  head: ({ loaderData }) => ({
    meta: [
      { title: loaderData ? `${loaderData.title} · Sidequest` : 'Sidequest docs' },
      { name: 'description', content: loaderData?.description ?? 'Sidequest protocol documentation.' },
    ],
    links: loaderData
      ? [
          { rel: 'alternate', type: 'text/markdown', href: loaderData.markdownUrl },
          { rel: 'canonical', href: new URL(loaderData.url, __DOCS_ORIGIN__).href },
        ]
      : [],
  }),
})
function Content({ path, markdownUrl }: { path: string; markdownUrl: string }) {
  const page = docs.getPage(path)
  if (!page) throw new Error(`Unknown page: ${path}`)
  const { toc } = use(page.load())
  const MDX = page.body
  return (
    // "Open app": top right of the table-of-contents column from xl, in this row between md and xl, and in the
    // mobile header (layout.shared.tsx) below md, so exactly one shows at any width.
    <DocsPage toc={toc} tableOfContent={{ header: <OpenApp className="mb-4 self-start" /> }}>
      <DocsTitle>{page.title}</DocsTitle>
      <DocsDescription>{page.description}</DocsDescription>
      <div className="-mt-4 mb-6 flex items-center border-b pb-6">
        <MarkdownCopyButton markdownUrl={markdownUrl} />
        <span className="ms-auto hidden md:block xl:hidden">
          <OpenApp />
        </span>
      </div>
      <DocsBody>
        <MDX components={useMDXComponents()} />
      </DocsBody>
    </DocsPage>
  )
}
function Page() {
  const { pageTree, path, markdownUrl } = useFumadocsLoader(Route.useLoaderData())
  return (
    <DocsLayout {...baseOptions()} tree={pageTree}>
      <Suspense>
        <Content path={path} markdownUrl={markdownUrl} />
      </Suspense>
    </DocsLayout>
  )
}
