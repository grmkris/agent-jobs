import { parseEther, parseSignature } from 'viem'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { forkEnabled, forkSetupTimeout, startSidequestFork } from '../test/sidequest-fixture.ts'
import { balanceOf, cancelUndelegate, delegate, delegatePermit, delegateWithPermit, requestUndelegate, withdraw } from './actions.ts'
import { getBacking, getPosition, listDelegations } from './staking.ts'

const fork = forkEnabled ? describe : describe.skip
fork('delegated staking SDK against real vault bytecode on a Monad fork', () => {
  let f: Awaited<ReturnType<typeof startSidequestFork>>
  let fromBlock: bigint
  beforeAll(async () => {
    f = await startSidequestFork()
    fromBlock = await f.ctx.publicClient.getBlockNumber()
  }, forkSetupTimeout())
  afterAll(() => f?.close())

  it('keeps outside backing owned by the payer and reads one canonical pool and position', async () => {
    const account = f.worker.account.address
    await delegate(f.ctx, f.creator, parseEther('30'), account)
    await delegate(f.ctx, f.worker, parseEther('20'))
    const backing = await getBacking(f.ctx, account)
    expect(backing).toMatchObject({ assets: parseEther('50'), active: parseEther('50'), reserved: 0n, available: parseEther('50') })
    expect(await getPosition(f.ctx, account, f.creator.account.address, { blockNumber: backing.blockNumber }))
      .toMatchObject({ shares: parseEther('30'), value: parseEther('30'), shareBps: 6000, staleGeneration: false })
    const found = await listDelegations(f.ctx, f.creator.account.address, { fromBlock })
    expect(found.source).toBe('vault-events')
    expect(found.positions).toHaveLength(1)
    expect(found.positions[0]).toMatchObject({ account, value: parseEther('30'), delegator: f.creator.account.address })
  }, 120_000)

  it('queues only the caller position, cancels it, and pays that owner after cooldown', async () => {
    const account = f.worker.account.address
    await expect(requestUndelegate(f.ctx, f.contributor, 1n, account)).rejects.toThrow('owned position')
    await requestUndelegate(f.ctx, f.creator, parseEther('10'), account)
    expect((await getBacking(f.ctx, account)).active).toBe(parseEther('40'))
    expect((await getPosition(f.ctx, account, f.creator.account.address)).queued).toBe(parseEther('10'))
    await cancelUndelegate(f.ctx, f.creator, account)
    expect((await getBacking(f.ctx, account)).active).toBe(parseEther('50'))
    await requestUndelegate(f.ctx, f.creator, parseEther('30'), account)
    const queued = await getPosition(f.ctx, account, f.creator.account.address)
    await expect(withdraw(f.ctx, f.creator, account)).rejects.toThrow()
    await f.rpc('evm_setNextBlockTimestamp', [queued.unlockAt + 1])
    await f.rpc('evm_mine')
    const before = await balanceOf(f.ctx, f.ctx.stack.factory, f.creator.account.address)
    await withdraw(f.ctx, f.creator, account)
    expect(await balanceOf(f.ctx, f.ctx.stack.factory, f.creator.account.address) - before).toBe(parseEther('30'))
    expect((await getPosition(f.ctx, account, f.worker.account.address)).value).toBe(parseEther('20'))
    expect((await getPosition(f.ctx, account, f.creator.account.address)).value).toBe(0n)
  }, 120_000)

  it('permit delegation credits the signer ownership behind a different account', async () => {
    const amount = parseEther('7')
    const deadline = (await f.ctx.publicClient.getBlock()).timestamp + 3600n
    const typed = await delegatePermit(f.ctx, f.contributor.account.address, amount, deadline)
    const signature = parseSignature(await f.contributor.signTypedData(typed))
    await delegateWithPermit(f.ctx, f.contributor, amount,
      { deadline, v: Number(signature.v), r: signature.r, s: signature.s }, f.arbitrator.account.address)
    expect(await getPosition(f.ctx, f.arbitrator.account.address, f.contributor.account.address))
      .toMatchObject({ value: amount, queued: 0n, shareBps: 10_000 })
    expect((await getPosition(f.ctx, f.arbitrator.account.address, f.arbitrator.account.address)).value).toBe(0n)
  }, 120_000)
})
