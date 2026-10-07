import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'
import { OpenApp } from '@/components/open-app'
export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="inline-flex items-baseline gap-2">
          <span className="font-semibold tracking-tight">Sidequest</span>
          <span className="text-fd-muted-foreground">/ docs</span>
        </span>
      ),
      url: '/',
      // Fumadocs also renders nav children in the desktop sidebar header; show this copy below md only, where the
      // page row and the table-of-contents column do not.
      children: (
        <div className="flex justify-end pe-1 md:hidden">
          <OpenApp />
        </div>
      ),
    },
    themeSwitch: { enabled: false },
  }
}
