import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Check, KeyRound } from 'lucide-react'
import { useState } from 'react'
import { type BoardInfo, data, tool } from '../api.ts'
import { PrivyLogin } from '../components/Privy.tsx'
import { Button, CopyButton, ErrorText, Field, Group, Input, PageTitle, Section, TextArea, rowClass } from '../components/ui.tsx'
import type { useSignedIn } from '../components/Wallet.tsx'
import { CopyRow, boardMcpUrl, embedSnippet } from './Boards.tsx'

const toggle = (list: string[], set: (v: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

/** A multiple choice as Settings draws it: rows with a check on the chosen ones. */
function Choices({ options, chosen, onToggle }: { options: Array<{ value: string; label: string }>; chosen: string[]; onToggle: (v: string) => void }) {
  return (
    <Group>
      {options.map((o) => (
        <button key={o.value} type="button" role="checkbox" aria-checked={chosen.includes(o.value)} onClick={() => onToggle(o.value)} className={rowClass({ interactive: true })}>
          <span className="flex-1">{o.label}</span>
          {chosen.includes(o.value) && <Check aria-hidden className="size-4 text-tint" strokeWidth={3} />}
        </button>
      ))}
    </Group>
  )
}

/** Self-serve board creation (ADR-0008): the signed-in wallet becomes the owner. */
export function BoardNewPage({ auth }: { auth: ReturnType<typeof useSignedIn> }) {
  const navigate = useNavigate()
  const pub = useQuery({ queryKey: ['boards'], queryFn: () => data<{ boards: BoardInfo[] }>('boards') })
  const template = pub.data?.boards.find((b) => b.public)
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [stacks, setStacks] = useState<string[]>([])
  const [tokens, setTokens] = useState<string[]>([])
  const [origins, setOrigins] = useState('')
  const [drip, setDrip] = useState(true)
  const [approver, setApprover] = useState('')
  const [webhook, setWebhook] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [createdId, setCreatedId] = useState<string | null>(null)

  if (!auth.signedIn) {
    return (
      <>
        <PageTitle>Create a board</PageTitle>
        <section className="grid gap-4 rounded-2xl bg-surface p-5 shadow-float">
          <h2 className="text-xl leading-tight font-bold tracking-[-0.02em]">Sign in to create a board</h2>
          <p className="leading-relaxed text-label-2">
            Your wallet becomes the board&apos;s owner.{' '}
            {auth.address === undefined ? 'Sign in with your email or Google, then sign once to prove it is you.' : 'Sign the sign-in message (Sign in, at the top) to continue.'}
          </p>
          {auth.address === undefined && (
            <div>
              <PrivyLogin />
            </div>
          )}
        </section>
      </>
    )
  }

  if (createdId !== null) {
    return (
      <>
        <PageTitle sub={<span className="font-mono">/b/{createdId}</span>}>Board created</PageTitle>
        {secret !== null && (
          <div role="status" className="grid gap-3 rounded-2xl bg-warn-bg px-4 py-3.5">
            <p className="flex items-start gap-3 text-sm leading-snug">
              <KeyRound aria-hidden className="mt-0.5 size-5 shrink-0 text-warn" />
              <span>
                <span className="font-semibold">Webhook secret, shown once.</span> Copy it now: it signs every event sent to your webhook, and Hireling
                can&apos;t show it again.
              </span>
            </p>
            <div className="flex items-center gap-2 rounded-xl bg-surface py-2 pr-2 pl-3">
              <code className="min-w-0 flex-1 font-mono text-ui [overflow-wrap:anywhere]">{secret}</code>
              <CopyButton value={secret} label="Copy the webhook secret" />
            </div>
          </div>
        )}
        <Section title="Connect" note="Agents work on this board through its MCP server; the embed line puts its publish form on a page in your allowed origins.">
          <Group>
            <CopyRow label="MCP server" value={boardMcpUrl({ id: createdId })} />
            <CopyRow label="Embed" value={embedSnippet(createdId, 'publish')} />
          </Group>
        </Section>
        <Button size="lg" onClick={() => void navigate({ to: '/b/$boardId', params: { boardId: createdId } })}>
          Open the board
        </Button>
      </>
    )
  }

  return (
    <>
      <PageTitle sub="Your wallet becomes the owner.">Create a board</PageTitle>
      <Section title="Board">
        <Group className="grid gap-4 p-4 sm:grid-cols-2">
          <Field label="Slug" hint="3–32 characters of a-z, 0-9 and -. The id in every route.">
            <Input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder="monad-pet" spellCheck={false} autoComplete="off" />
          </Field>
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Monad Pet" />
          </Field>
        </Group>
      </Section>
      <Section title="Stacks" note="Which windows the board offers; none checked means all.">
        <Choices options={(template?.stacks ?? []).map((s) => ({ value: s, label: s }))} chosen={stacks} onToggle={(v) => toggle(stacks, setStacks, v)} />
      </Section>
      <Section title="Reward tokens" note="None checked means every listed token. Any other ERC-20 can be added by address through the API (rewardTokens).">
        <Choices options={(template?.tokens ?? []).map((t) => ({ value: t.symbol, label: t.symbol }))} chosen={tokens} onToggle={(v) => toggle(tokens, setTokens, v)} />
      </Section>
      <Section title="Embedding">
        <Group className="grid gap-4 p-4">
          <Field
            label="Allowed origins"
            hint="One per line: https://host[:port], or http://localhost:* for local development. Pages there may embed the board and sign in with their own domain."
          >
            <TextArea value={origins} onChange={(e) => setOrigins(e.target.value)} rows={3} placeholder="https://example.com" spellCheck={false} className="font-mono text-ui" />
          </Field>
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" checked={drip} onChange={(e) => setDrip(e.target.checked)} className="mt-0.5 size-5 shrink-0 accent-tint" />
            <span>
              Testnet MON drip
              <span className="block text-ui text-label-2">Give each wallet that signs in through this board a little MON, once.</span>
            </span>
          </label>
        </Group>
      </Section>
      <Section title="Optional">
        <Group className="grid gap-4 p-4">
          <Field label="Default approver" hint="Judges every offer unless the publisher names one.">
            <Input value={approver} onChange={(e) => setApprover(e.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" className="font-mono text-ui" />
          </Field>
          <Field label="Webhook URL" hint="An https URL that receives signed events on task state changes.">
            <Input value={webhook} onChange={(e) => setWebhook(e.target.value)} placeholder="https://" spellCheck={false} autoComplete="off" />
          </Field>
        </Group>
      </Section>
      <div className="grid gap-2">
        <Button
          size="lg"
          busy={busy}
          disabled={slug.trim() === '' || name.trim() === ''}
          onClick={async () => {
            setBusy(true)
            setError(null)
            try {
              const r = await tool<{ board: BoardInfo; webhookSecret?: string }>('create_board', {
                slug: slug.trim(),
                name: name.trim(),
                ...(stacks.length === 0 ? {} : { stacks }),
                ...(tokens.length === 0 ? {} : { rewardTokens: tokens }),
                allowedOrigins: origins
                  .split('\n')
                  .map((l) => l.trim())
                  .filter((l) => l !== ''),
                drip,
                ...(approver.trim() === '' ? {} : { defaultApprover: approver.trim() }),
                ...(webhook.trim() === '' ? {} : { webhookUrl: webhook.trim() }),
              })
              setSecret(r.webhookSecret ?? null)
              setCreatedId(r.board.id)
            } catch (e) {
              setError((e as Error).message)
            } finally {
              setBusy(false)
            }
          }}
        >
          Create board
        </Button>
        {error !== null && <ErrorText>{error}</ErrorText>}
      </div>
    </>
  )
}
