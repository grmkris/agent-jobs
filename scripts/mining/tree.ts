import { encodeAbiParameters, keccak256, concat, type Hex } from './viem.ts'

/**
 * OpenZeppelin `StandardMerkleTree` (@openzeppelin/merkle-tree 1.0.8, format `standard-v1`) for the distributor's leaf,
 * `(uint256 epoch, address account, uint256 amount)`: the same leaf hash (`EpochDistributor.leaf`, a double keccak of
 * the ABI encoding), sorted leaves, sorted-pair hashing, tree layout and `dump()`. A dump loads with
 * `StandardMerkleTree.load`; tree.test.ts pins roots and proofs computed by the library itself.
 */
export const LEAF_ENCODING = ['uint256', 'address', 'uint256'] as const
const LEAF_PARAMS = LEAF_ENCODING.map((type) => ({ type }))

/** A leaf value as the dump stores it: decimal strings for the integers, a lowercase address. */
export type LeafValue = readonly [string, `0x${string}`, string]

export interface TreeDump {
  format: 'standard-v1'
  leafEncoding: typeof LEAF_ENCODING
  tree: Hex[]
  values: { value: LeafValue; treeIndex: number }[]
}

export function leafHash(value: LeafValue): Hex {
  return keccak256(keccak256(encodeAbiParameters(LEAF_PARAMS, [BigInt(value[0]), value[1], BigInt(value[2])])))
}

// Equal-length lowercase hex compares like the bytes it encodes.
const hashPair = (a: Hex, b: Hex): Hex => keccak256(a < b ? concat([a, b]) : concat([b, a]))

export function buildTree(values: readonly LeafValue[]): TreeDump {
  if (values.length === 0) throw new Error('a tree needs at least one leaf')
  const hashed = values.map((value, valueIndex) => ({ valueIndex, hash: leafHash(value) }))
  hashed.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))
  const tree = Array.from<unknown, Hex>({ length: 2 * hashed.length - 1 }, () => '0x')
  hashed.forEach((h, i) => {
    tree[tree.length - 1 - i] = h.hash
  })
  for (let i = tree.length - 1 - hashed.length; i >= 0; i--) tree[i] = hashPair(tree[2 * i + 1]!, tree[2 * i + 2]!)
  const indexed = values.map((value) => ({ value, treeIndex: 0 }))
  hashed.forEach((h, leafIndex) => {
    indexed[h.valueIndex]!.treeIndex = tree.length - 1 - leafIndex
  })
  return { format: 'standard-v1', leafEncoding: LEAF_ENCODING, tree, values: indexed }
}

export function proofOf(dump: TreeDump, valueIndex: number): Hex[] {
  let index = dump.values[valueIndex]!.treeIndex
  const proof: Hex[] = []
  while (index > 0) {
    proof.push(dump.tree[index % 2 === 1 ? index + 1 : index - 1]!)
    index = Math.floor((index - 1) / 2)
  }
  return proof
}

/** What `MerkleProof.verify` computes, for tests. */
export function verifyProof(root: Hex, leaf: Hex, proof: readonly Hex[]): boolean {
  return proof.reduce((node, sibling) => hashPair(node, sibling), leaf) === root
}
