import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router'
import * as React from 'react'
import appCss from '@/styles/app.css?url'
import { RootProvider } from 'fumadocs-ui/provider/tanstack'
import Search from '@/components/search'
import { DocsLink } from '@/components/docs-link'

export const Route = createRootRoute({
  head: () => ({ meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }, { name: 'generator', content: 'sidequest-docs' }, { title: 'Sidequest docs' }], links: [{ rel: 'stylesheet', href: appCss }, { rel: 'icon', href: '/favicon.svg' }] }),
  component: RootComponent,
})
function RootComponent() { return <html lang="en" suppressHydrationWarning><head><HeadContent /></head><body className="flex min-h-screen flex-col"><RootProvider theme={{ enabled: false }} search={{ SearchDialog: Search }} components={{ Link: DocsLink }}><Outlet /></RootProvider><Scripts /></body></html> }
