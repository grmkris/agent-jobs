import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as sdk from '@sidequest/sdk'
import { type Address, decodeFunctionData } from 'viem'
import { expect, it, vi } from 'vitest'
import { miningProof, miningEpoch, verifyMiningClaim } from './mining.ts'
import { hostedToolNames, readOnlyHostedTools } from './admission.ts'
import artifact from '../test/fixtures/mining-epoch.json'

const account = `0x${'1'.repeat(40)}` as Address, other = `0x${'2'.repeat(40)}` as Address
function fixture() {
  const base = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
  const file = structuredClone(artifact)
  const readContract = vi.fn(async ({ functionName }: { functionName: string }): Promise<unknown> => functionName === 'rootOf'
    ? { root: file.root, total: 18n, claimed: 0n, dataHash: file.dataHash } : false)
  const ctx = { ...base, deployment: { ...base.deployment, sidequest: { distributor: base.stack.holding, factory: base.stack.factory } },
    publicClient: { ...base.publicClient, readContract } } as unknown as sdk.Ctx
  return { ctx, file, readContract, source: { load: vi.fn(async () => file) } }
}
it('loads the contracts-produced claims from a configured path and returns the verified OZ proof and exact claim call', async () => {
  const f = fixture(), path = await mkdtemp(join(tmpdir(), 'sidequest-mining-'))
  try {
    await writeFile(join(path, 'epoch-3.json'), JSON.stringify(f.file))
    const source = { load: async (epoch: string) => JSON.parse(await readFile(join(path, `epoch-${miningEpoch(epoch)}.json`), 'utf8')) as unknown }
    const proof = await miningProof(f.ctx, account, '3', source)
    expect(proof).toMatchObject({ epoch: '3', account, amount: '7', eligible: true, claimed: false, root: f.file.root })
    expect(verifyMiningClaim(proof.root, '3', account, '7', proof.proof)).toBe(true)
    expect(decodeFunctionData({ abi: sdk.epochDistributorAbi, data: proof.transactions[0]!.data })).toMatchObject({ functionName: 'claim', args: [3n, account, 7n, proof.proof] })
    expect(proof.transactions[0]!.gas).toBe('500000')
    expect(hostedToolNames.has('mining_proof')).toBe(true)
    expect(readOnlyHostedTools.has('mining_proof')).toBe(true)
  } finally { await rm(path, { recursive: true }) }
})
it('claimed accounts and absent leaves return no claim transaction; RPC failure refuses the proof', async () => {
  const f = fixture()
  f.readContract.mockImplementation(async ({ functionName }) => functionName === 'rootOf' ? { root: f.file.root, total: 18n, claimed: 7n, dataHash: f.file.dataHash } : true)
  expect(await miningProof(f.ctx, account, '3', f.source)).toMatchObject({ amount: '7', claimed: true, transactions: [] })
  expect(await miningProof(f.ctx, `0x${'3'.repeat(40)}`, '3', f.source)).toMatchObject({ amount: '0', eligible: false, transactions: [] })
  f.readContract.mockRejectedValueOnce(new Error('RPC unavailable'))
  await expect(miningProof(f.ctx, account, '3', f.source)).rejects.toThrow('RPC unavailable')
})
it('missing artifacts and wrong chain, epoch, data hash, total, amount, proof or beneficiary refuse', async () => {
  const f = fixture()
  const claims = f.file.claims as Record<string, { amount: string; proof: string[] }>
  await expect(miningProof(f.ctx, account, '3', { load: async () => null })).rejects.toThrow('unavailable')
  const invalid = [
    { ...f.file, chainId: 143 }, { ...f.file, epoch: '4' }, { ...f.file, total: '19' }, { ...f.file, dataHash: sdk.hashText('tampered') },
    { ...f.file, inputs: { ...f.file.inputs, fees: ['tampered'] } },
    { ...f.file, claims: null },
    { ...f.file, claims: { [account]: { amount: '8', proof: claims[account]!.proof } } },
    { ...f.file, claims: { [account]: { amount: '7', proof: [sdk.hashText('corrupt')] } } },
    { ...f.file, claims: { [account]: { amount: '7', proof: ['0x1234'] } } },
    { ...f.file, claims: { [account]: { amount: '7', proof: claims[other]!.proof } } },
  ]
  for (const file of invalid) await expect(miningProof(f.ctx, account, '3', { load: async () => file })).rejects.toThrow()
})
it('the on-chain current root, total and dataHash must all match, even when a file proof is valid', async () => {
  const f = fixture()
  for (const root of [{ root: sdk.hashText('other root'), total: 18n, dataHash: f.file.dataHash },
    { root: f.file.root, total: 19n, dataHash: f.file.dataHash }, { root: f.file.root, total: 18n, dataHash: sdk.hashText('other data') }]) {
    f.readContract.mockResolvedValueOnce(root)
    await expect(miningProof(f.ctx, account, '3', f.source)).rejects.toThrow('current root')
  }
})
it('malformed epoch ids are refused before artifact or RPC access', async () => {
  const f = fixture()
  for (const epoch of ['../3', '-1', '03', '1e2', (1n << 256n).toString()]) await expect(miningProof(f.ctx, account, epoch, f.source)).rejects.toThrow('uint256')
  expect(f.source.load).not.toHaveBeenCalled(); expect(f.readContract).not.toHaveBeenCalled()
})
