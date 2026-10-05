import { CopyButton } from './ui.tsx'

export function AgentStartLink() {
  const url = `${window.location.origin}/start.md`
  return (
    <div className="flex min-w-0 items-center gap-1 text-sm text-label-2">
      <p className="min-w-0 [overflow-wrap:anywhere]">
        Or give your agent this link:{' '}
        <a className="text-tint" href={url}>{url}</a>
      </p>
      <CopyButton value={url} label="Copy agent start link" />
    </div>
  )
}
