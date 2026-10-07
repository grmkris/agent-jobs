import { buttonVariants } from 'fumadocs-ui/components/ui/button'

/**
 * The way back into the app. A plain anchor: Explore is a separate app on the same origin, so this is a full page
 * load, like the landing page's "Open app". Rendered once per width range (header, page row, table-of-contents column).
 */
export function OpenApp({ className = '' }: { className?: string }) {
  return (
    <a href="/jobs" className={`${buttonVariants({ variant: 'outline', size: 'sm' })} gap-1.5 ${className}`}>
      Open app
      <span aria-hidden>↗</span>
    </a>
  )
}
