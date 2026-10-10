import { decodeJobStepCursor, stmt } from '@sidequest/indexer'
import { afterEach, expect, it } from 'vitest'
import { recentJobSteps } from '../src/registry.ts'
import { activityFixture } from './activity-fixture.ts'

const databases: Array<Awaited<ReturnType<typeof activityFixture>>['db']> = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
async function fixture() {
  const f = await activityFixture()
  databases.push(f.db)
  return f
}

it('orders lifecycle steps newest first and pages within a block without gaps or repeats', async () => {
  const f = await fixture()
  await f.addJob([f.published('1', 10), f.event('1', 'Activated', 20, 1, { agentId: '7', worker: 'worker' })])
  await f.addJob([
    f.published('2', 20, 2),
    f.event('2', 'JobSubmitted', 30, 0, { deliverable: 'delivery', provider: 'worker' }),
  ])
  const first = await recentJobSteps(f.sql, f.deployment, { limit: 2 })
  expect(first.steps.map((row) => [row.jobId, row.step])).toEqual([
    ['2', 'delivered'],
    ['2', 'posted'],
  ])
  expect(decodeJobStepCursor(first.nextCursor!)).toEqual({ block: 20, logIndex: 2 })
  const second = await recentJobSteps(f.sql, f.deployment, { limit: 2, cursor: first.nextCursor! })
  expect(second.steps.map((row) => [row.jobId, row.step])).toEqual([
    ['1', 'hired'],
    ['1', 'posted'],
  ])
  expect(second.nextCursor).toBeNull()
  expect(await recentJobSteps(f.sql, f.deployment, { boardId: 'empty' })).toEqual({ steps: [], nextCursor: null })
})

it('scopes boards through the manifest offer hash, keeping unhosted jobs in global activity', async () => {
  const f = await fixture()
  await f.addJob([f.published('1', 10)], 'my-team')
  await f.addJob([f.published('2', 20)], 'another')
  await f.addJob([f.published('3', 30)], null)
  expect((await recentJobSteps(f.sql, f.deployment)).steps.map((r) => r.boardId)).toEqual([null, 'another', 'my-team'])
  expect((await recentJobSteps(f.sql, f.deployment, { boardId: 'my-team', limit: 1 })).steps).toMatchObject([
    { jobId: '1', boardId: 'my-team' },
  ])
})

it("lists only a wallet's jobs, posted, approved or worked, matching the address in any case", async () => {
  const f = await fixture()
  const poster = '0x2222222222222222222222222222222222222222'
  const worker = '0x3333333333333333333333333333333333333333'
  const mine = f.event('1', 'Published', 10, 0, { ...f.published('1', 10).args, creator: poster, approver: poster })
  await f.addJob([mine, f.event('1', 'Activated', 20, 1, { agentId: '7', worker })])
  await f.addJob([f.published('2', 30)])
  const steps = async (wallet: string) =>
    (await recentJobSteps(f.sql, f.deployment, { wallet })).steps.map((row) => [row.jobId, row.step])
  expect(await steps(poster.toUpperCase().replace('0X', '0x'))).toEqual([
    ['1', 'hired'],
    ['1', 'posted'],
  ])
  expect(await steps(worker)).toEqual([
    ['1', 'hired'],
    ['1', 'posted'],
  ])
  expect(await steps(f.deployment.admin)).toEqual([['2', 'posted']])
  await expect(recentJobSteps(f.sql, f.deployment, { wallet: 'nope' })).rejects.toMatchObject({ code: 'invalid' })
})

it('filters retired Holdings, jobs without a configured publication, and other chains before limiting', async () => {
  const f = await fixture()
  await f.addJob([f.published('1', 10)])
  await f.addJob([{ ...f.published('2', 30), contract: 'retired-holding' }])
  await f.addJob([f.event('3', 'JobCompleted', 40)])
  await f.addJob([{ ...f.published('4', 50), chainId: f.deployment.chainId + 1 }])
  expect(await recentJobSteps(f.sql, f.deployment, { limit: 1 })).toMatchObject({
    steps: [{ jobId: '1' }],
    nextCursor: null,
  })
  expect(await recentJobSteps(f.sql, { ...f.deployment, stacks: {} })).toEqual({ steps: [], nextCursor: null })
})

it('reads block times and returns null for missing blocks or a fresh index without block_times', async () => {
  const f = await fixture()
  await f.addJob([f.published('1', 10), f.event('1', 'JobExpired', 20)])
  await f.sql.batch([stmt('INSERT INTO block_times VALUES (?, 10, 1234)', f.deployment.chainId)])
  expect((await recentJobSteps(f.sql, f.deployment)).steps.map((r) => r.at)).toEqual([null, 1234])
  f.db.exec('DROP TABLE block_times')
  expect((await recentJobSteps(f.sql, f.deployment)).steps.map((r) => r.at)).toEqual([null, null])
})

it('keeps one rejection step across appeal finalization and omits the core rejection of cancellation', async () => {
  const f = await fixture()
  await f.addJob([f.published('1', 10), f.event('1', 'Rejected', 20), f.event('1', 'JobRejected', 30)])
  await f.addJob([f.published('2', 40), f.event('2', 'JobRejected', 50), f.event('2', 'Cancelled', 50, 1)])
  await f.addJob([f.published('3', 60), f.event('3', 'JobRejected', 70)])
  const rows = (await recentJobSteps(f.sql, f.deployment)).steps
  expect(rows.filter((r) => r.step === 'rejected').map((r) => r.jobId)).toEqual(['3', '1'])
  expect(rows.filter((r) => r.jobId === '2').map((r) => r.step)).toEqual(['cancelled', 'posted'])
  const page = await recentJobSteps(f.sql, f.deployment, { boardId: 'public', limit: 5 })
  expect((await recentJobSteps(f.sql, f.deployment, { cursor: page.nextCursor!, limit: 1 })).steps[0]).toMatchObject({
    jobId: '1',
    step: 'posted',
  })
})

it('exposes only the row shape, attributing workers and amounts to the appropriate steps', async () => {
  const f = await fixture()
  const worker = 'worker'
  const huge = '900719925474099300001'
  await f.addJob([
    { ...f.published('1', 10), args: { ...f.published('1', 10).args, privateQuote: 'secret-quote' } },
    f.event('1', 'Activated', 20, 0, { worker, agentId: '7', net: huge, fee: '100', feeBps: 1000 }),
    f.event('1', 'JobSubmitted', 30, 0, { deliverable: 'secret-deliverable', provider: worker }),
    f.event('1', 'Accepted', 40),
    f.event('1', 'PaymentReleased', 40, 1, { recipient: worker, amount: huge }),
    f.event('1', 'JobCompleted', 40, 2),
    f.event('1', 'RewardSettled', 40, 3, { to: worker, amount: '99', outcome: 1 }),
    f.event('1', 'FeeCharged', 40, 4, {
      token: f.deployment.rewardTokens[0]!,
      worker,
      creator: 'creator',
      amount: '110',
      bonusPart: '10',
    }),
    f.event('1', 'RewardSettled', 50, 0, { to: 'creator', amount: '999', outcome: 2 }),
  ])
  const page = await recentJobSteps(f.sql, f.deployment)
  expect(page.steps.map((r) => r.step)).toEqual(['completed', 'delivered', 'hired', 'posted'])
  expect(page.steps.map((r) => r.agentId)).toEqual(['7', '7', '7', null])
  expect(page.steps[0]?.amount).toBe((BigInt(huge) + 99n).toString())
  expect(page.steps.at(-1)).toMatchObject({ amount: '1000', token: f.deployment.rewardTokens[0] })
  for (const row of page.steps) {
    const keys = ['jobId', 'step', 'at', 'txHash', 'boardId', 'agentId']
    if (row.step === 'posted' || row.step === 'completed') keys.push('token', 'amount')
    expect(Object.keys(row).toSorted()).toEqual(keys.toSorted())
  }
  expect(JSON.stringify(page)).not.toContain('secret-')
})

it('uses known completion net when transfer rows are absent and omits unknown money', async () => {
  const f = await fixture()
  await f.addJob([
    f.published('1', 10),
    f.event('1', 'Activated', 20, 0, { worker: 'worker', agentId: '7', net: '900', fee: '100', feeBps: 1000 }),
    f.event('1', 'JobCompleted', 30),
  ])
  expect((await recentJobSteps(f.sql, f.deployment)).steps[0]).toMatchObject({ amount: '900' })
  await f.addJob([f.published('2', 40), f.event('2', 'JobCompleted', 50)])
  expect((await recentJobSteps(f.sql, f.deployment)).steps[0]).not.toHaveProperty('amount')
  expect((await recentJobSteps(f.sql, f.deployment)).steps[0]).not.toHaveProperty('token')
})

it('applies default and maximum page sizes before reading', async () => {
  const f = await fixture()
  for (let n = 1; n <= 51; n++) await f.addJob([f.published(String(n), n)])
  expect((await recentJobSteps(f.sql, f.deployment)).steps).toHaveLength(20)
  const max = await recentJobSteps(f.sql, f.deployment, { limit: 50 })
  expect(max.steps).toHaveLength(50)
  expect((await recentJobSteps(f.sql, f.deployment, { limit: 50, cursor: max.nextCursor! })).steps).toHaveLength(1)
})

it('rejects invalid board, limit and cursor parameters', async () => {
  const f = await fixture()
  for (const opts of [
    { boardId: '' },
    { boardId: 'Bad board' },
    { boardId: 'x'.repeat(33) },
    { limit: 0 },
    { limit: 51 },
    { limit: 1.5 },
    { limit: Number.NaN },
    { limit: Infinity },
    { cursor: '' },
    { cursor: 'bad' },
  ])
    await expect(recentJobSteps(f.sql, f.deployment, opts)).rejects.toMatchObject({ code: 'invalid' })
})
