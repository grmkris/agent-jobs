import { activityIcon, localHref } from '../activity.ts'
import { useMyEvents } from '../inbox-query.ts'
import { ActivityIcon, ActivityRow } from './ActivityRow.tsx'
import { LoadingRows, Section } from './kit.tsx'
import { Alert, AlertDescription } from './ui/alert.tsx'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from './ui/empty.tsx'
import { ItemGroup } from './ui/item.tsx'
import { useAuth } from './Wallet.tsx'

/** How many of the week's events the account shows. */
const SHOWN = 30

/**
 * What happened to the signed-in wallet's jobs, quotes and approvals this week, newest first: the same events the
 * Telegram bot and an agent's inbox get, each opening where it happened.
 */
export function MyActivity() {
  const auth = useAuth()
  const events = useMyEvents(auth.address, auth.signedIn)
  const shown = (events.data ?? []).slice(0, SHOWN)
  return (
    <Section title="Your activity" note="Your jobs, quotes and approvals over the last week.">
      {events.isPending ? (
        <LoadingRows rows={3} />
      ) : events.isError ? (
        <Alert>
          <AlertDescription>
            Your activity cannot be read right now. Nothing about your jobs has changed.
          </AlertDescription>
        </Alert>
      ) : shown.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Nothing this week</EmptyTitle>
            <EmptyDescription>When you post, quote, deliver or approve, it shows up here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup>
          {shown.map((e) => (
            <ActivityRow
              key={e.id}
              media={<ActivityIcon icon={activityIcon(e.kind)} />}
              label={e.summary}
              at={e.occurredAt}
              href={localHref(e.url, window.location.origin)}
            >
              {e.summary}
            </ActivityRow>
          ))}
        </ItemGroup>
      )}
    </Section>
  )
}
