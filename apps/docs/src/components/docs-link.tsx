import { Link } from '@tanstack/react-router'
import type { ComponentProps } from 'react'
export function DocsLink({ href, prefetch: _prefetch, ...props }: ComponentProps<'a'> & { prefetch?: boolean }) {
  if (!href || !/^\/docs(?:\/|$)/.test(href) || /\.(md|json)(?:[?#]|$)/.test(href)) return <a href={href} {...props} />
  return <Link to={href} {...props} />
}
