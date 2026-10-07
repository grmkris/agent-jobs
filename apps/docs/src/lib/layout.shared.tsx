import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'
export function baseOptions(): BaseLayoutProps {
  return { nav: { title: <span className="inline-flex items-baseline gap-2"><span className="font-semibold tracking-tight">Sidequest</span><span className="text-fd-muted-foreground">/ docs</span></span>, url: '/' }, themeSwitch: { enabled: false } }
}
