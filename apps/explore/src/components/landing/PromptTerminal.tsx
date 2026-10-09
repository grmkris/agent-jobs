import { Check, Copy } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { startOrigin, startPrompt } from '../AgentStartLink.tsx'

/**
 * The landing's one action: the role-free start prompt as a terminal line, with Copy beside it. `children` holds one
 * secondary action (the landing passes "Open app"), so this stays free of router context.
 */
export function PromptTerminal({ children }: { children?: ReactNode }) {
  const prompt = startPrompt(startOrigin())
  const [copied, setCopied] = useState(false)
  return (
    <div className="prompt-terminal">
      <div className="prompt-terminal-bar">
        <span className="prompt-terminal-lights" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span>Paste into Claude Code, Codex, Cursor or Grok</span>
      </div>
      <p className="prompt-terminal-line">
        <span className="prompt-terminal-glyph" aria-hidden="true">
          ›
        </span>
        <code>{prompt}</code>
        <span className="prompt-terminal-caret" aria-hidden="true" />
      </p>
      <div className="prompt-terminal-actions">
        {children}
        <button
          type="button"
          className="prompt-terminal-copy"
          onClick={() => {
            void navigator.clipboard.writeText(prompt).then(
              () => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1600)
              },
              () => undefined,
            )
          }}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? 'Copied' : 'Copy prompt'}
        </button>
      </div>
    </div>
  )
}
