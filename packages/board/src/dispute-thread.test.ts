import { describe, expect, it, vi } from 'vitest'
import type { DisputeBundle } from './arbitration.ts'
import { bundleHash } from './arbitration.ts'
import { MAX_DISPUTE_THREAD, withDisputeThread } from './dispute-thread.ts'

const address = '0x1111111111111111111111111111111111111111'
const bundle: DisputeBundle = {
  taskId: 'task-1',
  jobId: '1',
  stack: 'main',
  chainId: 10143,
  evaluator: address,
  arbitrator: address,
  disputedAt: 100,
  arbitrationEndsAt: 1000,
  offer: {
    title: 'Work',
    brief: 'Frozen work',
    acceptanceCriteria: ['Done'],
    reward: '1',
    token: address,
    creatorBond: '0',
    workerBond: '0',
    deliveryDeadline: 90,
  },
  rejection: { violation: 'None', reasonHash: '0x', reasonText: null },
  submission: { deliverableHash: null, submittedAt: null, timely: false },
  deliverable: null,
  evidence: [],
  statements: [],
}
const entry = (id: number) => ({
  id,
  author: address,
  roles: [],
  text: `message-${id}`,
  hidden: false,
  replyTo: null,
  at: id,
})

describe('dispute thread context', () => {
  it('keeps the thread outside the frozen bundle hash and bounds it to the newest entries', async () => {
    const result = await withDisputeThread(bundle, async () =>
      Array.from({ length: MAX_DISPUTE_THREAD + 2 }, (_, index) => entry(index + 1)),
    )
    expect(result.thread).toHaveLength(MAX_DISPUTE_THREAD)
    expect(result.thread[0]?.id).toBe(3)
    expect(result.bundleHash).toBe(bundleHash(bundle))
    expect(result.bundleHash).toBe((await withDisputeThread(bundle)).bundleHash)
    expect(result.bundle).not.toHaveProperty('thread')
  })

  it('uses an empty thread when the reader fails', async () => {
    const result = await withDisputeThread(
      bundle,
      vi.fn(async () => Promise.reject(new Error('offline'))),
    )
    expect(result.thread).toEqual([])
  })
})
