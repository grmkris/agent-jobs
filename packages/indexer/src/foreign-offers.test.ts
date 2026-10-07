import { DatabaseSync } from 'node:sqlite'
import { canonicalJson, termsHash, type OfferTerms } from '@sidequest/board'
import { deployment } from '@sidequest/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { foreignOffer, hydrateForeignOffers, MAX_OFFER_FETCHES, verifyForeignOffer } from './foreign-offers.ts'
import { fromNodeSqlite, migrate, stmt } from './store.ts'
import { contractsFromDeployment } from './events.ts'
import { runOnce } from './indexer.ts'
import { networkStats } from './read.ts'

const d = deployment('monad-testnet'),
  chainId = d.chainId
const own = 'https://sidequest.exchange',
  host = 'https://dev.sidequest.exchange',
  unknown = 'https://unknown.example'
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
const offer = (taskId = 'foreign'): OfferTerms => ({
  v: 2,
  mode: 'hire',
  taskId,
  projectId: null,
  policyVersion: null,
  title: 'Build a shared board',
  brief: 'Read the frozen offer.',
  acceptanceCriteria: ['Works on every board'],
  deployment: { chainId, core: d.core, ...d.stacks.main!, identity: d.identity },
  token: d.rewardTokens[0]!,
  reward: 100n,
  creatorBond: 0n,
  workerBond: 0n,
  deliveryDeadline: 10000,
  creator: d.admin,
  approver: d.admin,
  arbitrator: d.arbitrator,
  windows: { reviewSeconds: 3600, disputeSeconds: 3600, arbitrationSeconds: 43200 },
  eligibility: null,
  evidencePolicy: null,
  quote: null,
  salt: `0x${'01'.repeat(32)}`,
})
async function fixture(count = 1) {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const sql = fromNodeSqlite(db)
  await migrate(sql)
  const offers = Array.from({ length: count }, (_, i) => offer(`task-${i}`))
  for (const [i, terms] of offers.entries())
    await sql.batch([
      stmt(
        "INSERT INTO jobs (chain_id,job_id,kind,status,manifest_hash,policy_hash,reward,token,published_block,updated_block) VALUES (?,?,'sidequest-v1','open',?,?,?, ?, ?,1)",
        chainId,
        String(i),
        termsHash(terms),
        `0x${'ff'.repeat(32)}`,
        '100',
        terms.token,
        i,
      ),
    ])
  return { db, sql, offers }
}
const cfg = (request: typeof fetch) => ({ boards: [own, host], origin: own, fetch: request })

describe('foreign offer discovery', () => {
  it('recomputes canonical terms hashes and rejects tampered or malformed bytes', () => {
    const terms = offer(),
      body = canonicalJson(terms),
      hash = termsHash(terms)
    expect(verifyForeignOffer(body, hash)?.title).toBe(terms.title)
    expect(verifyForeignOffer(JSON.stringify(JSON.parse(body), null, 2), hash)?.reward).toBe('100')
    expect(verifyForeignOffer(body.replace(terms.title, 'Tampered title'), hash)).toBeUndefined()
    expect(verifyForeignOffer('{}', hash)).toBeUndefined()
    expect(verifyForeignOffer('not JSON', hash)).toBeUndefined()
  })

  it('skips its own origin and unknown URLs from terms, and remembers a verified cache across ticks', async () => {
    const f = await fixture(),
      terms = { ...f.offers[0]!, brief: `Go to ${unknown}/offers` }
    const hash = termsHash(terms)
    await f.sql.batch([stmt('UPDATE jobs SET manifest_hash = ?', hash)])
    const request = vi.fn<typeof fetch>(async () => new Response(canonicalJson(terms)))
    expect(await hydrateForeignOffers(f.sql, chainId, cfg(request), 1000)).toEqual({ attempts: 1, stored: 1 })
    expect(request.mock.calls[0]?.[0]).toBe(`${host}/offers/${hash}.json`)
    expect(request.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) })
    expect(await foreignOffer(f.sql, hash)).toMatchObject({
      origin: host,
      terms: { title: terms.title, reward: '100' },
    })
    expect(await hydrateForeignOffers(f.sql, chainId, cfg(request), 1060)).toEqual({ attempts: 0, stored: 0 })
    expect(request).toHaveBeenCalledTimes(1)
    expect((await networkStats(f.sql, chainId)).jobs).toBe(1)
    expect((await networkStats(f.sql, chainId)).inEscrow[terms.token]).toBe('100')
  })

  it('tries only known boards in order, refusing bad bytes and never following redirects', async () => {
    const f = await fixture(),
      second = 'https://second.example',
      terms = f.offers[0]!
    const request = vi.fn<typeof fetch>(async (url) =>
      url === `${host}/offers/${termsHash(terms)}.json` ? new Response('tampered') : new Response(canonicalJson(terms)),
    )
    expect(await hydrateForeignOffers(f.sql, chainId, { ...cfg(request), boards: [own, host, second] }, 1000)).toEqual({
      attempts: 2,
      stored: 1,
    })
    expect((await foreignOffer(f.sql, termsHash(terms)))?.origin).toBe(second)
  })

  it('rejects redirects and oversize bodies, and times out unavailable hosts', async () => {
    const f = await fixture(),
      hash = termsHash(f.offers[0]!)
    const oversized = vi.fn<typeof fetch>(async () => new Response('x'.repeat(1024 * 1024 + 1)))
    expect(await hydrateForeignOffers(f.sql, chainId, cfg(oversized), 1000)).toEqual({ attempts: 1, stored: 0 })
    expect(await foreignOffer(f.sql, hash)).toBeNull()
    const redirected = vi.fn<typeof fetch>(async () => Response.redirect(unknown, 302))
    expect(await hydrateForeignOffers(f.sql, chainId, cfg(redirected), 4600)).toEqual({ attempts: 1, stored: 0 })
    const timeout = vi.fn<typeof fetch>(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('timed out')), { once: true })
        }),
    )
    expect(await hydrateForeignOffers(f.sql, chainId, { ...cfg(timeout), timeoutMs: 5 }, 8200)).toEqual({
      attempts: 1,
      stored: 0,
    })
    expect(await foreignOffer(f.sql, hash)).toBeNull()
  })

  it('skips malformed board origins and still tries a known host beyond the first forty', async () => {
    const f = await fixture(),
      terms = f.offers[0]!
    const boards = Array.from({ length: 41 }, (_, i) => `https://board-${i}.example`)
    for (const origin of boards.slice(0, 40))
      await f.sql.batch([stmt('INSERT INTO foreign_offer_misses VALUES (?, ?, 5000)', termsHash(terms), origin)])
    const request = vi.fn<typeof fetch>(async () => new Response(canonicalJson(terms)))
    expect(
      await hydrateForeignOffers(
        f.sql,
        chainId,
        { boards: ['http://unsafe.example', `${unknown}/path`, own, ...boards], origin: own, fetch: request },
        1000,
      ),
    ).toEqual({ attempts: 1, stored: 1 })
    expect(request.mock.calls[0]?.[0]).toBe(`${boards[40]}/offers/${termsHash(terms)}.json`)
  })

  it('caps every tick and repeated runs in a minute, and backs off misses', async () => {
    const f = await fixture(12)
    const request = vi.fn<typeof fetch>(async () => new Response('missing', { status: 404 }))
    expect(await hydrateForeignOffers(f.sql, chainId, cfg(request), 1000)).toEqual({
      attempts: MAX_OFFER_FETCHES,
      stored: 0,
    })
    expect(await hydrateForeignOffers(f.sql, chainId, cfg(request), 1001)).toEqual({ attempts: 0, stored: 0 })
    expect(await hydrateForeignOffers(f.sql, chainId, cfg(request), 1060)).toEqual({ attempts: 4, stored: 0 })
    expect(await hydrateForeignOffers(f.sql, chainId, cfg(request), 1120)).toEqual({ attempts: 0, stored: 0 })
    expect(await hydrateForeignOffers(f.sql, chainId, cfg(request), 4600)).toEqual({
      attempts: MAX_OFFER_FETCHES,
      stored: 0,
    })
  })

  it('does not fetch local offers and can hydrate older projections from Published.manifestHash', async () => {
    const f = await fixture(2),
      localHash = termsHash(f.offers[0]!),
      foreignHash = termsHash(f.offers[1]!)
    await f.sql.batch([
      stmt('CREATE TABLE board_offers (terms_hash TEXT PRIMARY KEY)'),
      stmt('INSERT INTO board_offers VALUES (?)', localHash),
      stmt(
        "INSERT INTO events VALUES (?, ?, 1, 0, 'tx', '1', 'Published', ?)",
        chainId,
        d.stacks.main!.holding,
        JSON.stringify({ manifestHash: foreignHash }),
      ),
      stmt("UPDATE jobs SET manifest_hash = NULL WHERE job_id = '1'"),
    ])
    const request = vi.fn<typeof fetch>(async () => new Response(canonicalJson(f.offers[1]!)))
    await hydrateForeignOffers(f.sql, chainId, cfg(request), 1000)
    expect(request).toHaveBeenCalledTimes(1)
    expect(await foreignOffer(f.sql, foreignHash)).not.toBeNull()
  })

  it('hydrates after folding under the chain lease even when the chain has no new page', async () => {
    const f = await fixture(),
      request = vi.fn<typeof fetch>(async () => new Response(canonicalJson(f.offers[0]!)))
    await runOnce(f.sql, {
      contracts: contractsFromDeployment(d),
      deployBlock: 1,
      runner: 'test',
      now: () => 1000,
      head: { finalizedBlock: async () => 0, blockHash: async () => null },
      source: { logs: async () => ({ logs: [], nextBlock: 1 }) },
      offers: cfg(request),
    })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('expired misses beyond the first 100 jobs do not starve discovery of older jobs', async () => {
    const f = await fixture(101),
      request = vi.fn<typeof fetch>(async () => new Response('missing', { status: 404 }))
    for (const terms of f.offers.slice(1))
      await f.sql.batch([stmt('INSERT INTO foreign_offer_misses VALUES (?, ?, 5000)', termsHash(terms), host)])
    expect(await hydrateForeignOffers(f.sql, chainId, cfg(request), 1000)).toEqual({ attempts: 1, stored: 0 })
  })
})
