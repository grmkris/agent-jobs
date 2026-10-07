import { asMarkdown, md } from 'fumadocs-core/server'
import { Steps as FumadocsSteps, Step as FumadocsStep } from 'fumadocs-ui/components/steps'
import { Children, isValidElement, type ReactNode } from 'react'
type Props = { children?: ReactNode; title: string }
export function Steps({ children }: { children?: ReactNode }) {
  if (asMarkdown()) return Promise.all(Children.toArray(children).filter(isValidElement<Props>).map(async (child, i) => `\n${i + 1}. **${child.props.title}**\n\n${await md.indent(3)`${child.props.children}`}\n`)).then(parts => parts.join('\n'))
  return <FumadocsSteps>{children}</FumadocsSteps>
}
export function Step({ children, title }: Props) {
  if (asMarkdown()) return md`\n1. **${title}**\n\n${md.indent(3)`${children}`}\n`
  return <FumadocsStep><h3>{title}</h3>{children}</FumadocsStep>
}
