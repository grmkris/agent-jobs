/** Real private filesystem saves; no in-memory persistence substitute. */
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type DemandOperation, abandonDemandOperation, openDemandStore } from '../scripts/demand-bot-store.ts'
import { carryReservations, commitSpend, reserveSpend, templateForSequence } from './demand-bot.ts'

const operation = (): DemandOperation => ({
  id: 'demand-0', sequence: 0,
  intent: { creator: '0x0000000000000000000000000000000000000001', token: '0x0000000000000000000000000000000000000002', arbitrator: '0x0000000000000000000000000000000000000003', template: templateForSequence(0), title: 'test', brief: 'test', deliveryDeadline: 4000, quoteDeadline: 2800, windows: { reviewSeconds: 3600, disputeSeconds: 3600, arbitrationSeconds: 43200 } },
  request: { requestId: 'fbf0e1288716ad34', requestHash: `0x${'1'.repeat(64)}` },
  prepared: { taskId: '5b6bb5e461f9e85f', applicationId: 'saved-application', termsHash: `0x${'2'.repeat(64)}`, transactions: [] },
})

describe('private demand persistence', () => {
  it('retains the abandoned operation and releases only its reservation across every carried day', () => {
    const path = mkdtempSync(join(tmpdir(), 'sidequest-demand-'))
    try {
      const store = openDemandStore(path, 'pinned-policy', 1)
      const saved = operation()
      store.bot.operations.push(saved)
      reserveSpend(store.bot.spend, '2026-10-05', saved.id, 3_000_000n)
      reserveSpend(store.bot.spend, '2026-10-05', 'other', 2_000_000n)
      commitSpend(store.bot.spend, 'other', '2026-10-05')
      reserveSpend(store.bot.spend, '2026-10-05', 'pending', 1_000_000n)
      carryReservations(store.bot.spend, '2026-10-06')
      expect(abandonDemandOperation(store.state, store.bot, saved, 'verified no effect')).toBe(3_000_000n)
      store.save()
      const restart = openDemandStore(path, 'pinned-policy', 2)
      expect(restart.bot.operations[0]).toMatchObject({ closed: 'abandoned', request: saved.request, prepared: saved.prepared })
      expect(restart.bot.spend.committed).toEqual({ '2026-10-05': 2_000_000n })
      expect(restart.bot.spend.reserved).toEqual({ '2026-10-05': 1_000_000n, '2026-10-06': 1_000_000n })
      expect(abandonDemandOperation(restart.state, restart.bot, restart.bot.operations[0]!, 'verified no effect')).toBe(0n)
    } finally { rmSync(path, { recursive: true }) }
  })

  it.each(['send', 'receipt', 'published', 'selected'])('refuses to release a reservation with a possible %s effect', effect => {
    const path = mkdtempSync(join(tmpdir(), 'sidequest-demand-'))
    try {
      const store = openDemandStore(path, 'pinned-policy', 1)
      const saved = operation()
      reserveSpend(store.bot.spend, '2026-10-05', saved.id, 3_000_000n)
      if (effect === 'send') store.state.sends[`${saved.id}/publish/0`] = { raw: '0x01', hash: `0x${'3'.repeat(64)}`, nonce: 0, wallet: saved.intent.creator }
      if (effect === 'receipt') store.state.values[`receipt/${saved.id}/publish/0`] = { status: 'success' }
      if (effect === 'published') saved.jobId = 1n
      if (effect === 'selected') saved.selected = true
      expect(() => abandonDemandOperation(store.state, store.bot, saved, 'no effect')).toThrow('possible chain effect')
      expect(saved.closed).toBeUndefined()
      expect(store.bot.spend.reserved['2026-10-05']).toBe(3_000_000n)
    } finally { rmSync(path, { recursive: true }) }
  })

  it('restores cap reservations after restart and commits the actual receipt day atomically', () => {
    const path = mkdtempSync(join(tmpdir(), 'sidequest-demand-'))
    try {
      const original = openDemandStore(path, 'creator-and-policy', 1)
      reserveSpend(original.bot.spend, '2026-10-05', 'hire-1', 8_000_000n)
      original.save()
      const restart = openDemandStore(path, 'creator-and-policy', 2)
      carryReservations(restart.bot.spend, '2026-10-06')
      restart.save()
      const later = openDemandStore(path, 'creator-and-policy', 3)
      expect(() => reserveSpend(later.bot.spend, '2026-10-06', 'hire-2', 5_000_000n)).toThrow('cap')
      commitSpend(later.bot.spend, 'hire-1', '2026-10-06')
      later.save()
      expect(openDemandStore(path, 'creator-and-policy', 4).bot.spend.committed['2026-10-06']).toBe(8_000_000n)
      expect(statSync(join(path, 'journal.json')).mode & 0o777).toBe(0o600)
    } finally { rmSync(path, { recursive: true }) }
  })

  it('refuses a changed identity or policy without clearing the original journal', () => {
    const path = mkdtempSync(join(tmpdir(), 'sidequest-demand-'))
    try {
      const original = openDemandStore(path, 'pinned-policy', 1)
      reserveSpend(original.bot.spend, '2026-10-05', 'saved-hire', 12_000_000n)
      original.save()
      expect(() => openDemandStore(path, 'other-policy', 2)).toThrow('binding differs')
      expect(openDemandStore(path, 'pinned-policy', 2).bot.spend.reserved['2026-10-05']).toBe(12_000_000n)
    } finally { rmSync(path, { recursive: true }) }
  })
})
