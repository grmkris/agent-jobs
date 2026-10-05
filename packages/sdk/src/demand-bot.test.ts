import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { DEMAND_DAILY_CAP, chooseCheapestQuote, carryReservations, commitSpend, createDailySpend, parseMUsdAmount, reserveSpend, templateForSequence, utcDay } from './demand-bot.ts'
import { demandArtifactUrl, demandDescriptorHash, latestDemandTestPassed, validDemandImage } from './demand-bot-review.ts'

const token = getAddress('0x0000000000000000000000000000000000000001')

describe('demand bot policy', () => {
  it('alternates image and code without backfill', () => {
    expect(templateForSequence(0).kind).toBe('image')
    expect(templateForSequence(1).kind).toBe('code')
    expect(templateForSequence(2).kind).toBe('image')
  })

  it('uses exact mUSD decimals and rejects malformed amounts', () => {
    expect(parseMUsdAmount('1.25')).toBe(1_250_000n)
    expect(() => parseMUsdAmount('1.0000001')).toThrow()
    expect(() => parseMUsdAmount('0')).toThrow()
  })

  it('selects the cheapest valid quote and refuses another token', () => {
    const quotes = [
      { quoteId: 'slow', worker: token, agentId: '2', token, symbol: 'mUSD', amount: '3', quoteHash: '0x02' },
      { quoteId: 'cheap', worker: token, agentId: '1', token, symbol: 'mUSD', amount: '2', quoteHash: '0x01' },
      { quoteId: 'wrong-token', worker: token, agentId: '3', token: getAddress('0x0000000000000000000000000000000000000002'), symbol: 'mEUR', amount: '0.1', quoteHash: '0x03' },
    ]
    expect(chooseCheapestQuote(quotes, token, quote => quote.quoteId !== 'slow').quoteId).toBe('cheap')
    expect(() => chooseCheapestQuote(quotes, getAddress('0x0000000000000000000000000000000000000002'), () => true)).toThrow()
  })

  it('reserves once, carries pending work across UTC rollover, and commits on receipt day', () => {
    const spend = createDailySpend()
    reserveSpend(spend, '2026-10-05', 'op', 4_000_000n)
    reserveSpend(spend, '2026-10-05', 'op', 4_000_000n)
    expect(() => reserveSpend(spend, '2026-10-05', 'other', 8_100_000n)).toThrow()
    carryReservations(spend, '2026-10-06')
    expect(spend.reserved['2026-10-06']).toBe(4_000_000n)
    commitSpend(spend, 'op', '2026-10-06')
    expect(spend.committed['2026-10-06']).toBe(4_000_000n)
    expect(spend.reserved['2026-10-05']).toBeUndefined()
    expect(() => reserveSpend(spend, '2026-10-06', 'over-cap', 8_000_001n)).toThrow()
  })

  it('keeps the UTC boundary explicit', () => {
    expect(utcDay(Date.parse('2026-10-05T23:59:59Z') / 1000)).toBe('2026-10-05')
    expect(utcDay(Date.parse('2026-10-06T00:00:00Z') / 1000)).toBe('2026-10-06')
    expect(DEMAND_DAILY_CAP).toBe(12_000_000n)
  })

  it('requires the newest exact test check to pass', () => {
    expect(latestDemandTestPassed([
      { id: 2, name: 'test', head_sha: 'a'.repeat(40), status: 'completed', conclusion: 'failure', app: { slug: 'github-actions' } },
      { id: 1, name: 'test', head_sha: 'a'.repeat(40), status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } },
    ], 'a'.repeat(40))).toBe(false)
  })

  it('rejects malformed images before a check can approve them', () => {
    expect(validDemandImage(new Uint8Array(100), 'image/png')).toBe(false)
    expect(validDemandImage(new Uint8Array(100), 'image/jpeg')).toBe(false)
  })

  it('refuses private hosts, moving branches and credential-bearing artifact URLs', () => {
    for (const url of ['https://localhost/a.png', 'https://127.0.0.1/a.png', 'https://raw.githubusercontent.com/grmkris/hireling-demo-deliveries/main/a.png', `https://user:password@raw.githubusercontent.com/grmkris/hireling-demo-deliveries/${'a'.repeat(40)}/a.png`]) expect(() => demandArtifactUrl(url)).toThrow()
    expect(demandArtifactUrl(`https://raw.githubusercontent.com/grmkris/hireling-demo-deliveries/${'a'.repeat(40)}/a.png`).host).toBe('raw.githubusercontent.com')
  })

  it('binds an artifact URL and exact commit into the submission hash', () => {
    const descriptor = { kind: 'git' as const, url: 'https://github.com/grmkris/hireling-demo-deliveries', ref: 'demo', sha: 'a'.repeat(40) }
    expect(demandDescriptorHash(descriptor)).not.toBe(demandDescriptorHash({ ...descriptor, sha: 'b'.repeat(40) }))
  })

  it('counts a recovered receipt in its actual prior UTC day and preserves other pending reservations', () => {
    const spend = createDailySpend()
    reserveSpend(spend, '2026-10-05', 'first', 5_000_000n)
    reserveSpend(spend, '2026-10-05', 'second', 6_000_000n)
    carryReservations(spend, '2026-10-06')
    carryReservations(spend, '2026-10-06')
    expect(spend.reserved['2026-10-06']).toBe(11_000_000n)
    commitSpend(spend, 'first', '2026-10-05')
    expect(spend.committed['2026-10-05']).toBe(5_000_000n)
    expect(spend.reserved['2026-10-06']).toBe(6_000_000n)
    expect(() => reserveSpend(spend, '2026-10-06', 'second', 4_000_000n)).toThrow('differs')
  })
})
