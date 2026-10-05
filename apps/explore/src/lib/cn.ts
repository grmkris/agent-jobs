import { createCn } from 'cn/config'

/**
 * clsx + tailwind-merge in one call (the `cn` package), taught our two extra text sizes: without this, `text-ui` and
 * `text-micro` read as colours, so `cn('text-ui text-muted-foreground')` would drop the size.
 */
export const cn = createCn({ extend: { classGroups: { 'font-size': [{ text: ['ui', 'micro'] }] } } })
