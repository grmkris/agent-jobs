import { getAddress, recoverTypedDataAddress, type Address, type Hex } from './viem.ts'

/**
 * The epoch price list a Safe owner signs (EIP-712). Pinned in README.md; UI U5's signing page builds the same typed
 * data. `usdPrice` is USD per whole token and `factoryUsdPrice` USD per whole SIDE, both with 18 decimals.
 * `decimals` is the token's own, so the value of a fee needs nothing outside the signed list (the tool checks it
 * against the token on chain).
 */
export const PRICE_LIST_TYPES = {
  PriceList: [
    { name: 'epoch', type: 'uint256' },
    { name: 'tokens', type: 'TokenPrice[]' },
    { name: 'factoryUsdPrice', type: 'uint256' },
  ],
  TokenPrice: [
    { name: 'token', type: 'address' },
    { name: 'decimals', type: 'uint8' },
    { name: 'usdPrice', type: 'uint256' },
  ],
} as const

export const PRICE_LIST_DOMAIN_NAME = 'Sidequest Mining Prices'
export const PRICE_LIST_DOMAIN_VERSION = '1'

export interface TokenPrice {
  token: Address
  decimals: number
  usdPrice: bigint
}

export interface PriceList {
  epoch: bigint
  tokens: TokenPrice[]
  factoryUsdPrice: bigint
}

/** The file format: decimal strings for the integers. `domain` is informational; verification rebuilds it. */
export interface PriceListFile {
  domain?: unknown
  message: { epoch: string; tokens: { token: string; decimals: number; usdPrice: string }[]; factoryUsdPrice: string }
  signer?: string
  signature?: string
}

/** Current Safe ownership and the exact epoch/domain bind every signed input, including fallback prices. */
export async function verifiedPriceList(
  file: PriceListFile,
  expected: {
    epoch: bigint
    chainId: number
    distributor: Address
    owners: readonly Address[]
  },
) {
  const prices = parsePriceList(file)
  if (prices.epoch !== expected.epoch) throw new Error('signed price list has the wrong epoch')
  if (typeof file.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(file.signature))
    throw new Error('price list is not signed')
  const signature = file.signature.toLowerCase() as Hex
  const signer = await recoverPriceListSigner(prices, signature, expected.chainId, expected.distributor)
  if (file.signer !== undefined && file.signer.toLowerCase() !== signer)
    throw new Error('price list signer field differs from recovered signer')
  if (!expected.owners.some((owner) => owner.toLowerCase() === signer))
    throw new Error('price list signer is not a current Safe owner')
  return { prices, signature, signer }
}

export const priceListDomain = (chainId: number, distributor: Address) =>
  ({
    name: PRICE_LIST_DOMAIN_NAME,
    version: PRICE_LIST_DOMAIN_VERSION,
    chainId,
    verifyingContract: distributor,
  }) as const

const uint = (value: unknown, what: string): bigint => {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value))
    throw new Error(`price list: ${what} must be a decimal string`)
  return BigInt(value)
}

/** Parses and checks the message's shape: tokens unique, every price positive, decimals 0–36. */
export function parsePriceList(file: PriceListFile): PriceList {
  const m = file.message
  if (typeof m !== 'object' || m === null || !Array.isArray(m.tokens)) throw new Error('price list: no message')
  const tokens = m.tokens.map((t, i) => {
    if (typeof t.token !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(t.token))
      throw new Error(`price list: token ${i} is not an address`)
    if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 36)
      throw new Error(`price list: token ${i} decimals`)
    const usdPrice = uint(t.usdPrice, `token ${i} usdPrice`)
    if (usdPrice === 0n) throw new Error(`price list: token ${i} has no price`)
    return { token: t.token.toLowerCase() as Address, decimals: t.decimals, usdPrice }
  })
  if (new Set(tokens.map((t) => t.token)).size !== tokens.length) throw new Error('price list: a token is listed twice')
  const factoryUsdPrice = uint(m.factoryUsdPrice, 'factoryUsdPrice')
  if (factoryUsdPrice === 0n) throw new Error('price list: no SIDE price')
  return { epoch: uint(m.epoch, 'epoch'), tokens, factoryUsdPrice }
}

/** The message as viem and `cast wallet sign` take it (checksummed addresses, as typed data requires). */
export const typedMessage = (list: PriceList) => ({
  epoch: list.epoch,
  tokens: list.tokens.map((t) => ({ token: getAddress(t.token), decimals: t.decimals, usdPrice: t.usdPrice })),
  factoryUsdPrice: list.factoryUsdPrice,
})

/** Full EIP-712 JSON (with EIP712Domain), the shape `cast wallet sign --data --from-file` and wallets accept. */
export function typedDataJson(chainId: number, distributor: Address, list: PriceList) {
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      ...PRICE_LIST_TYPES,
    },
    primaryType: 'PriceList',
    domain: { ...priceListDomain(chainId, getAddress(distributor)) },
    message: {
      epoch: list.epoch.toString(),
      tokens: list.tokens.map((t) => ({
        token: getAddress(t.token),
        decimals: t.decimals,
        usdPrice: t.usdPrice.toString(),
      })),
      factoryUsdPrice: list.factoryUsdPrice.toString(),
    },
  }
}

/** The address that signed the list for this chain and distributor (it must then be a current Safe owner). */
export async function recoverPriceListSigner(
  list: PriceList,
  signature: Hex,
  chainId: number,
  distributor: Address,
): Promise<Address> {
  const signer = await recoverTypedDataAddress({
    domain: priceListDomain(chainId, getAddress(distributor)),
    types: PRICE_LIST_TYPES,
    primaryType: 'PriceList',
    message: typedMessage(list),
    signature,
  })
  return signer.toLowerCase() as Address
}
