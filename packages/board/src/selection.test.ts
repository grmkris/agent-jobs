import { describe, expect, it, vi } from 'vitest'
import { creatorSelectionProjection, type SignedSelectionRecord } from './selection.ts'

const worker = '0x1111111111111111111111111111111111111111'
const row = (over: Partial<SignedSelectionRecord> = {}): SignedSelectionRecord => ({
  nonce: '1', application_id: 'app-1', worker, agent_id: '61', activate_by: 1_100,
  signature: '0x1234', created_at: 10, application_worker: worker, application_agent_id: '61', ...over,
})
const open = { status: 'open', provider: null, listingMatchesOffer: true } as const
const project = (rows: SignedSelectionRecord[], now = 1_000, verify = async () => true) => creatorSelectionProjection(rows, open, now, 1_200, verify)

describe('creator selection projection', () => {
  it('returns signed metadata but no signature, nonce or worker address', async () => {
    expect(await project([row()])).toEqual([{ state: 'signed', applicationId: 'app-1', agentId: '61', activateBy: 1_100 }])
  })

  it('allows the exact activation cutoff and expires strictly after it', async () => {
    expect((await project([row()], 1_100))[0]?.state).toBe('signed')
    expect((await project([row()], 1_101))[0]?.state).toBe('expired')
  })

  it('keeps all signed applications and ignores a newer unsigned selection', async () => {
    expect(await project([row(), row({ application_id: 'app-2', nonce: '2', created_at: 20 }), row({ nonce: '3', created_at: 30, signature: null })]))
      .toMatchObject([{ applicationId: 'app-2', state: 'signed' }, { applicationId: 'app-1', state: 'signed' }])
  })

  it('does not hide an earlier still-valid selection behind a newer expired row', async () => {
    expect(await project([row(), row({ nonce: '2', application_id: 'app-2', activate_by: 999, created_at: 20 })]))
      .toMatchObject([{ applicationId: 'app-2', state: 'expired' }, { applicationId: 'app-1', state: 'signed' }])
  })

  it.each([
    { application_worker: null }, { application_agent_id: '62' }, { application_worker: '0x2222222222222222222222222222222222222222' },
    { worker: 'invalid' }, { agent_id: '0' }, { nonce: 'invalid' }, { signature: '0x' }, { activate_by: 1_200 }, { activate_by: NaN },
  ])('fails closed for malformed or mismatched selection %o', async (change) => {
    const verify = vi.fn(async () => true)
    expect((await project([row(change)], 1_000, verify))[0]?.state).toBe('invalid')
    expect(verify).not.toHaveBeenCalled()
  })

  it('reports revoked nonces, rotated wallets and revoked signatures as invalid', async () => {
    expect((await project([row()], 1_000, async () => false))[0]?.state).toBe('invalid')
  })

  it('reports read/verification failure as unavailable, not valid or invalid', async () => {
    expect((await project([row()], 1_000, async () => { throw new Error('RPC unavailable') }))[0]?.state).toBe('unavailable')
  })

  it.each(['active', 'submitted', 'cancelled', 'completed', 'expired'])('has no pending projection for %s jobs', async (status) => {
    expect(await creatorSelectionProjection([row()], { ...open, status }, 1_000, 1_200, async () => true)).toEqual([])
  })

  it.each([{ listingMatchesOffer: false }, { listingMatchesOffer: null }, { provider: worker }])('requires confirmed open chain facts %o', async (change) => {
    expect((await creatorSelectionProjection([row()], { ...open, ...change }, 1_000, 1_200, async () => true))[0]?.state).toBe('invalid')
  })
})
