import { expect, test } from 'vitest'
import {
  createOwnerAlerts,
  monitorP0,
  myagentOwnerMcp,
  myagentOwnerSender,
  ownerAlert,
  ownerOperationId,
} from '../src/alerts.ts'

test('fake myagent owner sink deduplicates and never sends when unconfigured', async () => {
  const sent: string[] = []
  const dispatcher = createOwnerAlerts({
    ownerConfigured: true,
    send: async (item) => {
      sent.push(item.id)
    },
  })
  const item = ownerAlert('indexer_lag', 'critical', 'checkpoint stalled', 'checkpoint age exceeded', 1)
  await expect(dispatcher.emit(item)).resolves.toBe('sent')
  await expect(dispatcher.emit(item)).resolves.toBe('deduplicated')
  expect(sent).toEqual([item.id])
  const disabled = createOwnerAlerts({
    ownerConfigured: false,
    send: async () => {
      throw new Error('must not call')
    },
  })
  await expect(disabled.emit(ownerAlert('admin_event', 'critical', 'unexpected upgrade', 'blocked'))).resolves.toBe(
    'disabled',
  )
})

test('all five P0 signal classes reach the fake owner sink without Telegram or user refusals', async () => {
  const sent: string[] = []
  const dispatcher = createOwnerAlerts({
    ownerConfigured: true,
    send: async (item) => {
      sent.push(item.kind)
    },
  })
  await monitorP0(
    {
      uptime: [{ id: 'api-health', consecutiveFailures: 2 }],
      indexer: { chainId: 143, healthy: false, lagBlocks: 1000, checkpointAgeSeconds: 1000 },
      publishes: [
        { operationId: 'op1', status: 'stuck', ageSeconds: 1000 },
        { operationId: 'refusal', status: 'refused', ageSeconds: 1000 },
      ],
      escrows: [
        { jobId: '7', eligible: true, overdueSeconds: 1000, owed: true },
        { jobId: '8', eligible: false, overdueSeconds: 1000, owed: false },
      ],
      adminEvents: [
        { transactionHash: '0xunexpected', expected: false },
        { transactionHash: '0xapproved', expected: true },
      ],
    },
    dispatcher.emit,
    123,
  )
  expect(sent).toEqual(['uptime', 'indexer_lag', 'failed_publish', 'stuck_escrow', 'admin_event'])
})

test('myagent sender has a fixed owner-only destination and stable operation id; transport is fake', async () => {
  const calls: Array<{ url: string; body: string }> = []
  const sender = myagentOwnerSender('synthetic-token', (async (url, init) => {
    calls.push({ url: String(url), body: String(init?.body) })
    return Response.json({
      result: { content: [{ type: 'text', text: JSON.stringify({ status: 'sent', messageId: 1 }) }] },
    })
  }) as typeof fetch)
  await sender(ownerAlert('uptime', 'critical', '<script>', 'route=health', 1))
  expect(calls[0]?.url).toBe(myagentOwnerMcp)
  expect(calls[0]?.body).toContain('sidequest_alert_')
  expect(calls[0]?.body).toContain('&lt;script&gt;')
  expect(calls[0]?.body).not.toContain('chatId')
})

test('operation ids obey the myagent protocol and remain stable across restart', async () => {
  const first = await ownerOperationId('indexer_lag:143')
  expect(first).toMatch(/^[a-zA-Z0-9_-]{1,100}$/)
  expect(await ownerOperationId('indexer_lag:143')).toBe(first)
  expect(await ownerOperationId('indexer_lag:10143')).not.toBe(first)
})

test.each(['unknown', 'retryable', 'rejected', 'completed'])(
  'does not call a %s delivery confirmed',
  async (status) => {
    const sender = myagentOwnerSender('synthetic-token', (async () =>
      Response.json({ result: { content: [{ type: 'text', text: JSON.stringify({ status }) }] } })) as typeof fetch)
    await expect(sender(ownerAlert('uptime', 'critical', 'route failed', 'route=health'))).rejects.toThrow(
      'not confirmed',
    )
  },
)

test('unknown sender outcome is not silently retried by the dispatcher', async () => {
  let calls = 0
  const dispatcher = createOwnerAlerts({
    ownerConfigured: true,
    send: async () => {
      calls++
      throw new Error('unknown')
    },
  })
  const item = ownerAlert('uptime', 'critical', 'route failed', 'route=health')
  await expect(dispatcher.emit(item)).rejects.toThrow('unknown')
  await expect(dispatcher.emit(item)).resolves.toBe('deduplicated')
  expect(calls).toBe(1)
})

test('a failed alert does not suppress independent incidents later in the batch', async () => {
  const attempted: string[] = []
  const dispatcher = createOwnerAlerts({
    ownerConfigured: true,
    send: async (item) => {
      attempted.push(item.kind)
      if (item.kind === 'uptime' || item.kind === 'failed_publish') throw new Error('unknown')
    },
  })
  const observations = {
    uptime: [{ id: 'health', consecutiveFailures: 2 }],
    indexer: { chainId: 143, healthy: false, lagBlocks: 1000, checkpointAgeSeconds: 1000 },
    publishes: [{ operationId: 'op1', status: 'failed' as const, ageSeconds: 1000 }],
    escrows: [{ jobId: '7', eligible: true, overdueSeconds: 1000, owed: true }],
    adminEvents: [{ transactionHash: '0xunexpected', expected: false }],
  }
  await expect(monitorP0(observations, dispatcher.emit, 123)).rejects.toThrow(
    '2 owner alert deliveries are unconfirmed',
  )
  expect(attempted).toEqual(['uptime', 'indexer_lag', 'failed_publish', 'stuck_escrow', 'admin_event'])
  await expect(monitorP0(observations, dispatcher.emit, 123)).resolves.toBeUndefined()
  expect(attempted).toHaveLength(5)
})
