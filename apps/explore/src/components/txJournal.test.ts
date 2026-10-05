import { describe, expect, it, vi } from 'vitest'
import { emptyJournal, initializeTxJournal, readTxJournal, txJournalKey, writeTxJournal, type JournalStorage } from './txJournal.ts'

const tx = { description: 'Top up', to: '0x1111111111111111111111111111111111111111' as const, data: '0x1234' as const, value: '0' as const, chainId: 10143 }
const fixture = () => {
  const values = new Map<string, string>()
  const storage: JournalStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: key => { values.delete(key) } }
  return { values, storage }
}
describe('durable wallet transaction journal', () => {
  it('refuses the wallet call when the pending record cannot be durably written', () => {
    const { storage } = fixture(), send = vi.fn()
    initializeTxJournal(storage, 'approval:1', [tx])
    const full = { ...storage, setItem: () => { throw new Error('quota exceeded') } }
    const key = txJournalKey('approval:1', [tx])
    const sendAfterPersistence = () => { writeTxJournal(full, key, { ...emptyJournal(), pending: 0 }); send() }
    expect(sendAfterPersistence).toThrow(/could not be saved/)
    expect(send).not.toHaveBeenCalled()
    expect(readTxJournal(storage, key, true)?.pending).toBeNull()
    expect(() => writeTxJournal({ ...storage, setItem: () => {} }, key, { ...emptyJournal(), pending: 0 })).toThrow(/could not be saved/)
  })
  it('treats a missing, unreadable or corrupt saved journal as unknown rather than idle', () => {
    const { storage, values } = fixture(), key = txJournalKey('approval:1', [tx])
    expect(readTxJournal(storage, key)).toBeNull()
    expect(() => readTxJournal(storage, key, true)).toThrow(/missing.*unknown/)
    expect(() => readTxJournal({ ...storage, getItem: () => { throw new Error('unavailable') } }, key)).toThrow(/unreadable.*unknown/)
    for (const raw of ['{', 'null', '{}', JSON.stringify({ ...emptyJournal(), hashes: ['not-a-hash'] })]) {
      values.set(key, raw)
      expect(() => readTxJournal(storage, key, true)).toThrow(/corrupt.*unknown/)
    }
  })
  it('never replaces a pending or broadcast journal while initializing an outer approval', () => {
    const { storage } = fixture(), key = txJournalKey('approval:1', [tx])
    const pending = { ...emptyJournal(), pending: 0, snapshot: { nonce: 7, block: '100' }, from: tx.to }
    writeTxJournal(storage, key, pending)
    initializeTxJournal(storage, 'approval:1', [tx])
    expect(readTxJournal(storage, key, true)).toEqual(pending)
  })
  it('retains no-effect receipts across reload and refuses corrupt failure history', () => {
    const { storage, values } = fixture(), key = txJournalKey('delegation:1', [tx])
    const hash = `0x${'ab'.repeat(32)}` as const
    const record = { ...emptyJournal(), hashes: [null], recorded: [false], effectFailures: [{ index: 0, hash, error: 'Not delegated' }] }
    writeTxJournal(storage, key, record)
    expect(readTxJournal(storage, key, true)).toEqual(record)
    for (const failure of [null, { index: -1, hash, error: 'Not delegated' }, { index: 0, hash: 'invalid', error: 'Not delegated' }, { index: 0, hash }]) {
      values.set(key, JSON.stringify({ ...record, effectFailures: [failure] }))
      expect(() => readTxJournal(storage, key, true)).toThrow(/corrupt.*unknown/)
    }
  })
})
