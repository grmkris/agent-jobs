/**
 * Stopping a managed agent's access ends its event webhooks (V1.1 WS5), through agentManagement itself:
 * real SQLite for the management object and a D1 binding shim over node:sqlite.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { expect, test } from 'vitest'
import * as sdk from '@sidequest/sdk'
import { AgentStore, fromNodeSqlite } from '@sidequest/board'
import { fromNodeSqlite as asyncSqlite, stmt } from '@sidequest/indexer'
import type { Address } from 'viem'
import { agentManagement } from '../src/agent-management.ts'
import { migrateWebhooks } from '../src/webhooks.ts'

const operator = `0x${'11'.repeat(20)}` as Address
const wallet = `0x${'22'.repeat(20)}` as Address
const neighbour = `0x${'44'.repeat(20)}`
const registry = `0x${'33'.repeat(20)}` as Address

function d1(db: DatabaseSync, failing = { batch: false }) {
  return {
    prepare: (query: string) => ({
      bind: (...values: SQLInputValue[]) => ({
        query,
        values,
        all: async () => ({ results: db.prepare(query).all(...values) }),
      }),
    }),
    batch: async (statements: Array<{ query: string; values: SQLInputValue[] }>) => {
      if (failing.batch) throw new Error('D1 unavailable')
      db.exec('BEGIN')
      try {
        for (const s of statements) db.prepare(s.query).run(...s.values)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
}

async function fixture() {
  const sql = fromNodeSqlite(new DatabaseSync(':memory:'))
  const agents = new AgentStore(sql, () => 1000)
  agents.create({ id: 'one', operator, privyUserId: 'did:privy:test', name: 'one', registry, chainId: 10143 })
  agents.bindWallet('one', 'wallet-one', wallet)
  for (const state of ['upgraded', 'grants-live', 'registered', 'active'] as const) agents.advance('one', state)
  const database = new DatabaseSync(':memory:')
  const events = asyncSqlite(database)
  await migrateWebhooks(events)
  await events.batch(
    [wallet, neighbour].map((principal, index) =>
      stmt(
        `INSERT INTO event_subscriptions
    (id, principal, chain_id, name, args_json, url, secret, cursor_seq, status, refresh_before, failures, next_attempt_at, created_at, updated_at)
    VALUES (?, ?, 10143, 'sidequest.inbox', '{}', 'https://hooks.example/in', 'whsec_x', 0, 'active', 99999, 0, 0, 1000, 1000)`,
        `sub_${index}`,
        principal.toLowerCase(),
      ),
    ),
  )
  const failing = { batch: false }
  const manage = (action: string, bindings: Record<string, unknown> = { Database: d1(database, failing) }) =>
    agentManagement({
      request: { action, id: 'one', body: {} },
      sql,
      context: sdk.context('monad-testnet', 'main', 'http://127.0.0.1:9'),
      operator,
      bindings,
      relayKey: '0x',
      rpcUrl: '',
      now: () => 1000,
      execute: async () => {
        throw new Error('unexpected execute')
      },
    })
  const status = async () =>
    Object.fromEntries(
      (await events.all<{ id: string; status: string }>('SELECT id, status FROM event_subscriptions ORDER BY id')).map(
        (row) => [row.id, row.status],
      ),
    )
  const revoked = async () =>
    (await events.all<{ principal: string }>('SELECT principal FROM event_revoked_principals')).map(
      (row) => row.principal,
    )
  return { agents, manage, status, revoked, failing }
}

test("stop-access terminates the agent's subscriptions and leaves other principals alone", async () => {
  const f = await fixture()
  await f.manage('stop-access')
  expect(f.agents.get('one').state).toBe('revoked')
  expect(await f.status()).toEqual({ sub_0: 'terminated', sub_1: 'active' })
  expect(await f.revoked()).toEqual([wallet])
})

test('access stops first: a failed webhook teardown leaves access stopped and a repeat finishes it (VV2-030)', async () => {
  const f = await fixture()
  f.failing.batch = true
  await expect(f.manage('stop-access')).rejects.toMatchObject({ code: 'unavailable' })
  expect(f.agents.get('one').state).toBe('revoked')
  expect(await f.status()).toEqual({ sub_0: 'active', sub_1: 'active' })
  f.failing.batch = false
  await f.manage('stop-access')
  expect(await f.status()).toEqual({ sub_0: 'terminated', sub_1: 'active' })
  expect(await f.revoked()).toEqual([wallet])
})

test('stop-access still stops hosted access when no D1 binding is present', async () => {
  const f = await fixture()
  await f.manage('stop-access', {})
  expect(f.agents.get('one').state).toBe('revoked')
  expect(await f.status()).toEqual({ sub_0: 'active', sub_1: 'active' })
})
