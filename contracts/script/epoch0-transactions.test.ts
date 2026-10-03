import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { startHirelingFork, forkEnabled } from '../../packages/sdk/test/hireling-fixture.ts'
import { FlowJournal, flowJson, parseFlowJson, type FlowState } from '../../packages/sdk/src/flow-journal.ts'
import { epochDistributorAbi } from '../../packages/sdk/src/abi/epochDistributor.ts'
import { stakeVaultAbi } from '../../packages/sdk/src/abi/stakeVault.ts'
import { factoryV2Abi } from '../../packages/sdk/src/abi/factoryV2.ts'
import { reserveAbi } from '../../scripts/mining/chain.ts'
import { buildTree } from '../../scripts/mining/tree.ts'
import { decodeEventLog, encodeFunctionData, parseAbi, parseEther, zeroAddress, type Address, type Hex } from '../../scripts/mining/viem.ts'
import { epochCalls, runEpoch0, safeEpochAbi, safeEpochCall, type Epoch0File } from './epoch0-transactions.ts'

const fork = forkEnabled ? describe : describe.skip
fork('testnet epoch script on real Safe and v1 contracts (local Monad fork only)', () => {
  let f: Awaited<ReturnType<typeof startHirelingFork>>, snapshot: unknown, file: Epoch0File
  beforeAll(async () => {
    f = await startHirelingFork()
    const factory = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67', singleton = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762'
    const setup = parseAbi(['function setup(address[],uint256,address,bytes,address,address,uint256,address)'])
    const proxyFactory = parseAbi(['function createProxyWithNonce(address,bytes,uint256) returns (address)', 'event ProxyCreation(address indexed proxy,address singleton)'])
    const initialization = encodeFunctionData({ abi: setup, functionName: 'setup', args: [[f.admin.account.address], 1n, zeroAddress, '0x', zeroAddress, zeroAddress, 0n, zeroAddress] })
    const tx = await f.admin.writeContract({ address: factory, abi: proxyFactory, functionName: 'createProxyWithNonce', args: [singleton, initialization, BigInt(Date.now())] })
    const receipt = await f.ctx.publicClient.waitForTransactionReceipt({ hash: tx })
    let safe: Address | undefined
    for (const log of receipt.logs) {
      try { const event = decodeEventLog({ abi: proxyFactory, data: log.data, topics: log.topics }); if (event.eventName === 'ProxyCreation') safe = event.args.proxy } catch { /* other Safe setup logs */ }
    }
    if (!safe) throw new Error('fork Safe was not created')
    const h = f.ctx.deployment.hireling!
    f.ctx = { ...f.ctx, deployment: { ...f.ctx.deployment, hireling: { ...h, safe, block: await f.ctx.publicClient.getBlockNumber({ cacheTime: 0 }) } } }
    const ownable = parseAbi(['function transferOwnership(address)', 'function acceptOwnership()'])
    for (const target of [h.miningReserve, h.distributor]) {
      await f.send(target, ownable, 'transferOwnership', [safe])
      // Only fixture setup uses the prevalidated path; tested fund uses ECDSA.
      const signature = `0x${f.admin.account.address.slice(2).padStart(64, '0')}${'0'.repeat(64)}01` as Hex
      await f.send(safe, safeEpochAbi, 'execTransaction', [target, 0n, encodeFunctionData({ abi: ownable, functionName: 'acceptOwnership' }), 0, 0n, 0n, 0n, zeroAddress, zeroAddress, signature])
    }
    await f.send(h.factory, factoryV2Abi, 'transfer', [h.miningReserve, parseEther('500000000')])
    const end = await f.ctx.publicClient.readContract({ address: h.miningReserve, abi: reserveAbi, functionName: 'epochEnd', args: [0n] })
    await f.rpc('evm_setNextBlockTimestamp', [Number(end) + 1]); await f.rpc('evm_mine')
    const total = parseEther('100'), tree = buildTree([['0', f.worker.account.address.toLowerCase() as Address, total.toString()]])
    const root = tree.tree[0]!, dataHash = `0x${'11'.repeat(32)}` as Hex
    file = { chainId: 10143, epoch: '0', root, total: total.toString(), dataHash,
      claims: { [f.worker.account.address.toLowerCase()]: { amount: total.toString(), proof: [] } },
      calls: {
        fund: { to: h.miningReserve, data: encodeFunctionData({ abi: reserveAbi, functionName: 'fund', args: [0n, total] }), expect: { totalFunded: '0', fundedForEpoch: '0' } },
        setRoot: { to: h.distributor, data: encodeFunctionData({ abi: epochDistributorAbi, functionName: 'setRoot', args: [0n, root, total, dataHash] }) },
      } }
    snapshot = await f.rpc('evm_snapshot')
  }, 180_000)
  beforeEach(async () => { await f.rpc('evm_revert', [snapshot]); snapshot = await f.rpc('evm_snapshot') })
  afterAll(() => f?.close())
  const sign = (hash: Hex) => f.admin.account.sign!({ hash })
  const journal = (state: FlowState = { binding: 'fork', values: {}, sends: {} }, save = (_state: FlowState) => {}) => new FlowJournal(f.ctx, state, save, () => {})

  it('stops at failed publication, resumes identical fund/root, and claims only after readback', async () => {
    const j = journal(), signer = vi.fn(sign), publisher = vi.fn(async (): Promise<void> => { throw new Error('readback failed') })
    await expect(runEpoch0(f.ctx, j, f.admin, signer, file, publisher, f.worker)).rejects.toThrow('readback failed')
    const h = f.ctx.deployment.hireling!, safeNonce = await f.ctx.publicClient.readContract({ address: h.safe, abi: safeEpochAbi, functionName: 'nonce' })
    const beforeSends = flowJson(j.state.sends)
    expect(await f.ctx.publicClient.readContract({ address: h.distributor, abi: epochDistributorAbi, functionName: 'isClaimed', args: [0n, f.worker.account.address] })).toBe(false)
    publisher.mockImplementation(async () => {})
    await runEpoch0(f.ctx, j, f.admin, signer, file, publisher, f.worker)
    expect(signer).toHaveBeenCalledTimes(2)
    expect(publisher).toHaveBeenCalledTimes(2)
    expect(flowJson({ 'epoch0/fund': j.state.sends['epoch0/fund'], 'epoch0/setRoot': j.state.sends['epoch0/setRoot'] })).toBe(beforeSends)
    expect(await f.ctx.publicClient.readContract({ address: h.safe, abi: safeEpochAbi, functionName: 'nonce' })).toBe(safeNonce)
    expect(await f.ctx.publicClient.readContract({ address: h.vault, abi: stakeVaultAbi, functionName: 'stakeOf', args: [f.worker.account.address] })).toBe(parseEther('100'))
    const sends = flowJson(j.state.sends)
    await runEpoch0(f.ctx, j, f.admin, signer, file, publisher, f.worker)
    expect(flowJson(j.state.sends)).toBe(sends)
  }, 120_000)

  it('persists raw outer bytes before send and resumes after a process crash without re-signing', async () => {
    let durable: FlowState = { binding: 'fork', values: {}, sends: {} }
    const signer = vi.fn(sign), fund = file.calls.fund!
    const j = journal(durable, state => { durable = parseFlowJson(flowJson(state)); if (state.sends['epoch0/fund']) throw new Error('crash after durable save') })
    await expect(safeEpochCall(f.ctx, j, f.admin, signer, 'fund', fund.to, fund.data, fund.expect)).rejects.toThrow('crash')
    expect(durable.sends['epoch0/fund']!.raw).toMatch(/^0x/)
    expect(await f.ctx.publicClient.readContract({ address: fund.to, abi: reserveAbi, functionName: 'totalFunded' })).toBe(0n)
    const raw = durable.sends['epoch0/fund']!.raw
    await safeEpochCall(f.ctx, journal(durable), f.admin, signer, 'fund', fund.to, fund.data, fund.expect)
    expect(signer).toHaveBeenCalledTimes(1)
    expect(durable.sends['epoch0/fund']!.raw).toBe(raw)
    expect(await f.ctx.publicClient.readContract({ address: fund.to, abi: reserveAbi, functionName: 'totalFunded' })).toBe(parseEther('100'))
  }, 120_000)

  it('refuses a restored draft after another Safe transaction moves its nonce', async () => {
    const signer = vi.fn(sign), fund = file.calls.fund!, j = journal(undefined, state => { if (state.values['epoch0/fund/draft']) throw new Error('stop after draft') })
    await expect(safeEpochCall(f.ctx, j, f.admin, signer, 'fund', fund.to, fund.data, fund.expect)).rejects.toThrow('stop')
    const h = f.ctx.deployment.hireling!, signature = `0x${f.admin.account.address.slice(2).padStart(64, '0')}${'0'.repeat(64)}01` as Hex
    await f.send(h.safe, safeEpochAbi, 'execTransaction', [f.admin.account.address, 0n, '0x', 0, 0n, 0n, 0n, zeroAddress, zeroAddress, signature])
    await expect(safeEpochCall(f.ctx, journal(j.state), f.admin, signer, 'fund', fund.to, fund.data, fund.expect)).rejects.toThrow('snapshot moved')
    expect(j.state.sends).toEqual({}); expect(signer).toHaveBeenCalledTimes(1)
  }, 120_000)

  it('refuses prevalidated fund signatures and altered call destinations before sending', async () => {
    const fund = file.calls.fund!, j = journal()
    await expect(safeEpochCall(f.ctx, j, f.admin, async () => `0x${'0'.repeat(128)}01`, 'fund', fund.to, fund.data, fund.expect)).rejects.toThrow('must be ECDSA')
    expect(j.state.sends).toEqual({})
    expect(() => epochCalls(f.ctx, { ...file, calls: { ...file.calls, fund: { ...fund, to: f.worker.account.address } } })).toThrow('fund calldata mismatch')
  }, 120_000)
})
