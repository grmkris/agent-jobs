import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@agent-jobs/sdk'
import { type Address, verifyTypedData, zeroAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentDirectory, type DirectoryPort } from './agent-directory.ts'
import { AgentSigning } from './agent-signing.ts'
import { AgentStore } from './agents.ts'
import { DirectoryError, DirectoryService } from './directory.ts'
import { migrateAgentSchema } from './agent-schema.ts'
import { fromNodeSqlite } from './store.ts'

const deployment = sdk.deployment('monad-testnet')
const context = { deployment, stack: sdk.stack(deployment, 'main'), publicClient: {} } as unknown as sdk.Ctx
const audience = 'https://testnet.hireling.xyz'
const operator: Address = '0x2222222222222222222222222222222222222222'
const databases: DatabaseSync[] = []
afterEach(() => { for (const database of databases.splice(0)) database.close() })

const ad = { serviceId: 'review', name: 'Code review', description: 'One pull request', inputs: 'A PR link', outputs: 'Review comments', turnaroundSeconds: 3600, price: { model: 'quote', amountBaseUnits: '0', token: zeroAddress } }

function fixture() {
  const key = privateKeyToAccount(generatePrivateKey())
  const board = new DatabaseSync(':memory:'), object = new DatabaseSync(':memory:')
  databases.push(board, object)
  let now = 1_800_000_000
  const clock = () => now
  const sql = fromNodeSqlite(board)
  migrateAgentSchema(sql)
  const agents = new AgentStore(sql, clock)
  agents.create({ id: 'lister', operator, privyUserId: 'did:privy:lister', name: 'Quill', registry: deployment.identity, chainId: deployment.chainId })
  agents.bindWallet('lister', 'lister-wallet', key.address)
  agents.bindRegistry('lister', '2013')
  let signed = 0
  const signing = new AgentSigning(sql, context, {
    signTypedData: async (_wallet, typedData) => { signed++; return key.signTypedData(JSON.parse(typedData)) },
    signAuthorization: async () => { throw new Error('unused') },
  }, clock)
  const service = new DirectoryService({
    sql: fromNodeSqlite(object), chainId: deployment.chainId, identityRegistry: deployment.identity, audience, agentId: '2013', now: clock,
    readIdentity: async () => ({ wallet: key.address, agentURI: 'data:application/json,{}' }),
    verify: async (address, record, signature) => verifyTypedData({ address, ...sdk.directoryTypedData(record), signature }),
  })
  const calls: string[] = []
  const port: DirectoryPort = {
    read: async () => { calls.push('read'); return service.read() },
    prepare: async (kind, payload) => { calls.push(`prepare:${kind}`); return service.prepare(kind, payload) },
    submit: async (record, signature) => { calls.push(`submit:${record.kind}`); return (await service.submit(record, signature)).agent },
  }
  const directory = new AgentDirectory({ agents, signing, audience, boardId: 'public', port })
  return { directory, service, port, calls, signedCount: () => signed, advance: (seconds: number) => { now += seconds } }
}

describe('a hosted agent listing itself', () => {
  it('enrolls in manual mode, then advertises for a day; a retry with the same key signs nothing again', async () => {
    const f = fixture()
    const listing = await f.directory.advertise('lister', 'list-1', ad)
    expect(listing).toMatchObject({ agentId: '2013', enrolled: true, ownership: 'verified', profile: { name: 'Quill', services: ['Code review'] }, ads: [{ serviceId: 'review', expiresAt: 1_800_000_000 + 86_400 }] })
    expect(f.calls).toEqual(['read', 'prepare:Enrollment', 'submit:Enrollment', 'prepare:ServiceAd', 'submit:ServiceAd'])
    expect(f.signedCount()).toBe(2)
    expect(await f.directory.advertise('lister', 'list-1', ad)).toEqual(listing)
    expect(f.signedCount()).toBe(2)
  })

  it('does not enroll again once listed, so a second ad keeps the first', async () => {
    const f = fixture()
    await f.directory.advertise('lister', 'list-1', ad)
    const both = await f.directory.advertise('lister', 'list-2', { ...ad, serviceId: 'audit', name: 'Audit' })
    expect(both.ads.map((a) => a.serviceId).toSorted()).toEqual(['audit', 'review'])
    expect(f.calls.filter((c) => c === 'prepare:Enrollment')).toHaveLength(1)
  })

  it('answers a finished ad from its journal, so a retry after the operator opted out does not enroll again (VV2-028)', async () => {
    const f = fixture()
    await f.directory.advertise('lister', 'list-1', ad)
    const second = await f.directory.advertise('lister', 'list-2', { ...ad, serviceId: 'audit', name: 'Audit' })
    await f.directory.withdraw('lister', 'leave-1', {})
    const signed = f.signedCount()
    expect(await f.directory.advertise('lister', 'list-2', { ...ad, serviceId: 'audit', name: 'Audit' })).toEqual(second)
    expect(await f.directory.withdraw('lister', 'leave-1', {})).toMatchObject({ enrolled: false })
    expect(f.signedCount()).toBe(signed)
    expect(await f.service.read()).toMatchObject({ enrolled: false, ads: [] })
  })

  it('takes one ad down, or leaves the directory with all of them', async () => {
    const f = fixture()
    await f.directory.advertise('lister', 'list-1', ad)
    await f.directory.advertise('lister', 'list-2', { ...ad, serviceId: 'audit', name: 'Audit' })
    expect((await f.directory.withdraw('lister', 'down-1', { serviceId: 'review' })).ads.map((a) => a.serviceId)).toEqual(['audit'])
    expect(await f.directory.withdraw('lister', 'leave-1', {})).toMatchObject({ enrolled: false, ads: [] })
  })

  it('prepares again when a record misses the directory window, at most three times', async () => {
    const f = fixture()
    let stale = 2
    const submit = f.port.submit
    f.port.submit = async (record, signature) => {
      if (stale-- > 0) throw new DirectoryError('forbidden', 'record is expired or outside its server-time validity window')
      return submit(record, signature)
    }
    expect((await f.directory.advertise('lister', 'list-1', ad)).enrolled).toBe(true)
    expect(f.calls.filter((c) => c === 'prepare:Enrollment')).toHaveLength(3)
    stale = 3
    await expect(f.directory.advertise('lister', 'list-2', { ...ad, serviceId: 'audit' })).rejects.toMatchObject({ code: 'forbidden', reason: 'directory-forbidden', retry: 'new-key' })
  })

  it('refuses an ad the directory would refuse before starting an operation, and a key reused for another ad', async () => {
    const f = fixture()
    await expect(f.directory.advertise('lister', 'bad', { ...ad, serviceId: 'Not A Slug' })).rejects.toMatchObject({ code: 'invalid', retry: 'new-key' })
    expect(f.calls).toEqual([])
    await f.directory.advertise('lister', 'list-1', ad)
    await expect(f.directory.advertise('lister', 'list-1', { ...ad, name: 'Other' })).rejects.toMatchObject({ reason: 'operation-key-reused' })
  })
})
