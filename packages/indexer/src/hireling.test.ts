/** ABI-encoded v1 logs in real SQLite, alongside the captured legacy testnet fixture. No RPC writes. */
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@agent-jobs/sdk'
import { type Abi, type AbiEvent, type Address, type Hex, encodeAbiParameters, encodeEventTopics, stringToHex } from 'viem'
import { describe, expect, it } from 'vitest'
import legacyLogs from '../test/fixtures/testnet-logs.json' with { type: 'json' }
import {
  type AsyncSql, type IndexerConfig, type RawLog, contractsFromDeployment, decode, fromNodeSqlite,
  agentDetail, configuredJobs, jobAvailability, jobDetail, listAgents, migrate, networkStats, protocolEvents, resetIndex, runOnce, stmt,
} from './index.ts'

const addr = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`
const legacy = sdk.deployment('monad-testnet')
const d: sdk.Deployment = {
  ...legacy,
  stacks: { main: { kind: 'hireling-v1', factory: addr(1), holding: addr(2), evaluator: addr(3), openTokens: true } },
  legacyStacks: { ...legacy.legacyStacks },
  hireling: { block: 100n, safe: addr(9), factory: addr(1), vault: addr(4), feeSchedule: addr(5), distributor: addr(6), miningReserve: addr(7), teamVesting: addr(8), t0: 1_000 },
}
const contracts = contractsFromDeployment(d)
const creator = addr(20), worker = addr(21), approver = addr(22), arbitrator = addr(23), token = addr(24)
const holding = sdk.hirelingHoldingAbi as Abi, evaluator = sdk.hirelingEvaluatorAbi as Abi

/** Encode exactly the event's indexed topics and non-indexed data from the generated contract ABI. */
function log(abi: Abi, address: Address, name: string, args: Record<string, unknown>, block: number, index = 0): RawLog {
  const event = abi.find((item): item is AbiEvent => item.type === 'event' && item.name === name)!
  for (const input of event.inputs) if (args[input.name!] === undefined) throw new Error(`Missing ${name}.${input.name}`)
  const topics = encodeEventTopics({ abi: [event], eventName: name, args } as never) as Hex[]
  const dataInputs = event.inputs.filter((p) => !p.indexed)
  return {
    address, block_number: block, log_index: index, transaction_hash: hash(block),
    topic0: topics[0] ?? null, topic1: topics[1] ?? null, topic2: topics[2] ?? null, topic3: topics[3] ?? null,
    data: encodeAbiParameters(dataInputs, dataInputs.map((p) => args[p.name!])),
  }
}

function published(id = 1000n, block = 100, by: Address = creator) {
  return log(holding, addr(2), 'Published', {
    jobId: id, creator: by, approver, arbitrator, token, reward: 1000n, creatorBond: 100n, workerBond: 200n,
    manifestHash: hash(1), policyHash: hash(2), deliveryDeadline: 10_000, expiredAt: 60_000,
    reviewWindow: 3600, disputeWindow: 7200, arbitrationWindow: 43_200,
  }, block)
}
function activated(id = 1000n, block = 101) {
  return log(holding, addr(2), 'Activated', { jobId: id, worker, agentId: 7n, selectionNonce: 1n, feeBps: 1000, fee: 100n, net: 900n, workerBond: 200n }, block)
}
const paidLogs = [
  published(), activated(),
  log(holding, addr(2), 'ToppedUp', { jobId: 1000n, contributor: creator, amount: 100n, bonus: 100n }, 102),
  log(evaluator, addr(3), 'Ruled', { jobId: 1000n, arbitrator, forWorker: true, slashLoser: true, reasonHash: hash(3) }, 103),
  log(holding, addr(2), 'BondSlashed', { jobId: 1000n, side: 0, account: creator, amount: 100n }, 103, 1),
  log(holding, addr(2), 'BondReleased', { jobId: 1000n, side: 1, account: worker, amount: 200n }, 103, 2),
  log(evaluator, addr(3), 'PayoutDeferred', { jobId: 1000n, refundedToHolding: true }, 103, 3),
  log(sdk.coreAbi as Abi, d.core, 'JobRejected', { jobId: 1000n, rejector: addr(3), reason: hash(4) }, 103, 4),
  log(holding, addr(2), 'RewardSettled', { jobId: 1000n, to: worker, outcome: 1, amount: 990n }, 104),
  log(holding, addr(2), 'FeeCharged', { jobId: 1000n, token, worker, creator, amount: 110n, bonusPart: 10n }, 104, 1),
  log(holding, addr(2), 'PayoutOwed', { jobId: 1000n, to: worker, token, amount: 990n }, 104, 2),
  log(sdk.stakeVaultAbi as Abi, addr(4), 'Delegated', { account: worker, delegator: worker, payer: worker, assets: 10_000n, shares: 10_000n }, 100, 1),
  log(sdk.stakeVaultAbi as Abi, addr(4), 'Reserved', { holding: addr(2), account: worker, amount: 200n }, 101, 1),
  log(sdk.miningReserveAbi as Abi, addr(7), 'EpochFunded', { epoch: 0n, amount: 500n, totalFunded: 500n }, 105),
  log(sdk.epochDistributorAbi as Abi, addr(6), 'RootSet', { epoch: 0n, root: hash(9), total: 500n, dataHash: hash(10) }, 105, 1),
  log(sdk.epochDistributorAbi as Abi, addr(6), 'Claimed', { epoch: 0n, account: worker, amount: 500n }, 106),
  log(sdk.feeScheduleAbi as Abi, addr(5), 'ScheduleExecuted', { thresholds: [0n, 10_000n, 100_000n, 1_000_000n], bps: [3000, 1000, 300, 100], treasury: addr(9) }, 107),
]

function cfg(logs: RawLog[], pageSize = 50, finalized = 110, deployment = d): IndexerConfig {
  return {
    contracts: deployment === d ? contracts : contractsFromDeployment(deployment), deployBlock: 100, runner: 'test', now: () => 1_000, maxPages: 20,
    head: { finalizedBlock: async () => finalized, blockHash: async (block) => hash(block), blockTimestamp: async (block) => 10_000 + block },
    source: { logs: async ({ fromBlock, toBlock }) => {
      const end = Math.min(fromBlock + pageSize, toBlock)
      return { logs: logs.filter((l) => l.block_number >= fromBlock && l.block_number < end), nextBlock: end }
    } },
  }
}
async function db() {
  const sql = fromNodeSqlite(new DatabaseSync(':memory:'))
  await migrate(sql)
  return sql
}
async function snapshot(sql: AsyncSql) {
  return Promise.all(['events', 'protocol_events', 'jobs', 'top_ups', 'fee_charges', 'payout_owed', 'reward_outcomes', 'bond_outcomes', 'rulings']
    .map((table) => sql.all(`SELECT * FROM ${table} ORDER BY 1, 2, 3, 4`)))
}

describe('Hireling event indexing', () => {
  it('headline accounting separates gross, fee, net earned and a refused worker transfer', async () => {
    const sql = await db()
    await runOnce(sql, cfg(paidLogs))
    const stats = await networkStats(sql, contracts.chainId)
    expect(stats.accounting[token]).toEqual({ gross: '1100', fee: '110', net: '990', paid: '0' })
    expect(stats.activity).toEqual({ demo: 0, unclassified: 1, independent: null })
  })

  it('chooses each address ABI and keeps the captured legacy logs readable beside v1', () => {
    expect(decode(contracts, published())?.args.reviewWindow).toBe(3600)
    expect(decode(contracts, { ...published(), address: legacy.legacyStacks['main-v3']!.holding })).toBeUndefined()
    const captured = (legacyLogs.logs as unknown as RawLog[]).find((l) => decode(contracts, l)?.name === 'Published')!
    const event = decode(contracts, captured)!
    expect(event.args.mode).toBeDefined()
    expect(event.args.reviewWindow).toBeUndefined()
    expect(decode(contracts, { ...captured, address: addr(2) })).toBeUndefined()
    expect(decode(contracts, { ...published(), address: addr(99) })).toBeUndefined()
  })

  it('keeps archived v1 schema and evidence through a shared-core refold while excluding the retired Holding', async () => {
    const sql = await db()
    const submission = log(sdk.coreAbi as Abi, d.core, 'JobSubmitted', { jobId: 1000n, provider: worker, deliverable: hash(22) }, 102)
    const evidence = log(evaluator, addr(3), 'EvidenceAttached', { jobId: 1000n, verifier: addr(25), digest: hash(21), submissionHash: hash(22), policyHash: hash(2), testedSha: hash(23), conclusion: 1, validUntil: 20_000 }, 102)
    const captured = (legacyLogs.logs as unknown as RawLog[]).find(l => decode(contracts, l)?.name === 'Published')!
    const legacyPublication = log(sdk.jobHoldingAbi as Abi, captured.address, 'Published', { ...decode(contracts, captured)!.args, jobId: 1001n }, 100)
    const initial = [published(), activated(), submission, evidence,
      log(evaluator, addr(3), 'Accepted', { jobId: 1000n, approver }, 103),
      log(evaluator, addr(3), 'PayoutDeferred', { jobId: 1000n, refundedToHolding: false }, 103, 1), legacyPublication]
    await runOnce(sql, cfg(initial))
    const original = await jobDetail(sql, contracts.chainId, '1000', 0)
    const promoted: sdk.Deployment = { ...d, stacks: { main: { kind: 'hireling-v1', factory: addr(30), holding: addr(31), evaluator: addr(32), openTokens: true } } }
    // The paused-core decision still has agreed worker rights when the shared core later expires the job.
    const expired = log(sdk.coreAbi as Abi, d.core, 'JobExpired', { jobId: 1000n }, 111)
    const current = { ...published(1002n, 112), address: addr(31) }
    const legacySubmitted = log(sdk.coreAbi as Abi, d.core, 'JobSubmitted', { jobId: 1001n, provider: worker, deliverable: hash(24) }, 113)
    const promotedLogs = [...initial, expired, current, legacySubmitted]
    const nextCfg = cfg(promotedLogs, 50, 120, promoted)
    expect(decode(nextCfg.contracts, published())).toBeUndefined()
    expect(decode(nextCfg.contracts, evidence)).toBeUndefined()
    await runOnce(sql, nextCfg)
    const detail = await jobDetail(sql, contracts.chainId, '1000', 0)
    expect(detail?.job).toMatchObject({ kind: 'hireling-v1', arbitrator, review_window: 3600, dispute_window: 7200, arbitration_window: 43_200, expired_at: 60_000,
      mode: 'hire', outcome: 'Accepted', payout_deferred: 1, fee_bps: 1000, fee: '100', net: '900', status: 'expired' })
    expect(detail?.evidence).toEqual(original?.evidence)
    expect(detail?.evidence).toMatchObject([{ submission_hash: hash(22), onchainMatch: true }])
    expect(detail?.timeline.slice(0, -1)).toEqual(original?.timeline)
    expect(detail?.timeline.at(-1)).toMatchObject({ name: 'JobExpired', block: 111 })
    expect(await jobAvailability(sql, promoted, '1000')).toMatchObject({ status: 'archived', actionable: false, holding: addr(2).toLowerCase() })
    const active = configuredJobs(promoted)
    expect((await sql.all<{ job_id: string }>(`SELECT job_id FROM jobs WHERE ${active.clause} ORDER BY job_id`, ...active.params)).map(job => job.job_id)).toEqual(['1001', '1002'])
    expect((await jobDetail(sql, contracts.chainId, '1001', 0))?.job).toMatchObject({ kind: 'legacy', arbitrator: null, review_window: null, outcome: null })
    expect(await jobAvailability(sql, promoted, '1001')).toMatchObject({ actionable: true })
    // A canonical-hash mismatch triggers the normal rewind/refold with the retired publication still in storage.
    await sql.batch([stmt('UPDATE checkpoint SET block_hash=? WHERE chain_id=?', hash(999), contracts.chainId)])
    expect((await runOnce(sql, { ...nextCfg, rewindBlocks: 10 })).rewound).toBe(true)
    expect(await jobDetail(sql, contracts.chainId, '1000', 0)).toEqual(detail)
    // A coordinator-style cursor replay re-decodes only current addresses; archived facts and interpretation survive.
    await sql.batch([stmt('UPDATE checkpoint SET next_block=100, block_hash=NULL WHERE chain_id=?', contracts.chainId)])
    await runOnce(sql, cfg(promotedLogs, 1, 120, promoted))
    expect(await jobDetail(sql, contracts.chainId, '1000', 0)).toEqual(detail)
    expect(await jobAvailability(sql, promoted, '1000')).toMatchObject({ status: 'archived', actionable: false })
  })

  it('folds fees, windows, top-ups, paid rights, deferrals and reserved stake bonds', async () => {
    const sql = await db()
    const result = await runOnce(sql, cfg(paidLogs))
    expect(result.jobs).toBe(1)
    const detail = await jobDetail(sql, contracts.chainId, '1000', 0)
    expect(detail?.job).toMatchObject({
      kind: 'hireling-v1', mode: 'hire', selection_deadline: null, arbitrator, review_window: 3600,
      dispute_window: 7200, arbitration_window: 43_200, expired_at: 60_000,
      fee_bps: 1000, fee: '100', net: '900', bonus: '100', charged_fee: '110', bonus_fee: '10',
      outcome: 'RuledForWorker', settlement_outcome: 'Paid', payout_deferred: 1, refunded_to_holding: 1,
      status: 'rejected',
    })
    expect(detail?.topUps).toMatchObject([{ contributor: creator, amount: '100', refunded: 0 }])
    expect(detail?.fees).toMatchObject([{ token, worker, creator, amount: '110', bonus_part: '10' }])
    expect(detail?.payoutsOwed).toMatchObject([{ recipient: worker, token, amount: '990' }])
    expect(detail?.rewards).toMatchObject([{ kind: 'owed', recipient: worker, amount: '990' }])
    expect(await listAgents(sql, contracts.chainId)).toMatchObject([{ agentId: '7', completed: 1, lost: 0, earned: {} }])
    expect(detail?.bonds).toMatchObject([{ side: 'creator', outcome: 'burned', recipient: creator }, { side: 'worker', outcome: 'returned', recipient: worker }])
    const protocol = await protocolEvents(sql, contracts.chainId)
    expect(protocol.map((e) => e.name)).toEqual(['Delegated', 'Reserved', 'EpochFunded', 'RootSet', 'Claimed', 'ScheduleExecuted'])
    expect(protocol.every((e) => e.at === 10_000 + e.block)).toBe(true)
    expect(protocol.at(-1)?.args.thresholds).toEqual(['0', '10000', '100000', '1000000'])
    expect((await protocolEvents(sql, contracts.chainId, { contract: addr(6), fromBlock: 106 })).map((e) => e.name)).toEqual(['Claimed'])
  })

  it('keeps fast per-job windows and emitted epoch ids without deriving epochs from wall-clock constants', async () => {
    const sql = await db(), epoch = 17n
    const logs = [log(holding, addr(2), 'Published', { ...decode(contracts, published())!.args,
      reviewWindow: 120, disputeWindow: 120, arbitrationWindow: 300 }, 100),
      log(sdk.miningReserveAbi as Abi, addr(7), 'EpochFunded', { epoch, amount: 500n, totalFunded: 500n }, 101),
      log(sdk.epochDistributorAbi as Abi, addr(6), 'RootSet', { epoch, root: hash(9), total: 500n, dataHash: hash(10) }, 101, 1),
      log(sdk.epochDistributorAbi as Abi, addr(6), 'Claimed', { epoch, account: worker, amount: 500n }, 102)]
    await runOnce(sql, cfg(logs))
    expect((await jobDetail(sql, contracts.chainId, '1000', 0))?.job).toMatchObject({ review_window: 120, dispute_window: 120, arbitration_window: 300 })
    const events = await protocolEvents(sql, contracts.chainId)
    expect(events.map(event => event.args.epoch)).toEqual(['17', '17', '17'])
  })

  it('records creator refunds, top-up claims and permissionless outcomes separately', async () => {
    const sql = await db()
    const logs = [published(), activated(),
      log(evaluator, addr(3), 'TimedOut', { jobId: 1000n, reason: stringToHex('arbitration-window', { size: 32 }) }, 102),
      log(evaluator, addr(3), 'RefundDeferred', { jobId: 1000n }, 102, 1),
      log(holding, addr(2), 'RewardSettled', { jobId: 1000n, to: creator, outcome: 2, amount: 1000n }, 103),
      log(holding, addr(2), 'TopUpRefunded', { jobId: 1000n, contributor: creator, amount: 100n }, 104),
    ]
    await runOnce(sql, cfg(logs))
    const detail = await jobDetail(sql, contracts.chainId, '1000', 0)
    expect(detail?.job).toMatchObject({ outcome: 'ArbitrationTimeout', settlement_outcome: 'Refunded', refund_deferred: 1 })
    expect(detail?.rewards).toMatchObject([{ kind: 'refunded', recipient: creator, amount: '1000' }])
    expect(detail?.topUps).toMatchObject([{ amount: '100', refunded: 1 }])
  })

  it('counts the core net payment and a successfully settled bonus once, without counting the fee as earnings', async () => {
    const sql = await db()
    const logs = [published(), activated(),
      log(holding, addr(2), 'ToppedUp', { jobId: 1000n, contributor: creator, amount: 100n, bonus: 100n }, 102),
      log(evaluator, addr(3), 'Accepted', { jobId: 1000n, approver }, 103),
      log(sdk.coreAbi as Abi, d.core, 'PaymentReleased', { jobId: 1000n, recipient: worker, amount: 900n }, 103, 1),
      log(sdk.coreAbi as Abi, d.core, 'JobCompleted', { jobId: 1000n, evaluator: addr(3), reason: hash(1) }, 103, 2),
      log(holding, addr(2), 'RewardSettled', { jobId: 1000n, to: worker, outcome: 1, amount: 90n }, 104),
      log(holding, addr(2), 'FeeCharged', { jobId: 1000n, token, worker, creator, amount: 110n, bonusPart: 10n }, 104, 1),
    ]
    await runOnce(sql, cfg(logs))
    expect((await jobDetail(sql, contracts.chainId, '1000', 0))?.job).toMatchObject({ status: 'completed', outcome: 'Accepted', settlement_outcome: 'Paid' })
    expect(await listAgents(sql, contracts.chainId)).toMatchObject([{ completed: 1, lost: 0, earned: { [token]: '990' } }])
  })

  it("an agent's record holds the jobs its wallets posted, gross/fee/net per side, and its timings", async () => {
    const sql = await db()
    const logs = [published(), activated(),
      log(holding, addr(2), 'ToppedUp', { jobId: 1000n, contributor: creator, amount: 100n, bonus: 100n }, 102),
      log(sdk.coreAbi as Abi, d.core, 'JobSubmitted', { jobId: 1000n, provider: worker, deliverable: hash(5) }, 103),
      log(evaluator, addr(3), 'Accepted', { jobId: 1000n, approver }, 104),
      log(sdk.coreAbi as Abi, d.core, 'PaymentReleased', { jobId: 1000n, recipient: worker, amount: 900n }, 104, 1),
      log(sdk.coreAbi as Abi, d.core, 'JobCompleted', { jobId: 1000n, evaluator: addr(3), reason: hash(1) }, 104, 2),
      log(holding, addr(2), 'RewardSettled', { jobId: 1000n, to: worker, outcome: 1, amount: 90n }, 105),
      log(holding, addr(2), 'FeeCharged', { jobId: 1000n, token, worker, creator, amount: 110n, bonusPart: 10n }, 105, 1),
      // Agent 7's wallet posts a job of its own.
      published(1001n, 106, worker),
    ]
    await runOnce(sql, cfg(logs))
    const seven = await agentDetail(sql, contracts.chainId, '7')
    expect(seven?.jobs.map((j) => j.job_id)).toEqual(['1000'])
    expect(seven?.wallets).toEqual([worker])
    expect(seven?.posted.map((j) => j.job_id)).toEqual(['1001'])
    expect(seven?.hiring).toEqual({ posted: 1, open: 1, paidOut: {} })
    expect(seven?.work.earned).toEqual({ [token]: { gross: '1100', fee: '110', net: '990' } })
    // Block times are 10_000 + block: activated at 101, submitted at 103, last event at 106.
    expect(seven?.time).toEqual({ activeSince: 10_101, lastActive: 10_106, medianTurnaroundSeconds: 2, turnarounds: 1 })

    // An agent that took nothing: its record is the hiring its known wallet did, paid out gross/fee/net.
    const hirer = await agentDetail(sql, contracts.chainId, '8', [creator.toUpperCase().replace('0X', '0x')])
    expect(hirer?.agent).toMatchObject({ agentId: '8', jobs: 0, completed: 0 })
    expect(hirer?.jobs).toEqual([])
    expect(hirer?.posted.map((j) => j.job_id)).toEqual(['1000'])
    expect(hirer?.hiring).toEqual({ posted: 1, open: 0, paidOut: { [token]: { gross: '1100', fee: '110', net: '990' } } })
    expect(hirer?.time.activeSince).toBe(10_100)
    expect(await agentDetail(sql, contracts.chainId, '9')).toBeUndefined()
  })

  it('replay, small pages, restart and rebuild preserve job and protocol rows', async () => {
    const sql = await db()
    await runOnce(sql, cfg(paidLogs))
    const live = await snapshot(sql)
    await sql.batch([stmt('UPDATE checkpoint SET next_block = 100, block_hash = NULL')])
    await runOnce(sql, cfg(paidLogs, 1))
    expect(await snapshot(sql)).toEqual(live)
    await resetIndex(sql, cfg(paidLogs))
    expect(await sql.all('SELECT * FROM protocol_events')).toEqual([])
    await runOnce(sql, cfg(paidLogs, 3))
    expect(await snapshot(sql)).toEqual(live)
  })

  it('a failed atomic page leaves neither protocol rows nor job rows or checkpoint', async () => {
    const sql = await db()
    const broken: AsyncSql = { all: sql.all, batch: async (statements) => sql.batch(
      statements.some((s) => s.query.includes('INSERT OR IGNORE INTO events'))
        ? [...statements, stmt('INSERT INTO missing_table VALUES (1)')] : statements,
    ) }
    await expect(runOnce(broken, cfg(paidLogs))).rejects.toThrow()
    for (const table of ['events', 'protocol_events', 'jobs', 'checkpoint']) expect(await sql.all(`SELECT * FROM ${table}`)).toEqual([])
    await runOnce(sql, cfg(paidLogs))
    expect((await protocolEvents(sql, contracts.chainId)).length).toBe(6)
  })

  it('rewinds both paths and restores a pre-ruling job from retained events', async () => {
    const sql = await db()
    const config = cfg(paidLogs)
    await runOnce(sql, config)
    const rewound = await runOnce(sql, { ...config, maxPages: 0, rewindBlocks: 9,
      head: { ...config.head, blockHash: async () => hash(999) } })
    expect(rewound.rewound).toBe(true)
    expect(await sql.all('SELECT * FROM events WHERE block >= 102')).toEqual([])
    expect(await sql.all('SELECT * FROM protocol_events WHERE block >= 102')).toEqual([])
    expect((await jobDetail(sql, contracts.chainId, '1000', 0))?.job).toMatchObject({ status: 'active', outcome: 'None', bonus: '0', payout_deferred: 0 })
    await runOnce(sql, config)
    expect((await jobDetail(sql, contracts.chainId, '1000', 0))?.job.outcome).toBe('RuledForWorker')
  })

  it('adds v1 columns to a populated pre-v1 schema and initializes repeatedly without touching its row', async () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(readFileSync(new URL('../test/fixtures/legacy-jobs.sql', import.meta.url), 'utf8'))
    sqlite.prepare("INSERT INTO jobs (chain_id, job_id, status, updated_block, agent_id) VALUES (10143, '9', 'completed', 100, '7')").run()
    const sql = fromNodeSqlite(sqlite)
    await migrate(sql)
    await migrate(sql)
    expect(await sql.all('SELECT job_id, status, agent_id, fee_bps, review_window FROM jobs')).toEqual([
      { job_id: '9', status: 'completed', agent_id: '7', fee_bps: null, review_window: null },
    ])
  })
})
