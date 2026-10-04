import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import * as sdk from '@agent-jobs/sdk'
import { GrantStore } from './grants.ts'
import { fromNodeSqlite } from './store.ts'

const d = sdk.deployment('monad-testnet')
const ctx = { deployment: d, stack: sdk.stack(d, 'main') }
describe('agent grant store', () => {
  it('persists one immutable template, confirms its delegator signature, and survives restart', async () => {
    const db = new DatabaseSync(':memory:')
    const store = new GrantStore(fromNodeSqlite(db), ctx)
    const account = (await import('viem/accounts')).privateKeyToAccount(`0x${'11'.repeat(32)}`)
    const operator = account.address
    const spec = { kind: 'registration' as const, delegator: operator, salt: 9n, start: 1_800_000_000 }
    const prepared = store.prepare(operator, spec)
    const valid = await account.signTypedData(JSON.parse(prepared.typedData))
    const confirmed = await store.confirm(prepared.hash, valid)
    expect(confirmed).toMatchObject({ delegation_hash: prepared.hash, status: 'live', signature: valid })
    expect(store.signed(prepared.hash).signature).toBe(valid)
    const stranger = (await import('viem/accounts')).privateKeyToAccount(`0x${'22'.repeat(32)}`)
    await expect(store.confirm(prepared.hash, await stranger.signTypedData(JSON.parse(prepared.typedData)))).rejects.toThrow('not the delegator')
    expect(new GrantStore(fromNodeSqlite(db), ctx).signed(prepared.hash).signature).toBe(valid)
    store.stop(prepared.hash)
    expect(() => store.signed(prepared.hash)).toThrow('not live')
    db.close()
  })
})
