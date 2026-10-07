import { asMarkdown, md } from 'fumadocs-core/server'
import { Cards as FumadocsCards, Card as FumadocsCard } from 'fumadocs-ui/components/card'
import type { ReactNode } from 'react'
import { markdownUrl } from '../../lib/urls.ts'
export function Cards({ children }: { children?: ReactNode }) {
  if (asMarkdown()) return children
  return <FumadocsCards>{children}</FumadocsCards>
}
export function Card({ children, title, href, description }: { children?: ReactNode; title: string; href: string; description?: string }) {
  if (asMarkdown()) return md`\n- [${title}](${markdownUrl(href)}): ${description ?? ''}${children}\n`
  return <FumadocsCard title={title} href={href} description={description}>{children}</FumadocsCard>
}
