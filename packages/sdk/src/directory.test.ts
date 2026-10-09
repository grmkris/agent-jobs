import { decodeFunctionData, type TypedDataDefinition, hashTypedData, recoverTypedDataAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import {
  type DirectoryEnvelope,
  directoryRecordHash,
  directoryTypedData,
  directoryTypedDataJson,
  prepareDirectoryIdentity,
} from './directory.ts'
import { deployment } from './deployment.ts'
import { identityAbi } from './abi/index.ts'

const account = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const record = (kind: DirectoryEnvelope['kind'], payload: Record<string, unknown>): DirectoryEnvelope => ({
  version: 1,
  kind,
  chainId: 10143,
  identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
  audience: 'https://dev.sidequest.exchange',
  agentId: '2013',
  wallet: account.address,
  generation: 1,
  nonce: 3,
  issuedAt: 1_790_000_000,
  expiresAt: 1_790_000_300,
  payload,
})

describe('a directory record as signer JSON', () => {
  for (const r of [
    record('Enrollment', {
      profile: { name: 'Reviewer', description: 'Reviews code', services: [] },
      delegate: '0x0000000000000000000000000000000000000000',
      adDelegate: false,
      grantExpiresAt: 0,
      enrolled: true,
    }),
    record('ServiceAd', {
      serviceId: 'review',
      name: 'Code review',
      description: '',
      inputs: 'A PR',
      outputs: 'Comments',
      turnaroundSeconds: 3600,
      price: { model: 'quote', amountBaseUnits: '0', token: '0x0000000000000000000000000000000000000000' },
    }),
    record('RevokeAd', { serviceId: 'review' }),
  ]) {
    it(`hashes and recovers like the record (${r.kind})`, async () => {
      const json = JSON.parse(directoryTypedDataJson(r)) as TypedDataDefinition
      expect(Object.keys(json.types)).toEqual(['EIP712Domain', r.kind])
      expect(hashTypedData(json)).toBe(directoryRecordHash(r))
      const signature = await account.signTypedData(directoryTypedData(r))
      expect(await recoverTypedDataAddress({ ...json, signature })).toBe(account.address)
    })
  }

  it('binds the audience: another origin is another digest', () => {
    const r = record('RevokeAd', { serviceId: 'review' })
    expect(directoryRecordHash({ ...r, audience: 'https://sidequest.exchange' })).not.toBe(directoryRecordHash(r))
  })
})

describe('directory identity transactions', () => {
  const registry = deployment('monad-testnet').identity
  const profile = { name: 'Reviewer', description: 'Reviews code', services: [] }

  it('prepares a registration for a new agent', () => {
    const prepared = prepareDirectoryIdentity(registry, profile)
    expect(decodeFunctionData({ abi: identityAbi, data: prepared.transaction.data }).functionName).toBe('register')
    expect(prepared.agentURI.startsWith('data:application/json,')).toBe(true)
  })

  it('prepares setAgentURI for an existing agent', () => {
    const prepared = prepareDirectoryIdentity(registry, profile, '2089')
    const decoded = decodeFunctionData({
      abi: identityAbi,
      data: prepared.transaction.data,
    })
    expect(decoded.functionName).toBe('setAgentURI')
    expect(decoded.args?.[0]).toBe(2089n)
    expect(decoded.args?.[1]).toBe(prepared.agentURI)
  })
})
