import { asMarkdown, md } from 'fumadocs-core/server'
import { Tabs as FumadocsTabs, Tab as FumadocsTab } from 'fumadocs-ui/components/tabs'
import { Children, isValidElement, type ReactNode } from 'react'
type Props = { children?: ReactNode; title: string }
export function Tabs({ children }: { children?: ReactNode }) {
  if (asMarkdown()) return children
  const tabs = Children.toArray(children).filter(isValidElement<Props>)
  return (
    <FumadocsTabs items={tabs.map((child) => child.props.title)}>
      {tabs.map((child, i) => (
        <FumadocsTab key={i} value={String(i)}>
          {child.props.children}
        </FumadocsTab>
      ))}
    </FumadocsTabs>
  )
}
export function Tab({ children, title }: Props) {
  if (asMarkdown()) return md`\n**${title}**\n\n${children}\n\n`
  return <section aria-label={title}>{children}</section>
}
