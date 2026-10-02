import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { AdmissionRateLimits, WRITE_LIMITS, UPGRADE_LIMITS } from './admission-rate.ts'
import { fromNodeSqlite } from './store.ts'

const fixture = () => {
  const db = new DatabaseSync(':memory:')
  const sql = fromNodeSqlite(db)
  return { sql, limits: new AdmissionRateLimits(sql) }
}

test('wallet cap survives re-instantiation, other IPs and different tools; resets at expiry', () => {
  const { sql, limits } = fixture()
  for (let n = 0; n < WRITE_LIMITS.wallet; n++) expect(limits.consume('0xAbC', `ip-${n}`, 'create_task', 1000)).toEqual({ ok: true })
  expect(new AdmissionRateLimits(sql).consume('0xabc', 'new-ip', 'submit_quote', 1059)).toMatchObject({ ok: false, retryAfter: 1 })
  expect(limits.consume('other-wallet', 'new-ip', 'submit_quote', 1059)).toEqual({ ok: true })
  expect(limits.consume('0xabc', 'new-ip', 'submit_quote', 1060)).toEqual({ ok: true })
})

test('IP cap spans wallets, tools and anonymous auth; refusal does not debit other counters', () => {
  const { limits } = fixture()
  for (let n = 0; n < WRITE_LIMITS.ip; n++) expect(limits.consume(`wallet-${n}`, 'shared-ip', 'create_task', 1000)).toEqual({ ok: true })
  expect(limits.consume(undefined, 'shared-ip', 'auth_login', 1000).ok).toBe(false)
  expect(limits.consume('new-wallet', 'shared-ip', 'submit_quote', 1000).ok).toBe(false)
  for (let n = 0; n < WRITE_LIMITS.wallet; n++) expect(limits.consume('new-wallet', 'other-ip', 'submit_quote', 1000).ok).toBe(true)
})

test('upgrade cap persists across minute windows without blocking normal recovery', () => {
  const { sql, limits } = fixture()
  for (let n = 0; n < UPGRADE_LIMITS.wallet; n++) expect(limits.consume('wallet', 'ip', 'upgrade_account', 1000 + n * 60).ok).toBe(true)
  expect(new AdmissionRateLimits(sql).consume('wallet', 'another-ip', 'upgrade_account', 2000).ok).toBe(false)
  expect(limits.consume('wallet', 'ip', 'report_transaction', 2000).ok).toBe(true)
  expect(limits.consume('wallet', 'ip', 'upgrade_account', 1000 + UPGRADE_LIMITS.window).ok).toBe(true)
})

test('expired counters are pruned as requests arrive', () => {
  const { sql, limits } = fixture()
  limits.consume('wallet', 'old-ip', 'create_task', 1000)
  limits.consume('other', 'new-ip', 'create_task', 1060)
  expect(sql.all('SELECT key FROM admission_counters ORDER BY key')).toEqual([{ key: 'write:ip:new-ip' }, { key: 'write:wallet:other' }])
})
