import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { type BoardInfo, data } from '../api.ts'
import { Address, Badge, Card } from '../components/ui.tsx'

/** Every hosted board (ADR-0008): the public one and the tenants, each with its stacks, tokens and origins. */
export function BoardsPage() {
  const boards = useQuery({ queryKey: ['boards'], queryFn: () => data<{ boards: BoardInfo[] }>('boards'), refetchInterval: 60_000 })
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-neutral-600">A board is one host's marketplace: its own stacks, reward tokens, defaults and the origins that may embed it. Anyone signed in can create one.</p>
        <Link to="/boards/new" className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700">Create a board</Link>
      </div>
      {boards.error !== null && <p className="text-sm text-red-600">{(boards.error as Error).message}</p>}
      <div className="grid gap-3">
        {(boards.data?.boards ?? []).map((b) => (
          <Card key={b.id}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                {b.public ? (
                  <Link to="/" className="font-medium hover:underline">{b.name}</Link>
                ) : (
                  <Link to="/b/$boardId" params={{ boardId: b.id }} className="font-medium hover:underline">{b.name}</Link>
                )}
                <span className="ml-2 font-mono text-xs text-neutral-500">/b/{b.id}</span>
                <div className="mt-1 flex flex-wrap gap-2">
                  {b.stacks.map((s) => <Badge key={s}>{s}</Badge>)}
                  {b.tokens.map((t) => <Badge key={t.address} tone="blue">{t.symbol}</Badge>)}
                  {b.drip && <Badge tone="green">MON drip</Badge>}
                </div>
              </div>
              <div className="text-right text-xs text-neutral-500">
                {b.owner !== null && <div>owner <Address value={b.owner} /></div>}
                {b.allowedOrigins.length > 0 && <div>embeds from {b.allowedOrigins.join(', ')}</div>}
                <div className="mt-1 font-mono">{`<script src="${window.location.origin}/embed.js" data-board="${b.id}"></script>`}</div>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  )
}
