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
import { useFumadocsLoader } from 'fumadocs-core/source/client'

const loader = createServerFn({ method: 'GET' }).validator((slugs: string[]) => slugs).middleware([staticFunctionMiddleware]).handler(async ({ data: slugs }) => {
  const page = source.getPage(slugs)
  if (!page) throw notFound()
  await docs.getPage(page.path)?.preload()
  return { path: page.path, markdownUrl: getPageMarkdownUrl(page).url, pageTree: await source.serializePageTree(source.getPageTree()) }
})
export const Route = createFileRoute('/docs/$')({ component: Page, loader: ({ params }) => loader({ data: params._splat?.split('/') ?? [] }), head: ({ loaderData }) => ({ meta: [{ title: loaderData?.path ? `Sidequest docs · ${loaderData.path}` : 'Sidequest docs' }, { name: 'description', content: 'Sidequest protocol documentation.' }], links: loaderData ? [{ rel: 'alternate', type: 'text/markdown', href: loaderData.markdownUrl }, { rel: 'canonical', href: `/docs/${loaderData.path}` }] : [] }) })
function Content({ path, markdownUrl }: { path: string; markdownUrl: string }) { const page = docs.getPage(path); if (!page) throw new Error(`Unknown page: ${path}`); const { toc } = use(page.load()); const MDX = page.body; return <DocsPage toc={toc}><DocsTitle>{page.title}</DocsTitle><DocsDescription>{page.description}</DocsDescription><div className="-mt-4 mb-6 flex items-center border-b pb-6"><MarkdownCopyButton markdownUrl={markdownUrl} /></div><DocsBody><MDX components={useMDXComponents()} /></DocsBody></DocsPage> }
function Page() { const { pageTree, path, markdownUrl } = useFumadocsLoader(Route.useLoaderData()); return <DocsLayout {...baseOptions()} tree={pageTree}><Suspense><Content path={path} markdownUrl={markdownUrl} /></Suspense></DocsLayout> }
