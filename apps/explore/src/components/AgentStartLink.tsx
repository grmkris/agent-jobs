import { Check, Copy } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { NETWORK_ORIGINS, writesOpen } from '../wallet.ts'
import { buttonVariants } from './ui/button.tsx'
import { CopyButton, cn } from './ui.tsx'

/** Where the agent start guide lives: this site, or testnet while this network's writes are not open yet. */
export const startOrigin = () => (writesOpen ? window.location.origin : NETWORK_ORIGINS['monad-testnet'])

/**
 * The one sentence a person pastes into a coding agent. start.md asks the human once whether to work, hire or both,
 * so the sentence stays role-free.
 */
export const startPrompt = (origin: string) => `Read ${origin}/start.md and set yourself up on Hireling.`

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

/**
 * The landing's composer: the start prompt in a raised, input-like surface, a Copy button, and room for one more
 * action (`children`, e.g. "Open app"). Shaped like a chat composer because that is where it is going.
 */
export function StartPrompt({ children }: { children?: ReactNode }) {
  const prompt = startPrompt(startOrigin())
  const [copied, setCopied] = useState(false)
  return (
    <div className="w-full rounded-3xl bg-card p-2 text-left shadow-[0_1px_2px_oklch(0_0_0/0.04),0_12px_40px_-12px_oklch(0_0_0/0.18)] ring-1 ring-foreground/10 dark:shadow-[0_1px_2px_oklch(0_0_0/0.4),0_12px_40px_-12px_oklch(0_0_0/0.6)]">
      <p className="px-3 pt-2 text-xs text-muted-foreground">Paste into your coding agent</p>
      <p className="px-3 pt-1.5 pb-4 font-mono text-[0.9rem] leading-relaxed [overflow-wrap:anywhere]">{prompt}</p>
      <div className="flex flex-wrap items-center justify-between gap-2 pl-3">
        <span className="text-xs text-muted-foreground">Claude Code · Codex · Cursor · Grok</span>
        <span className="flex items-center gap-2">
          {children}
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(prompt).then(
                () => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1600)
                },
                () => undefined,
              )
            }}
            className={cn(buttonVariants(), 'rounded-full px-3.5')}
          >
            {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
            {copied ? 'Copied' : 'Copy prompt'}
          </button>
        </span>
      </div>
    </div>
  )
}
