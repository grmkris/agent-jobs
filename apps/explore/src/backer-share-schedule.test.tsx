import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import * as api from './api.ts'
import { useBackerShareSchedule, type BackerShareSchedule } from './backer-share.ts'
import { MiningShareCopy } from './components/agent/BackingStrip.tsx'
import { BackerShareHelp } from './components/agent/ProfileEditor.tsx'

const schedule: BackerShareSchedule = {
  agentId: '7',
  current: { bps: 5000, epoch: 3, since: 1000 },
  next: { bps: 5000, epoch: 4 },
  pendingCut: { bps: 1000, appliesFromEpoch: 6, at: 900 },
  unstakeDelay: 259200,
  epochSeconds: 3600,
}
afterEach(() => vi.restoreAllMocks())

function hook(agentId: string | undefined) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const captured: { result?: ReturnType<typeof useBackerShareSchedule> } = {}
  function View() {
    captured.result = useBackerShareSchedule(agentId)
    return null
  }
  renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <View />
    </QueryClientProvider>,
  )
  if (captured.result === undefined) throw new Error('hook did not render')
  return { client, result: captured.result }
}

it('reads the public indexed schedule by agent and keeps a pending cut intact', async () => {
  const read = vi.spyOn(api, 'data').mockResolvedValue(schedule)
  const { client, result } = hook('7')
  expect((await result.refetch()).data).toEqual(schedule)
  expect(read).toHaveBeenCalledWith('backer-share/7')
  expect(client.getQueryData(['backer-share-schedule', '7'])).toEqual(schedule)
  client.clear()
})
it('keeps a failed history read unavailable instead of defaulting it to zero', async () => {
  vi.spyOn(api, 'data').mockRejectedValue(new Error('history unavailable'))
  const { client, result } = hook('7')
  await result.refetch()
  expect(client.getQueryState(['backer-share-schedule', '7'])?.status).toBe('error')
  expect(client.getQueryData(['backer-share-schedule', '7'])).toBeUndefined()
  client.clear()
})
it('does not read a schedule until there is a valid agent', () => {
  const read = vi.spyOn(api, 'data')
  for (const id of [undefined, 'bad']) {
    const { client, result } = hook(id)
    expect(result.fetchStatus).toBe('idle')
    client.clear()
  }
  expect(read).not.toHaveBeenCalled()
})
it('shows the protected current share and the pending cut with its epoch', () => {
  const html = renderToStaticMarkup(<MiningShareCopy schedule={schedule} />)
  expect(html).toContain('Backers get 50 % of this agent&#x27;s work-mining rewards this epoch')
  expect(html).toContain('Cut to 10 % from epoch 6 (after the unstake delay)')
})
it('shows a raise next epoch even when this epoch shares zero', () => {
  const html = renderToStaticMarkup(
    <MiningShareCopy
      schedule={{
        ...schedule,
        current: { ...schedule.current, bps: 0 },
        next: { bps: 5000, epoch: 4 },
        pendingCut: null,
      }}
    />,
  )
  expect(html).toContain('this epoch')
  expect(html).toContain('· 50 % from epoch 4')
})
it('keeps failed schedules visibly unknown', () => {
  expect(renderToStaticMarkup(<MiningShareCopy schedule={undefined} />)).toContain('mining share is unavailable')
})
it.each([
  [259200, '3 days'],
  [1209600, '14 days'],
])('explains next-epoch raises and delayed cuts for %i seconds', (delay, label) => {
  const html = renderToStaticMarkup(<BackerShareHelp delay={delay} />)
  expect(html).toContain('raise applies from the next mining epoch')
  expect(html).toContain(`cut reaches backers after the ${label} unstake delay`)
})

it('names a pending cut to zero as a percentage', () => {
  const html = renderToStaticMarkup(
    <MiningShareCopy schedule={{ ...schedule, pendingCut: { bps: 0, appliesFromEpoch: 6, at: 900 } }} />,
  )
  expect(html).toContain('Cut to 0 % from epoch 6')
})
