/** Shared by the development server and deployed Worker. */
export function startGuideType(pathname: string): string | undefined {
  if (pathname === '/start.md') return 'text/markdown; charset=utf-8'
  if (pathname === '/llms.txt') return 'text/plain; charset=utf-8'
  return undefined
}

export function renderStartGuide(source: string, origin: string): string {
  return source.replaceAll('{{HIRELING_ORIGIN}}', new URL(origin).origin)
}
