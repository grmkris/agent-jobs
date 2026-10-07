import { describe, expect, it } from 'vitest'
import type { TaskIndexEntry } from '../api.ts'
import { lifecycleInput, phaseOf } from './Phase.tsx'

const task = {
  jobId: '60',
  mode: 'hire',
  creator: '0x1111',
  approver: '0x1111',
  workerBond: '0',
  deliveryDeadline: 100,
} as unknown as TaskIndexEntry

describe('missing chain facts', () => {
  it('cannot derive a lifecycle transition from a published board row', () => {
    expect(lifecycleInput(undefined, task)).toBeNull()
    expect(phaseOf(undefined, task, undefined, 200)).toBeNull()
  })
  it('still distinguishes an unpublished draft from a missing published status', () => {
    expect(lifecycleInput(undefined, { ...task, jobId: null })?.status).toBe('awaiting-publish')
  })
})
