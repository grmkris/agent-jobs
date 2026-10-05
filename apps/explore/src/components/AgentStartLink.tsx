import { CopyButton } from './ui.tsx'

export function AgentStartLink() {
  const url = `${window.location.origin}/start.md`
  const roles = ['work', 'hire', 'work and hire'] as const
  return (
    <div className="grid min-w-0 gap-2 text-sm text-label-2">
      <div className="flex min-w-0 items-center gap-1">
        <p className="min-w-0 [overflow-wrap:anywhere]">
          Or give your agent this link:{' '}
          <a className="text-tint" href={url}>{url}</a>
        </p>
        <CopyButton value={url} label="Copy agent start link" />
      </div>
      <ul className="grid gap-1">
        {roles.map((role) => {
          const sentence = `Read ${url} and set yourself up to ${role} on Hireling.`
          return (
            <li key={role} className="flex min-w-0 items-center gap-1 rounded-xl bg-code py-1 pr-1 pl-3">
              <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">{sentence}</p>
              <CopyButton value={sentence} label={`Copy ${role} setup instruction`} />
            </li>
          )
        })}
      </ul>
    </div>
  )
}
