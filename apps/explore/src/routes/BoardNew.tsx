import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { type BoardInfo, data, tool } from '../api.ts'
import { Button, Card } from '../components/ui.tsx'
import type { useSignedIn } from '../components/Wallet.tsx'

const input = 'w-full rounded border border-sep px-2 py-1 text-sm'
const toggle = (list: string[], set: (v: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint !== undefined && <span className="block text-xs text-label-2">{hint}</span>}
    </label>
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
  if (!auth.signedIn) return <Card title="Create a board"><p className="text-sm text-label-2">Log in and sign in to create a board.</p></Card>
  if (createdId !== null) {
    return (
      <Card title="Board created">
        <div className="space-y-2 text-sm">
          <p>Your board lives at <span className="font-mono">/b/{createdId}</span>. Its MCP server is <span className="font-mono">{window.location.origin}/b/{createdId}/mcp</span>.</p>
          <p className="font-mono text-xs">{`<script src="${window.location.origin}/embed.js" data-board="${createdId}" data-view="publish"></script>`}</p>
          {secret !== null && <p className="rounded border border-warn/30 bg-warn-bg p-2 text-xs">Webhook secret (shown once): <span className="font-mono">{secret}</span></p>}
          <Button onClick={() => void navigate({ to: '/b/$boardId', params: { boardId: createdId } })}>Open the board</Button>
        </div>
      </Card>
    )
  }
  return (
    <Card title="Create a board">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Slug" hint="3–32 characters of a-z, 0-9 and -. The id in every route."><input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} className={input} /></Field>
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} className={input} /></Field>
        <Field label="Stacks" hint="Which windows the board offers; none checked means all.">
          <div className="flex gap-3 text-sm">{(template?.stacks ?? []).map((s) => <label key={s} className="flex items-center gap-1"><input type="checkbox" checked={stacks.includes(s)} onChange={() => toggle(stacks, setStacks, s)} />{s}</label>)}</div>
        </Field>
        <Field label="Reward tokens" hint="None checked means all allowlisted tokens.">
          <div className="flex gap-3 text-sm">{(template?.tokens ?? []).map((t) => <label key={t.address} className="flex items-center gap-1"><input type="checkbox" checked={tokens.includes(t.symbol)} onChange={() => toggle(tokens, setTokens, t.symbol)} />{t.symbol}</label>)}</div>
        </Field>
        <div className="sm:col-span-2"><Field label="Allowed origins" hint="One per line: https://host[:port], or http://localhost:* for local development. Pages there may embed the board and sign in with their own domain."><textarea value={origins} onChange={(e) => setOrigins(e.target.value)} rows={3} className={input} /></Field></div>
        <Field label="Default approver" hint="Optional: judges every offer unless the publisher names one."><input value={approver} onChange={(e) => setApprover(e.target.value)} className={input} /></Field>
        <Field label="Webhook URL" hint="Optional https URL that receives signed events on task state changes."><input value={webhook} onChange={(e) => setWebhook(e.target.value)} className={input} /></Field>
        <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={drip} onChange={(e) => setDrip(e.target.checked)} /> Testnet MON drip: give each wallet that signs in through this board a little MON, once.</label>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Button
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
                allowedOrigins: origins.split('\n').map((l) => l.trim()).filter((l) => l !== ''),
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
        {error !== null && <span className="text-xs text-bad">{error}</span>}
      </div>
    </Card>
  )
}
