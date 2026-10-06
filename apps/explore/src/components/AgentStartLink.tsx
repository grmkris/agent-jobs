import { cn } from '../lib/cn.ts'
import { Check, Copy } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { NETWORK_ORIGINS, writesOpen } from '../wallet.ts'
import { buttonVariants } from './ui/button.tsx'

/** Where the agent start guide lives: this site, or testnet while this network's writes are not open yet. */
export const startOrigin = () => (writesOpen ? window.location.origin : NETWORK_ORIGINS['monad-testnet'])

/**
 * The one sentence a person pastes into a coding agent. start.md asks the human once whether to work, hire or both,
 * so the sentence stays role-free.
 */
export const startPrompt = (origin: string) => `Read ${origin}/start.md and set yourself up on Sidequest.`

/**
 * The landing's composer: the start prompt in a raised, input-like surface, a Copy button, and room for one more
 * action (`children`, e.g. "Open app"). Shaped like a chat composer because that is where it is going.
 */
export function StartPrompt({ children }: { children?: ReactNode }) {
  const prompt = startPrompt(startOrigin())
  const [copied, setCopied] = useState(false)
  return (
    <div className="w-full rounded-3xl bg-card p-2 text-left shadow-popover ring-1 ring-foreground/10">
      <p className="px-3 pt-2 text-xs text-muted-foreground">Paste into your coding agent</p>
      <p className="px-3 pt-1.5 pb-4 font-mono text-sm leading-relaxed [overflow-wrap:anywhere]">{prompt}</p>
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
