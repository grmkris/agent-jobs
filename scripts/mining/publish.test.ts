import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import testnet from '../../contracts/config/monad-testnet.json'
import { type DeploymentConfig } from '../../packages/sdk/src/deployment.ts'
import dev from '../../infra/dev.json'
import { dataHashOf } from './compute.ts'
import { CloudflareManifests, parseEpoch, publishEpoch, stageOf, type EpochReader, type ManifestsStore, type PublishStage, type PublishTarget } from './publish-lib.ts'
import { buildTree, proofOf } from './tree.ts'
import { type Hex } from './viem.ts'

const account = `0x${'1'.repeat(40)}` as const
const account2 = `0x${'2'.repeat(40)}` as const
const account3 = `0x${'3'.repeat(40)}` as const
test('dev publication reads the Sidequest stage manifest and exact resource identities', () => {
  const selected = stageOf('dev')
  expect(selected).toMatchObject({
    stage: 'dev', network: 'monad-testnet', chainId: 10143,
    origin: 'https://dev.sidequest.exchange',
    resources: { Api: 'sidequest-api-dev', Manifests: 'sidequest-dev-manifests' },
  })
})
const targetOf = (stage: PublishStage = 'dev'): PublishTarget => stageOf(stage, () => JSON.stringify({
  ...dev, stage, network: stage === 'dev' ? 'monad-testnet' : 'monad-mainnet', chainId: stage === 'dev' ? 10143 : 143,
  origin: stage === 'dev' ? dev.origin : 'https://sidequest.exchange',
  resources: stage === 'dev' ? dev.resources : { Api: 'sidequest-api-prod', Indexer: 'sidequest-indexer-prod', Explore: 'sidequest-explore-prod', Database: 'sidequest-prod-db', Manifests: 'sidequest-prod-manifests' },
}))
test('stage selection takes network and chain from the manifest and refuses missing or invalid configuration', () => {
  expect(stageOf('dev', path => {
    expect(path.pathname).toEndWith('/infra/dev.json')
    return JSON.stringify({ ...dev, network: 'monad-mainnet', chainId: 143 })
  })).toMatchObject({ network: 'monad-mainnet', chainId: 143 })
  expect(() => stageOf('prod', () => { throw new Error('missing stage file') })).toThrow('config-unavailable')
  for (const value of [null, {}, { ...dev, stage: 'prod' }, { ...dev, network: 'other' }, { ...dev, chainId: 0 },
    { ...dev, origin: 'invalid' }, { ...dev, resources: { ...dev.resources, Manifests: '../wrong-bucket' } }]) {
    expect(() => stageOf('dev', () => JSON.stringify(value))).toThrow('config-unavailable')
  }
})
const fileOf = (stage: PublishStage = 'dev') => {
  const chainId = stage === 'dev' ? 10143 : 143
  const inputs = { chainId, epoch: '0', window: { toBlockHash: `0x${'2'.repeat(64)}` }, fees: [] }
  const tree = buildTree([['0', account, '5'], ['0', account2, '7'], ['0', account3, '11']])
  const claims: Record<string, { amount: string; proof: Hex[] }> = {}
  tree.values.forEach((entry, index) => { claims[entry.value[1]] = { amount: entry.value[2], proof: proofOf(tree, index) } })
  return { chainId, epoch: '0', inputs, root: tree.tree[0]!, total: '23', dataHash: dataHashOf(inputs), tree, claims }
}
const bytesOf = (file: unknown) => Buffer.from(` ${JSON.stringify(file, null, 2)}\n\n`)
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`
const distributor = address(7)
const configOf = (stage: PublishStage = 'dev'): DeploymentConfig => ({
  ...structuredClone(testnet), network: stage === 'dev' ? 'monad-testnet' : 'monad-mainnet', chainId: stage === 'dev' ? 10143 : 143,
  deployment: {
    ...structuredClone(testnet.deployment), factory: address(3),
    main: { ...testnet.deployment.main, kind: 'sidequest-v1', factory: address(3) },
    sidequest: { block: 1, t0: 1, safe: address(2), factory: address(3), vault: address(4), feeSchedule: address(5), miningReserve: address(6), distributor, teamVesting: address(8) },
  },
})
const fake = (stage: PublishStage = 'dev') => {
  const file = fileOf(stage), puts: { bucket: string; key: string; bytes: Uint8Array }[] = []
  const live = { root: file.root, total: BigInt(file.total), dataHash: file.dataHash }
  const reader: EpochReader = { getChainId: async () => file.chainId, readRoot: async () => live }
  const store: ManifestsStore = {
    bucket: async () => 'fixture-bucket',
    put: async (bucket, key, bytes) => { puts.push({ bucket, key, bytes: Uint8Array.from(bytes) }) },
    get: async () => puts[0]!.bytes,
  }
  return { file, reader, store, live, puts }
}

test('mining publish validates dev and prod, uploads the exact file bytes and reads them back', async () => {
  for (const stage of ['dev', 'prod'] as const) {
    const f = fake(stage), bytes = bytesOf(f.file), reads: [string, bigint][] = []
    f.reader.readRoot = async (onChainDistributor, epoch) => { reads.push([onChainDistributor, epoch]); return f.live }
    await publishEpoch(bytes, targetOf(stage), configOf(stage), f.reader, f.store)
    expect(reads).toEqual([[distributor, 0n]])
    expect(f.puts).toHaveLength(1)
    expect(f.puts[0]!.key).toBe('mining/epoch-0.json')
    expect(Buffer.from(f.puts[0]!.bytes)).toEqual(bytes)
  }
})

test('wrong stage, config and RPC chain refuse before any upload', async () => {
  const f = fake(), bytes = bytesOf(f.file)
  await expect(publishEpoch(bytes, targetOf('prod'), configOf('prod'), f.reader, f.store)).rejects.toThrow('stage-chain-mismatch')
  await expect(publishEpoch(bytes, targetOf(), configOf('prod'), f.reader, f.store)).rejects.toThrow('config-unavailable')
  f.reader.getChainId = async () => 143
  await expect(publishEpoch(bytes, targetOf(), configOf(), f.reader, f.store)).rejects.toThrow('stage-chain-mismatch')
  expect(f.puts).toHaveLength(0)
})

test('root, total and dataHash must independently match the current on-chain epoch', async () => {
  for (const field of ['root', 'total', 'dataHash'] as const) {
    const f = fake()
    if (field === 'total') f.live.total = 6n
    else f.live[field] = `0x${'9'.repeat(64)}` as Hex
    await expect(publishEpoch(bytesOf(f.file), targetOf(), configOf(), f.reader, f.store)).rejects.toThrow('root-mismatch')
    expect(f.puts).toHaveLength(0)
  }
})

test('MINING-PUBLISH-001: missing or corrupt serialized dumps refuse before any PUT', async () => {
  const original = fileOf(), first = original.tree.values[0]!
  const changedValue = (patch: Record<string, unknown>) => ({ ...original.tree, values: [{ ...first, ...patch }, ...original.tree.values.slice(1)] })
  const invalidDumps: unknown[] = [
    undefined, null,
    { ...original.tree, format: 'other' },
    { ...original.tree, leafEncoding: ['uint256', 'bytes20', 'uint256'] },
    { ...original.tree, tree: original.tree.tree.map((node, index) => index === 1 ? `0x${'f'.repeat(64)}` : node) },
    { ...original.tree, tree: original.tree.tree.map((node, index) => index === 0 ? `0x${'0'.repeat(64)}` : node) },
    { ...original.tree, tree: original.tree.tree.slice(1) },
    changedValue({ value: ['1', account, '5'] }),
    changedValue({ value: ['0', account2, '5'] }),
    changedValue({ value: ['0', account, '6'] }),
    changedValue({ treeIndex: original.tree.values[1]!.treeIndex }),
    changedValue({ treeIndex: first.treeIndex + 0.5 }),
    { ...original.tree, values: original.tree.values.slice(1) },
    { ...original.tree, values: [first, first, original.tree.values[2]] },
  ]
  for (const tree of invalidDumps) {
    const f = fake()
    await expect(publishEpoch(bytesOf({ ...original, tree }), targetOf(), configOf(), f.reader, f.store)).rejects.toThrow()
    expect(f.puts).toHaveLength(0)
  }
})

test('MINING-PUBLISH-001: harmless dump value ordering still publishes the original bytes', async () => {
  const f = fake()
  f.file.tree.values.reverse()
  const bytes = bytesOf(f.file)
  await publishEpoch(bytes, targetOf(), configOf(), f.reader, f.store)
  expect(f.puts).toHaveLength(1)
  expect(Buffer.from(f.puts[0]!.bytes)).toEqual(bytes)
})

test('tampered inputs, claim amounts/proofs, duplicate account spellings and noncanonical epochs refuse', () => {
  const original = fileOf()
  for (const change of [
    (f: typeof original) => { f.inputs.window.toBlockHash = `0x${'3'.repeat(64)}` },
    (f: typeof original) => { f.claims[account].amount = '6' },
    (f: typeof original) => { f.claims[account].proof = [`0x${'0'.repeat(64)}`] },
    (f: typeof original) => { (f.claims as Record<string, unknown>)[`0x${'A'.repeat(40)}`] = f.claims[account] },
    (f: typeof original) => { f.epoch = '00' },
  ]) {
    const file = structuredClone(original)
    change(file)
    expect(() => parseEpoch(bytesOf(file), targetOf())).toThrow()
  }
})

test('a missing or changed readback is a failure, never reported as published', async () => {
  const f = fake()
  f.store.get = async () => new Uint8Array([0])
  await expect(publishEpoch(bytesOf(f.file), targetOf(), configOf(), f.reader, f.store)).rejects.toThrow('readback-mismatch')
  expect(f.puts).toHaveLength(1)
  f.store.get = async () => { throw new Error('provider failed') }
  await expect(publishEpoch(bytesOf(f.file), targetOf(), configOf(), f.reader, f.store)).rejects.toThrow('provider failed')
})

test('a failed chain read refuses before any upload', async () => {
  const f = fake()
  f.reader.readRoot = async () => { throw new Error('private RPC response') }
  await expect(publishEpoch(bytesOf(f.file), targetOf(), configOf(), f.reader, f.store)).rejects.toThrow('chain-unavailable')
  expect(f.puts).toHaveLength(0)
})

const env = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'fixture-token' }
const json = (result: unknown, result_info?: unknown) => new Response(JSON.stringify({ success: true, result, result_info }), { headers: { 'content-type': 'application/json' } })
const apiSettings = (stage: PublishStage, bucket: string) => ({
  tags: ['alchemy:stack:Sidequest', `alchemy:stage:${stage}`, 'alchemy:id:Api'],
  bindings: [
    { name: 'ALCHEMY_STACK_NAME', type: 'plain_text', text: 'Sidequest' },
    { name: 'ALCHEMY_STAGE', type: 'plain_text', text: stage },
    { name: 'NETWORK', type: 'plain_text', text: stage === 'dev' ? 'monad-testnet' : 'monad-mainnet' },
    { name: 'Manifests', type: 'r2_bucket', bucket_name: bucket },
  ],
})

test('fake Cloudflare R2 uses the existing stage binding and exact raw object PUT/GET, no resource creates', async () => {
  for (const stage of ['dev', 'prod'] as const) {
    const bucket = targetOf(stage).resources.Manifests
    const script = targetOf(stage).resources.Api
    const f = fake(stage), calls: { method: string; path: string }[] = []
    let saved = new Uint8Array()
    const request = (async (url: string | URL | Request, options?: RequestInit) => {
      const u = new URL(String(url)), path = u.pathname, method = options?.method ?? 'GET'
      calls.push({ method, path })
      expect(new Headers(options?.headers).get('authorization')).toBe('Bearer fixture-token')
      if (path.endsWith('/workers/scripts')) {
        expect(u.searchParams.get('tags')).toBe(`alchemy:stack:Sidequest:yes,alchemy:stage:${stage}:yes,alchemy:id:Api:yes`)
        return json([{ id: script }], { total_count: 1 })
      }
      if (path.endsWith(`/workers/scripts/${script}/settings`)) return json(apiSettings(stage, bucket))
      if (path.endsWith(`/r2/buckets/${bucket}`)) return json({ name: bucket })
      if (!path.endsWith(`/r2/buckets/${bucket}/objects/mining/epoch-0.json`)) throw new Error('unexpected request')
      expect(path).not.toContain('%2F')
      if (method === 'PUT') {
        expect(new Headers(options?.headers).get('content-type')).toBe('application/json')
        saved = Uint8Array.from(options!.body as Uint8Array)
        return json({})
      }
      return new Response(saved)
    }) as typeof fetch
    const bytes = bytesOf(f.file)
    await publishEpoch(bytes, targetOf(stage), configOf(stage), f.reader, new CloudflareManifests(env, request))
    expect(Buffer.from(saved)).toEqual(bytes)
    expect(calls.filter(c => c.method !== 'GET').map(c => c.method)).toEqual(['PUT'])
  }
})

test('unowned or wrong-stage bucket/Worker settings refuse without uploading', async () => {
  for (const mutate of [
    (s: ReturnType<typeof apiSettings>) => { s.tags = [] },
    (s: ReturnType<typeof apiSettings>) => { s.bindings[2]!.text = 'monad-mainnet' },
    (s: ReturnType<typeof apiSettings>) => { s.bindings[3]!.bucket_name = 'sidequest-prod-manifests' },
    (s: ReturnType<typeof apiSettings>) => { s.bindings.push(s.bindings[3]!) },
  ]) {
    const settings = apiSettings('dev', dev.resources.Manifests)
    mutate(settings)
    let puts = 0
    const request = (async (url: unknown, options?: RequestInit) => {
      if (options?.method === 'PUT') puts++
      return new URL(String(url)).pathname.endsWith('/workers/scripts') ? json([{ id: dev.resources.Api }]) : json(settings)
    }) as typeof fetch
    const f = fake()
    await expect(publishEpoch(bytesOf(f.file), targetOf(), configOf(), f.reader, new CloudflareManifests(env, request))).rejects.toThrow()
    expect(puts).toBe(0)
  }
})

test('ambiguous/incomplete or incorrectly named script census and arbitrary provider errors expose only fixed refusal codes', async () => {
  for (const stage of ['dev', 'prod'] as const) {
    for (const [result, info] of [[[], undefined], [[{ id: 'a' }, { id: 'b' }], undefined], [[{ id: targetOf(stage).resources.Api }], { total_count: 2 }], [[{ id: 'sidequest-api-other' }], { total_count: 1 }], [[null], undefined]]) {
      const request = (async () => json(result, info)) as typeof fetch
      await expect(new CloudflareManifests(env, request).bucket(targetOf(stage))).rejects.toThrow('worker-identity-invalid')
    }
  }
  const request = (async () => { throw new Error('private provider body') }) as typeof fetch
  await expect(new CloudflareManifests(env, request).bucket(targetOf())).rejects.toThrow('cloudflare-unavailable')
  const failedPut = (async () => new Response(JSON.stringify({ success: false, errors: [{ message: 'private provider body' }] }))) as typeof fetch
  await expect(new CloudflareManifests(env, failedPut).put(dev.resources.Manifests, 'mining/epoch-0.json', new Uint8Array())).rejects.toThrow('cloudflare-unavailable')
})

test('CLI requires an explicit supported stage and emits no file/provider values on refusal', () => {
  for (const args of [[], ['private-file'], ['private-file', '--stage', 'other'], ['private-file', '--stage', 'staging']]) {
    const run = spawnSync('bun', [new URL('./publish.ts', import.meta.url).pathname, ...args], { encoding: 'utf8', timeout: 30_000 })
    expect(run.status).not.toBe(0)
    expect(run.stdout).toBe('')
    expect(run.stderr.trim()).toBe('mining:publish refused: usage')
  }
})
