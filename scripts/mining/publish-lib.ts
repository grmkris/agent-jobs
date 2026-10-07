import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { deploymentFromConfig, type DeploymentConfig, type Network } from '../../packages/sdk/src/deployment.ts'
import { dataHashOf } from './compute.ts'
import { buildTree, leafHash, verifyProof, type LeafValue } from './tree.ts'
import { maxUint256, type Address, type Hex } from './viem.ts'

export type PublishStage = 'dev' | 'prod'
export interface PublishTarget {
  stage: PublishStage
  network: Network
  chainId: number
  origin: string
  resources: Record<'Api' | 'Indexer' | 'Explore' | 'Database' | 'Manifests', string>
}
type Refusal = 'usage' | 'stage-chain-mismatch' | 'config-unavailable' | 'artifact-invalid' | 'data-hash-mismatch'
  | 'claims-invalid' | 'chain-unavailable' | 'root-mismatch' | 'credentials-missing' | 'cloudflare-unavailable'
  | 'worker-identity-invalid' | 'bucket-identity-invalid' | 'readback-mismatch'
export class MiningPublishError extends Error {
  constructor(readonly code: Refusal) { super(code) }
}
const refuse = (code: Refusal): never => { throw new MiningPublishError(code) }
export const stageOf = (stage: string, read = (path: URL) => readFileSync(path, 'utf8')): PublishTarget => {
  if (stage !== 'dev' && stage !== 'prod') return refuse('usage')
  try {
    const selected = JSON.parse(read(new URL(`../../infra/${stage}.json`, import.meta.url))) as PublishTarget
    if (selected.stage !== stage || !['monad-testnet', 'monad-mainnet'].includes(selected.network)
      || !Number.isSafeInteger(selected.chainId) || selected.chainId <= 0
      || new URL(selected.origin).origin !== selected.origin) return refuse('config-unavailable')
    for (const resource of ['Api', 'Indexer', 'Explore', 'Database', 'Manifests'] as const) {
      if (typeof selected.resources?.[resource] !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(selected.resources[resource])) return refuse('config-unavailable')
    }
    return selected
  } catch { return refuse('config-unavailable') }
}
const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return refuse('artifact-invalid')
  return value as Record<string, unknown>
}
const uint = (value: unknown): string => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value) || BigInt(value) > maxUint256) return refuse('artifact-invalid')
  return value
}
const hash = (value: unknown): Hex => {
  if (typeof value !== 'string' || !/^0x[\da-fA-F]{64}$/.test(value)) return refuse('artifact-invalid')
  return value.toLowerCase() as Hex
}
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** Validate all claims as well as inputs: dataHash commits to inputs, not to the claims table. */
export function parseEpoch(bytes: Uint8Array, selected: PublishTarget) {
  let parsed: unknown
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { return refuse('artifact-invalid') }
  const file = record(parsed)
  const epoch = uint(file.epoch), total = BigInt(uint(file.total)), root = hash(file.root), dataHash = hash(file.dataHash)
  if (file.chainId !== selected.chainId || (file.stage !== undefined && file.stage !== selected.stage)) return refuse('stage-chain-mismatch')
  const inputs = record(file.inputs)
  if (inputs.chainId !== file.chainId || inputs.epoch !== epoch) return refuse('stage-chain-mismatch')
  if (dataHashOf(inputs) !== dataHash) return refuse('data-hash-mismatch')
  const claims = record(file.claims), leaves: LeafValue[] = []
  let sum = 0n
  for (const [account, raw] of Object.entries(claims)) {
    if (!/^0x[\da-f]{40}$/.test(account)) return refuse('claims-invalid')
    const claim = record(raw), amount = uint(claim.amount)
    if (BigInt(amount) === 0n || !Array.isArray(claim.proof) || claim.proof.length > 256) return refuse('claims-invalid')
    const proof = claim.proof.map(hash), leaf = [epoch, account as Address, amount] as const
    if (!verifyProof(root, leafHash(leaf), proof)) return refuse('claims-invalid')
    sum += BigInt(amount)
    leaves.push(leaf)
  }
  if (total === 0n || sum !== total || leaves.length === 0) return refuse('claims-invalid')

  // The serialized StandardMerkleTree dump must reproduce the same claims,
  // nodes and indexes before the original bytes can be published.
  const dump = record(file.tree)
  if (dump.format !== 'standard-v1' || !Array.isArray(dump.leafEncoding)
    || dump.leafEncoding.length !== 3 || dump.leafEncoding[0] !== 'uint256'
    || dump.leafEncoding[1] !== 'address' || dump.leafEncoding[2] !== 'uint256'
    || !Array.isArray(dump.tree) || !Array.isArray(dump.values)) return refuse('artifact-invalid')
  const rebuilt = buildTree(leaves)
  if (dump.tree.length !== rebuilt.tree.length || dump.values.length !== leaves.length) return refuse('claims-invalid')
  const nodes = dump.tree.map(hash)
  if (nodes.some((node, index) => node !== rebuilt.tree[index])) return refuse('claims-invalid')
  const expected = new Map(rebuilt.values.map(({ value, treeIndex }) => [`${value[0]}:${value[1]}:${value[2]}`, treeIndex]))
  const indexes = new Set<number>()
  for (const raw of dump.values) {
    const entry = record(raw), value = entry.value, treeIndex = entry.treeIndex
    if (!Array.isArray(value) || value.length !== 3 || typeof treeIndex !== 'number' || !Number.isSafeInteger(treeIndex)
      || treeIndex < 0 || treeIndex >= rebuilt.tree.length) return refuse('artifact-invalid')
    const valueEpoch = uint(value[0]), account = value[1], amount = uint(value[2])
    if (typeof account !== 'string' || !/^0x[\da-f]{40}$/.test(account) || indexes.has(treeIndex)) return refuse('artifact-invalid')
    indexes.add(treeIndex)
    if (expected.get(`${valueEpoch}:${account}:${amount}`) !== treeIndex) return refuse('claims-invalid')
  }
  if (indexes.size !== leaves.length || rebuilt.tree[0] !== root) return refuse('claims-invalid')
  return { epoch, root, total, dataHash }
}

export interface EpochReader {
  getChainId(): Promise<number>
  readRoot(distributor: Address, epoch: bigint): Promise<{ root: Hex; total: bigint; dataHash: Hex }>
}
export interface ManifestsStore {
  bucket(selected: PublishTarget): Promise<string>
  put(bucket: string, key: string, bytes: Uint8Array): Promise<void>
  get(bucket: string, key: string): Promise<Uint8Array>
}

/** No chain writes. Upload the captured input bytes only after all stage, contract and artifact checks. */
export async function publishEpoch(bytes: Uint8Array, selected: PublishTarget, config: DeploymentConfig, reader: EpochReader, store: ManifestsStore) {
  const file = parseEpoch(bytes, selected)
  let distributor: Address
  try {
    const d = deploymentFromConfig(selected.network, config)
    if (d.chainId !== selected.chainId) return refuse('stage-chain-mismatch')
    if (d.sidequest === null) return refuse('config-unavailable')
    distributor = d.sidequest.distributor
  } catch (error) {
    if (error instanceof MiningPublishError) throw error
    return refuse('config-unavailable')
  }
  let chainId: number
  try { chainId = await reader.getChainId() } catch { return refuse('chain-unavailable') }
  if (chainId !== selected.chainId) return refuse('stage-chain-mismatch')
  const bucket = await store.bucket(selected)
  let live: Awaited<ReturnType<EpochReader['readRoot']>>
  try { live = await reader.readRoot(distributor, BigInt(file.epoch)) } catch { return refuse('chain-unavailable') }
  if (live.root.toLowerCase() !== file.root || live.total !== file.total || live.dataHash.toLowerCase() !== file.dataHash) return refuse('root-mismatch')
  const key = `mining/epoch-${file.epoch}.json`
  await store.put(bucket, key, bytes)
  const readback = await store.get(bucket, key)
  if (sha256(readback) !== sha256(bytes)) return refuse('readback-mismatch')
}

/** Plain REST only: never initialize Alchemy state or allow a guessed bucket suffix. */
export class CloudflareManifests implements ManifestsStore {
  #base: string
  #headers: Record<string, string>
  constructor(env: NodeJS.ProcessEnv, private readonly request: typeof fetch = fetch) {
    if (!/^[\da-f]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID ?? '') || !env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_API_TOKEN === 'unset') refuse('credentials-missing')
    this.#base = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`
    this.#headers = { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }
  }
  async #fetch(path: string, options: RequestInit = {}) {
    try {
      const response = await this.request(`${this.#base}${path}`, { ...options, headers: { ...this.#headers, ...options.headers }, redirect: 'error', signal: AbortSignal.timeout(30_000) })
      if (!response.ok) return refuse('cloudflare-unavailable')
      return response
    } catch { return refuse('cloudflare-unavailable') }
  }
  async #json(path: string) {
    try {
      const body = await (await this.#fetch(path)).json() as { success?: boolean; result?: unknown; result_info?: { total_count?: number } }
      if (body.success !== true) return refuse('cloudflare-unavailable')
      return body
    } catch { return refuse('cloudflare-unavailable') }
  }
  async bucket(selected: PublishTarget) {
    const { stage } = selected
    const tags = ['alchemy:stack:Sidequest', `alchemy:stage:${stage}`, 'alchemy:id:Api']
    // Verify the sole tagged Worker against the manifest's exact physical identity.
    const body = await this.#json(`/workers/scripts?tags=${encodeURIComponent(tags.map(tag => `${tag}:yes`).join(','))}`)
    const rows = body.result
    if (!Array.isArray(rows) || rows.length !== 1 || (body.result_info?.total_count !== undefined && body.result_info.total_count !== rows.length)) return refuse('worker-identity-invalid')
    const script = (rows[0] as { id?: string } | null)?.id
    if (script !== selected.resources.Api) return refuse('worker-identity-invalid')
    const settings = (await this.#json(`/workers/scripts/${script}/settings`)).result as { tags?: string[]; bindings?: { name: string; type: string; text?: string; bucket_name?: string }[] }
    if (!Array.isArray(settings?.tags) || tags.some(tag => !settings.tags!.includes(tag))) return refuse('worker-identity-invalid')
    const bindings = settings.bindings
    if (!Array.isArray(bindings)) return refuse('worker-identity-invalid')
    const bound = (name: string) => bindings.filter(b => b.name === name)
    for (const [name, text] of [['ALCHEMY_STACK_NAME', 'Sidequest'], ['ALCHEMY_STAGE', stage], ['NETWORK', selected.network]]) {
      const matches = bound(name!)
      if (matches.length !== 1 || matches[0]!.type !== 'plain_text' || matches[0]!.text !== text) return refuse('worker-identity-invalid')
    }
    const manifests = bound('Manifests'), bucket = manifests[0]?.bucket_name ?? ''
    if (manifests.length !== 1 || manifests[0]!.type !== 'r2_bucket' || bucket !== selected.resources.Manifests) return refuse('bucket-identity-invalid')
    const bucketInfo = (await this.#json(`/r2/buckets/${bucket}`)).result as { name?: string }
    if (bucketInfo?.name !== bucket) return refuse('bucket-identity-invalid')
    return bucket
  }
  async put(bucket: string, key: string, bytes: Uint8Array) {
    try {
      const response = await this.#fetch(`/r2/buckets/${bucket}/objects/${key}`, { method: 'PUT', body: Buffer.from(bytes), headers: { 'content-type': 'application/json' } })
      const body = await response.json() as { success?: boolean }
      if (body.success !== true) return refuse('cloudflare-unavailable')
    } catch { return refuse('cloudflare-unavailable') }
  }
  async get(bucket: string, key: string) {
    return new Uint8Array(await (await this.#fetch(`/r2/buckets/${bucket}/objects/${key}`)).arrayBuffer())
  }
}
