import { useQuery } from '@tanstack/react-query'
import { boardPrefix, data } from '../api.ts'
import { activityIcon } from '../activity.ts'
import { type ActivityStep, type LiveItem, liveItems, liveSentence } from '../live-activity.ts'
import { ActivityIcon, ActivityRow } from './ActivityRow.tsx'
import { AgentLabel } from './agent/AgentChip.tsx'
import { AgentOrb } from './agent/AgentOrb.tsx'
import { Section } from './kit.tsx'
import { TokenAmount } from './token/TokenAmount.tsx'
import { ItemGroup } from './ui/item.tsx'

/** The feed kind whose icon each Live row borrows when no agent is named. */
const ICON_KIND: Readonly<Record<LiveItem['kind'], string>> = {
  requested: 'request.opened',
  posted: 'job.published',
  hired: 'job.activated',
  delivered: 'job.submitted',
  completed: 'job.completed',
  rejected: 'job.rejected',
  disputed: 'job.disputed',
  ruled: 'job.ruled',
  cancelled: 'job.cancelled',
  expired: 'job.expired',
}

/**
 * Live, above the Jobs list: the board's latest steps and new requests, refreshed every 20 s, visible without
 * signing in. It stays hidden while there is nothing to show or the activity read fails; the list below never
 * depends on it.
 */
export function LiveStrip({
  titles,
  requests,
  posters,
}: {
  titles: ReadonlyMap<string, string>
  requests: Parameters<typeof liveItems>[1]
  posters: ReadonlyMap<string, string>
}) {
  const activity = useQuery({
    queryKey: ['activity', boardPrefix()],
    queryFn: () => data<{ steps: ActivityStep[] }>('activity?limit=20'),
    refetchInterval: 20_000,
    retry: false,
  })
  if (activity.isError) return null
  const items = liveItems(activity.data?.steps ?? [], requests, titles, posters)
  if (items.length === 0) return null
  return (
    <Section
      title={
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="size-1.5 rounded-full bg-success-text motion-safe:animate-pulse" />
          Live
        </span>
      }
    >
      <ItemGroup>
        {items.map((item) => (
          <LiveRow key={item.key} item={item} />
        ))}
      </ItemGroup>
    </Section>
  )
}

function LiveRow({ item }: { item: LiveItem }) {
  const { agent, text } = liveSentence(item)
  const href = `${boardPrefix()}/${item.jobId === null ? `request/${item.requestId}` : `job/${item.jobId}`}`
  return (
    <ActivityRow
      media={
        item.agentId === null ? (
          <ActivityIcon icon={activityIcon(ICON_KIND[item.kind])} />
        ) : (
          <AgentOrb agentId={item.agentId} />
        )
      }
      label={`${agent ? `Agent ID ${item.agentId} ` : ''}${text}`}
      at={item.at}
      href={href}
    >
      <span className="motion-safe:animate-[view-in_0.32s_var(--ease-sheet)]">
        {agent && item.agentId !== null && (
          <span className="font-medium">
            <AgentLabel id={item.agentId} />{' '}
          </span>
        )}
        {text}
        {item.amount !== undefined && (
          <span className="text-muted-foreground">
            {' '}
            · <TokenAmount value={item.amount} token={item.token} />
          </span>
        )}
      </span>
    </ActivityRow>
  )
}
