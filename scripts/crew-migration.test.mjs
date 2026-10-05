import assert from 'node:assert/strict'
import { test } from 'node:test'
import { migrateCrewJournal } from './crew-migration.mjs'

const parameters = { kind: 'workers', previousBinding: 'g1b', nextBinding: 'g1c', oldHolding: 'old', newHolding: 'new', at: 'now' }
const state = {
  binding: 'g1b',
  values: {
    'canvas/entries': { request: { phase: 'active', signature: 'saved' } },
    'studio/entries': { request: { phase: 'quoted' } },
    'canvas/daily': { today: { quotes: ['request'], deliveries: ['request'] } },
    'canvas/wallet': 'wallet',
    'receipt/activation': { transactionHash: 'hash' },
  },
  sends: { activation: { raw: 'signed', hash: 'hash', nonce: 4, wallet: 'wallet' } },
}

test('archives old jobs and preserves signed sends, identities, receipts and daily reservations', () => {
  const before = structuredClone(state)
  const next = migrateCrewJournal(state, parameters)
  assert.deepEqual(state, before)
  assert.deepEqual(next.sends, before.sends)
  assert.deepEqual(next.values['canvas/daily'], before.values['canvas/daily'])
  assert.deepEqual(next.values['receipt/activation'], before.values['receipt/activation'])
  assert.equal(next.values['canvas/wallet'], 'wallet')
  assert.deepEqual(next.values['deployment/archive/old'].entries.canvas, before.values['canvas/entries'])
  assert.deepEqual(next.values['canvas/entries'], {})
  assert.equal(next.values['deployment/holding'], 'new')
  assert.equal(migrateCrewJournal(next, parameters), next)
})

test('refuses an unknown binding or duplicate archive', () => {
  assert.throws(() => migrateCrewJournal({ ...state, binding: 'unknown' }, parameters), /binding/)
  assert.throws(() => migrateCrewJournal({ ...state, values: { 'deployment/archive/old': {} } }, parameters), /archived/)
})

test('moves only the held unused demand journal, keeping setup receipts and schedule', () => {
  const demand = { ...state, values: { bot: { version: 1, sequence: 0, nextRequestAt: 42, operations: [], spend: { committed: {}, reserved: {}, reservations: {} } } } }
  const next = migrateCrewJournal(demand, { ...parameters, kind: 'demand' })
  assert.deepEqual(next.values.bot, demand.values.bot)
  assert.deepEqual(next.sends, demand.sends)
  const active = structuredClone(demand)
  active.values.bot.sequence = 1
  assert.throws(() => migrateCrewJournal(active, { ...parameters, kind: 'demand' }), /unused/)
})
