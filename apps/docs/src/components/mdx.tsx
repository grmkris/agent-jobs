import defaultMdxComponents from 'fumadocs-ui/mdx'
import { Callout } from './contract/callout.tsx'
import { Cards, Card } from './contract/cards.tsx'
import { Steps, Step } from './contract/steps.tsx'
import { Tabs, Tab } from './contract/tabs.tsx'
import type { MDXComponents } from 'mdx/types'

export function getMDXComponents(components?: MDXComponents) {
  return { ...defaultMdxComponents, Callout, Cards, Card, Steps, Step, Tabs, Tab, ...components } satisfies MDXComponents
}
export const useMDXComponents = getMDXComponents
declare global { type MDXProvidedComponents = ReturnType<typeof getMDXComponents> }
