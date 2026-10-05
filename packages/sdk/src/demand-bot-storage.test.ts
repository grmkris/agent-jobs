/** Real private filesystem saves; no in-memory persistence substitute. */
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDemandStore } from '../scripts/demand-bot-store.ts'
import { carryReservations, commitSpend, reserveSpend } from './demand-bot.ts'

describe('private demand persistence', () => {
  it('restores cap reservations after restart and commits the actual receipt day atomically', () => {
    const path = mkdtempSync(join(tmpdir(), 'hireling-demand-'))
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
    const path = mkdtempSync(join(tmpdir(), 'hireling-demand-'))
    try {
      const original = openDemandStore(path, 'pinned-policy', 1)
      reserveSpend(original.bot.spend, '2026-10-05', 'saved-hire', 12_000_000n)
      original.save()
      expect(() => openDemandStore(path, 'other-policy', 2)).toThrow('binding differs')
      expect(openDemandStore(path, 'pinned-policy', 2).bot.spend.reserved['2026-10-05']).toBe(12_000_000n)
    } finally { rmSync(path, { recursive: true }) }
  })
})
