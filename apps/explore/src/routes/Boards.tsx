import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ChevronRight, Plus } from 'lucide-react'
import { type BoardInfo, data } from '../api.ts'
import { Address, Badge, CopyButton, EmptyState, ErrorText, Group, ListRow, LoadingRows, PageTitle, Section, rowClass } from '../components/ui.tsx'
import { Monogram } from '../components/Wallet.tsx'

/** A board's MCP server, where an agent connects to work on it. */
export const boardMcpUrl = (b: { id: string; public?: boolean }) => `${window.location.origin}${b.public === true ? '' : `/b/${b.id}`}/mcp`

/** The drop-in widget's one line (ADR-0008). */
export const embedSnippet = (id: string, view?: string) =>
  `<script src="${window.location.origin}/embed.js" data-board="${id}"${view === undefined ? '' : ` data-view="${view}"`}></script>`

/** A label and a copyable value in mono, wrapping anywhere. */
export function CopyRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <ListRow className="items-start">
      <span className="grid min-w-0 flex-1 gap-1 py-0.5">
        <span className="text-[0.82rem] text-label-2">{label}</span>
        <code className="font-mono text-[0.8rem] leading-relaxed [overflow-wrap:anywhere]">{value}</code>
        {hint !== undefined && <span className="text-[0.78rem] text-label-3">{hint}</span>}
      </span>
      <CopyButton value={value} label={`Copy the ${label.toLowerCase()}`} />
    </ListRow>
  )
}

/** Every hosted board (ADR-0008): the public one and the tenants, each with its stacks, tokens and origins. */
export function BoardsPage() {
  const boards = useQuery({ queryKey: ['boards'], queryFn: () => data<{ boards: BoardInfo[] }>('boards'), refetchInterval: 60_000 })
  const list = boards.data?.boards ?? []
  return (
    <>
      <PageTitle>Boards</PageTitle>
      <p className="-mt-2 leading-relaxed text-label-2">
        A board is one host&apos;s marketplace: its own stacks, reward tokens, defaults and the origins that may embed it. Anyone signed in can create one.
      </p>
      <Link to="/boards/new" className="press inline-flex min-h-11 items-center justify-center gap-2 justify-self-start rounded-xl bg-tint px-4 text-[0.95rem] font-semibold text-on-tint sm:min-h-10">
        <Plus aria-hidden className="size-4" strokeWidth={2.6} />
        Create a board
      </Link>
      {boards.isLoading ? (
        <LoadingRows rows={3} />
      ) : boards.error !== null ? (
        <ErrorText>The board directory is unavailable right now: {(boards.error as Error).message}</ErrorText>
      ) : list.length === 0 ? (
        <EmptyState title="No boards yet">The first board created appears here.</EmptyState>
      ) : (
        list.map((b) => (
          <Section key={b.id}>
            <Group>
              {b.public ? (
                <Link to="/" className={rowClass({ inset: true, interactive: true })}>
                  <BoardHead board={b} />
                </Link>
              ) : (
                <Link to="/b/$boardId" params={{ boardId: b.id }} className={rowClass({ inset: true, interactive: true })}>
                  <BoardHead board={b} />
                </Link>
              )}
              {b.owner !== null && (
                <ListRow>
                  <span className="flex-1">Owner</span>
                  <Address value={b.owner} />
                </ListRow>
              )}
              {b.allowedOrigins.length > 0 && (
                <ListRow className="items-start">
                  <span className="shrink-0">Embeds from</span>
                  <span className="min-w-0 flex-1 text-right font-mono text-[0.8rem] text-label-2 [overflow-wrap:anywhere]">{b.allowedOrigins.join(', ')}</span>
                </ListRow>
              )}
              <CopyRow label="MCP server" value={boardMcpUrl(b)} />
              <CopyRow label="Embed" value={embedSnippet(b.id)} />
            </Group>
          </Section>
        ))
      )}
    </>
  )
}

function BoardHead({ board: b }: { board: BoardInfo }) {
  return (
    <>
      <Monogram seed={`board-${b.id}`} label={b.name.slice(0, 2).toUpperCase()} size="md" />
      <span className="grid min-w-0 flex-1 gap-1">
        <span className="truncate">
          <span className="font-medium">{b.name}</span>
          <span className="ml-2 font-mono text-[0.8rem] text-label-3">{b.public ? 'public board' : `/b/${b.id}`}</span>
        </span>
        <span className="flex flex-wrap gap-1.5">
          {b.stacks.map((s) => (
            <Badge key={s}>{s}</Badge>
          ))}
          {b.tokens.map((t) => (
            <Badge key={t.address} tone="info">
              {t.symbol}
            </Badge>
          ))}
          {b.drip && <Badge tone="success">MON drip</Badge>}
        </span>
      </span>
      <ChevronRight aria-hidden className="size-4 shrink-0 text-label-3" />
    </>
  )
}
