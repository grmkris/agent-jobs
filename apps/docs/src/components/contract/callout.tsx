import { asMarkdown, md } from 'fumadocs-core/server'
import { Callout as FumadocsCallout } from 'fumadocs-ui/components/callout'
import type { ReactNode } from 'react'
type Props = { children?: ReactNode; type?: 'info' | 'warn' | 'error' | 'success'; title?: string }
export function Callout({ children, type = 'info', title }: Props) {
  if (asMarkdown()) return md.linePrefix('> ')`${title ? `**${title}:** ` : ''}${children}`
  return (
    <FumadocsCallout type={type} title={title}>
      {children}
    </FumadocsCallout>
  )
}
