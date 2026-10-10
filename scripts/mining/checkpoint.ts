import { Schema } from 'effect'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataHashOf } from './compute.ts'
import { chainOrder } from './credit.ts'
import { MiningLedger } from './ledger.ts'
import { isLedgerRecord, type EpochChainRecord } from './ledger-chain.ts'
import {
  parseState,
  stateHashOf,
  stateOf,
  ledgerFromState,
  type MiningState,
  type StateContext,
  type StateContracts,
} from './state.ts'
import type { Address, Hex, PublicClient } from './viem.ts'
import { budgetOf, epochWindowOf, firstBlockAtOrAfter, reserveAbi, type LogPager } from './chain.ts'
import { verifiedPriceList, type PriceListFile } from './prices.ts'
import { cumulativeBudget, replayLots } from './lots.ts'

const object = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))
const zero = `0x${'0'.repeat(64)}` as const
const hashSchema = Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{64}$/))
const hash = (value: unknown): Hex => {
  const result = Schema.decodeUnknownSync(hashSchema)(value)
  // SAFETY: The schema accepts only a lowercase bytes32 hex string.
  return result as Hex
}
export interface CheckpointPointer {
  epoch: string
  dataHash: Hex
  stateHash: Hex
}
export interface CheckpointCommitment {
  previous: CheckpointPointer | null
  stateHash: Hex
}
export interface CheckpointReader {
  readRoot(epoch: bigint): Promise<{ dataHash: Hex }>
  blockHash(block: bigint): Promise<Hex | null>
}
export interface Anchor {
  epoch: bigint
  dataHash: Hex
}
export interface CheckpointFiles {
  artifact: Record<string, unknown>
  state: MiningState
}
export interface CheckpointStore {
  get(bucket: string, key: string): Promise<Uint8Array>
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const json = (bytes: Uint8Array): Record<string, unknown> =>
  object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))

/** The latest published v2 epoch anchors replay; empty epochs are part of the next replay range. */
export async function findAnchor(reader: CheckpointReader, epoch: bigint, fromEpoch: bigint): Promise<Anchor | null> {
  for (let candidate = epoch - 1n; candidate >= fromEpoch; candidate--) {
    const root = await reader.readRoot(candidate)
    if (root.dataHash.toLowerCase() !== zero) return { epoch: candidate, dataHash: hash(root.dataHash.toLowerCase()) }
  }
  return null
}
async function checkpointBytes(input: {
  dir: string
  name: string
  published?: { store: CheckpointStore; bucket: string } | undefined
}) {
  try {
    return readFileSync(join(input.dir, input.name))
  } catch {
    if (input.published !== undefined) {
      try {
        return await input.published.store.get(input.published.bucket, `mining/${input.name}`)
      } catch {
        /* Missing in both stores refuses below. */
      }
    }
    throw new Error(`missing checkpoint file ${input.name}`)
  }
}
export async function loadCheckpoint(
  anchor: Anchor,
  dir: string,
  published?: { store: CheckpointStore; bucket: string },
): Promise<CheckpointFiles> {
  const bytes = await checkpointBytes({ dir, name: `epoch-${anchor.epoch}.json`, published })
  const stateBytes = await checkpointBytes({ dir, name: `state-${anchor.epoch}.json`, published })
  return { artifact: json(bytes), state: parseState(json(stateBytes)) }
}

interface CheckpointVerification {
  anchor: Anchor
  files: CheckpointFiles
  reader: CheckpointReader
  chainId: number
  rule: unknown
  contracts: StateContracts
  genesisBlock: bigint
}
function verifyIdentity(input: CheckpointVerification, inputs: Record<string, unknown>) {
  const { anchor, files } = input,
    artifact = files.artifact,
    state = files.state,
    window = object(inputs.window)
  if (artifact.rule !== 2 || !equal(inputs.rule, input.rule)) throw new Error('checkpoint rule mismatch')
  const contractsMatch = equal(state.contracts, input.contracts) && equal(inputs.holdings, input.contracts.holdings)
  if (!contractsMatch) throw new Error('checkpoint contracts mismatch')
  const chainMatches =
    state.chainId === String(input.chainId) && inputs.chainId === input.chainId && artifact.chainId === input.chainId
  if (!chainMatches) throw new Error('checkpoint chain mismatch')
  const epochMatches =
    state.epoch === String(anchor.epoch) && inputs.epoch === state.epoch && artifact.epoch === state.epoch
  if (!epochMatches) throw new Error('checkpoint epoch mismatch')
  if (state.genesisBlock !== String(input.genesisBlock)) throw new Error('checkpoint genesis mismatch')
  if (state.block !== window.toBlock || state.blockHash !== window.toBlockHash)
    throw new Error('checkpoint window mismatch')
}

/** Compare the commitments before restoring any state into the replay ledger. */
export async function verifyCheckpoint(input: CheckpointVerification): Promise<CheckpointPointer> {
  const { anchor, files, reader } = input
  const artifact = files.artifact
  const state = files.state
  const inputs = object(artifact.inputs),
    checkpoint = object(inputs.checkpoint)
  const inputMatches = dataHashOf(inputs) === anchor.dataHash
  const artifactMatches = artifact.dataHash === anchor.dataHash
  if (!inputMatches || !artifactMatches) throw new Error('checkpoint input dataHash mismatch')
  const stateHash = hash(checkpoint.stateHash)
  if (stateHashOf(state) !== stateHash) throw new Error('checkpoint stateHash mismatch')
  verifyIdentity(input, inputs)
  const live = await reader.blockHash(BigInt(state.block))
  if (live === null || live.toLowerCase() !== state.blockHash) throw new Error('checkpoint block hash mismatch')
  return { epoch: String(anchor.epoch), dataHash: anchor.dataHash, stateHash }
}

export function checkpointPointerOf(value: unknown): CheckpointPointer | null {
  if (value === null) return null
  const pointer = object(value),
    epoch = Schema.decodeUnknownSync(Schema.String)(pointer.epoch)
  if (!/^(0|[1-9][0-9]*)$/.test(epoch)) throw new Error('invalid checkpoint epoch')
  return { epoch, dataHash: hash(pointer.dataHash), stateHash: hash(pointer.stateHash) }
}

export interface CheckpointReplayInput {
  epoch: bigint
  fromEpoch: bigint
  fromBlock: bigint
  toBlock: bigint
  genesisBlock: bigint
  chainId: number
  rule: unknown
  contracts: StateContracts
  reader: CheckpointReader
  checkpointDir: string
  fromGenesis?: boolean
  previous?: CheckpointPointer | null
  published?: { store: CheckpointStore; bucket: string }
  stateContext(epoch: bigint): Promise<StateContext>
  readRecords(from: bigint, to: bigint): Promise<EpochChainRecord[]>
}
async function selectedAnchor(input: CheckpointReplayInput): Promise<Anchor | null> {
  if (input.previous === undefined) return findAnchor(input.reader, input.epoch, input.fromEpoch)
  if (input.previous === null) return null
  const epoch = BigInt(input.previous.epoch)
  if (epoch < input.fromEpoch || epoch >= input.epoch) throw new Error('checkpoint previous epoch outside v2 range')
  const root = await input.reader.readRoot(epoch)
  if (root.dataHash.toLowerCase() !== input.previous.dataHash) throw new Error('checkpoint previous dataHash mismatch')
  return { epoch, dataHash: input.previous.dataHash }
}
function ledgerThrough(records: readonly EpochChainRecord[], block: bigint) {
  const ledger = new MiningLedger()
  for (const record of records.filter((r) => r.block <= block).toSorted(chainOrder))
    if (isLedgerRecord(record)) ledger.apply(record)
  return ledger
}

/** Audit mode never reads checkpoint files: it independently computes the anchor's end-state hash. */
export async function prepareCheckpointReplay(input: CheckpointReplayInput) {
  const anchor = await selectedAnchor(input)
  if (anchor === null)
    return {
      ledger: new MiningLedger(),
      records: await input.readRecords(input.genesisBlock, input.toBlock),
      previous: null,
    }
  const anchorContext = await input.stateContext(anchor.epoch)
  if (anchorContext.block >= input.fromBlock) throw new Error('checkpoint block overlaps target epoch')
  let ledger: MiningLedger, records: EpochChainRecord[], previous: CheckpointPointer
  if (input.fromGenesis) {
    records = await input.readRecords(input.genesisBlock, input.toBlock)
    const state = stateOf(ledgerThrough(records, anchorContext.block), anchorContext)
    previous = { epoch: String(anchor.epoch), dataHash: anchor.dataHash, stateHash: stateHashOf(state) }
    ledger = new MiningLedger()
  } else {
    const files = await loadCheckpoint(anchor, input.checkpointDir, input.published)
    previous = await verifyCheckpoint({ ...input, anchor, files })
    if (
      files.state.block !== String(anchorContext.block) ||
      files.state.blockHash !== anchorContext.blockHash ||
      files.state.shares.pruneBlock !== String(anchorContext.pruneBlock)
    )
      throw new Error('checkpoint boundary mismatch')
    ledger = ledgerFromState(files.state)
    records = await input.readRecords(anchorContext.block + 1n, input.toBlock)
  }
  if (input.previous !== undefined && !equal(previous, input.previous))
    throw new Error('checkpoint previous stateHash mismatch')
  return { ledger, records, previous }
}

/** The dispatcher is outside M3 ownership; the owned runners also accept these documented CLI flags. */
export function checkpointFlags(argv: readonly string[], defaultDir: string) {
  const index = argv.indexOf('--checkpoint-dir')
  const output = argv.indexOf('--out')
  const fallback = output < 0 ? defaultDir : argv[output + 1]
  const dir = index < 0 ? fallback : argv[index + 1]
  if (dir === undefined || dir.startsWith('--')) throw new Error('--checkpoint-dir requires a directory')
  return { checkpointDir: dir, fromGenesis: argv.includes('--from-genesis') }
}

export async function readStateContext(input: {
  c: PublicClient
  epoch: bigint
  chainId: number
  reserve: Address
  deploymentBlock: bigint
  genesisBlock: bigint
  head: bigint
  delay: bigint
  contracts: StateContext['contracts']
}): Promise<StateContext> {
  const { c, epoch, reserve, deploymentBlock, head, delay } = input
  const window = await epochWindowOf(c, reserve, epoch)
  const block = (await firstBlockAtOrAfter(c, window.end, deploymentBlock, head)) - 1n
  const blockHash = (await c.getBlock({ blockNumber: block })).hash
  if (blockHash === null) throw new Error('checkpoint end block has no hash')
  const next = await epochWindowOf(c, reserve, epoch + 1n)
  const shareStart = next.start > delay ? next.start - delay : 0n
  const pruneBlock = await firstBlockAtOrAfter(c, shareStart, deploymentBlock, head)
  return {
    chainId: input.chainId,
    epoch,
    block,
    blockHash,
    genesisBlock: input.genesisBlock,
    contracts: input.contracts,
    pruneBlock,
  }
}

/** Restored funding plus the new finalized logs replaces the deployment-wide budget scan. */
export async function checkpointBudgetOf(input: {
  c: PublicClient
  reserve: Address
  epoch: bigint
  head: bigint
  ledger: MiningLedger
  recompute: boolean
}) {
  const { c, reserve, epoch, head, ledger } = input
  const scheduled = await c.readContract({
    address: reserve,
    abi: reserveAbi,
    functionName: 'cumulativeBudget',
    args: [epoch],
    blockNumber: head,
  })
  if (scheduled !== cumulativeBudget(epoch)) throw new Error('deployed mining schedule differs from note 17')
  const totalFunded = await c.readContract({
    address: reserve,
    abi: reserveAbi,
    functionName: 'totalFunded',
    blockNumber: head,
  })
  const latest = await c.readContract({ address: reserve, abi: reserveAbi, functionName: 'totalFunded' })
  if (latest !== totalFunded) throw new Error('reserve funding is not final yet')
  if (ledger.funding.reduce((sum, event) => sum + event.amount, 0n) !== totalFunded)
    throw new Error('EpochFunded sum differs from totalFunded')
  const funding = input.recompute ? ledger.funding.filter((event) => event.epoch <= epoch) : ledger.funding
  return { cumulativeBudget: scheduled, totalFunded, ...replayLots(epoch, funding) }
}

export async function initialBudgetOf(input: {
  version: 1 | 2
  c: PublicClient
  lc: PublicClient
  reserve: Address
  epoch: bigint
  deployBlock: bigint
  head: bigint
  pager: LogPager
  recompute: boolean
}) {
  if (input.version === 2)
    return { cumulativeBudget: cumulativeBudget(input.epoch), totalFunded: 0n, ...replayLots(input.epoch, []) }
  if (input.recompute) return (await import('./recompute.ts')).recomputeBudgetOf(input)
  return budgetOf(input.c, input.reserve, input.epoch, input.deployBlock, input.head, input.pager.page)
}
export const previousSignedPrice = (value: Awaited<ReturnType<typeof verifiedPriceList>> | undefined) =>
  value === undefined
    ? null
    : {
        epoch: String(value.prices.epoch),
        factoryUsdPrice: String(value.prices.factoryUsdPrice),
        signer: value.signer,
        signature: value.signature,
        tokens: value.prices.tokens.map((token) => ({ ...token, usdPrice: String(token.usdPrice) })),
      }

export async function previousPriceOf(
  options: { epoch: bigint; previousFile?: PriceListFile; previousPath?: string },
  input: {
    samples: bigint[]
    chainId: number
    distributor: Address
    owners: Address[]
  },
) {
  if (input.samples.length !== 0 || options.epoch === 0n) return undefined
  let file = options.previousFile
  if (file === undefined) {
    if (options.previousPath === undefined)
      throw new Error('no pool samples: provide the previous epoch signed prices with --previous-prices')
    // SAFETY: verifiedPriceList validates the message and signature immediately after this read.
    const parsed = JSON.parse(readFileSync(options.previousPath, 'utf8')) as PriceListFile & {
      priceList?: PriceListFile
    }
    file = parsed.priceList ?? parsed
  }
  return verifiedPriceList(file, {
    epoch: options.epoch - 1n,
    chainId: input.chainId,
    distributor: input.distributor,
    owners: input.owners,
  })
}
