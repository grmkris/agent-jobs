/**
 * The epoch price list a Safe owner signs (U5, B8): the EIP-712 typed data pinned in `scripts/mining/README.md` and
 * built by `scripts/mining/prices.ts`, the file `bun run mining:epoch --prices` reads, and the checks on the admin form.
 * Pure, so prices.test.ts checks it against the mining tool's own `typedMessage` and signer recovery.
 */
import { type Address, type Hex, getAddress, isAddress, parseUnits } from 'viem'

const PRICE_LIST_TYPES = {
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

/** Below this SIDE price ($0.0001, 18 decimals) the mining tool counts the floor. */
export const SIDE_PRICE_FLOOR = 10n ** 14n

interface TokenPrice {
  token: Address
  decimals: number
  /** USD per whole token, 18 decimals. */
  usdPrice: bigint
}

export interface PriceList {
  epoch: bigint
  tokens: TokenPrice[]
  /** USD per whole SIDE, 18 decimals. */
  factoryUsdPrice: bigint
}

/** The form: USD prices as typed ("1", "0.9998"); a token row with no price is left off the list. */
export interface PriceDraft {
  epoch: string
  factoryUsd: string
  tokens: Array<{ token: string; decimals: number | null; usd: string }>
}

const priceListDomain = (chainId: number, distributor: string) =>
  ({ name: 'Sidequest Mining Prices', version: '1', chainId, verifyingContract: getAddress(distributor) }) as const

const usd = (text: string): bigint | null =>
  /^\d+(\.\d{1,18})?$/.test(text.trim()) ? parseUnits(text.trim(), 18) : null

/** The list a draft describes, or why it cannot be signed: what `parsePriceList` in the mining tool would refuse. */
export function priceListOf(d: PriceDraft): PriceList | string {
  if (!/^\d+$/.test(d.epoch.trim())) return 'Enter the epoch number.'
  const tokens: TokenPrice[] = []
  for (const row of d.tokens) {
    if (row.usd.trim() === '') continue
    if (!isAddress(row.token, { strict: false })) return `${row.token} is not a token address.`
    if (row.decimals === null) return `The decimals of ${row.token} could not be read from the chain.`
    if (!Number.isInteger(row.decimals) || row.decimals < 0 || row.decimals > 36)
      return `${row.token} has decimals out of range.`
    const price = usd(row.usd)
    if (price === null || price === 0n) return `Enter a USD price above 0 for ${row.token}, at most 18 decimals.`
    if (tokens.some((t) => t.token.toLowerCase() === row.token.toLowerCase())) return `${row.token} is listed twice.`
    tokens.push({ token: getAddress(row.token), decimals: row.decimals, usdPrice: price })
  }
  if (tokens.length === 0) return 'Price at least one token: fees in unpriced tokens do not count.'
  const factoryUsdPrice = usd(d.factoryUsd)
  if (factoryUsdPrice === null || factoryUsdPrice === 0n) return 'Enter the SIDE price in USD, above 0.'
  return { epoch: BigInt(d.epoch.trim()), tokens, factoryUsdPrice }
}

/** What the wallet signs: the same domain, types and message as the mining tool's `typedMessage` (checksummed tokens). */
export function priceTypedData(chainId: number, distributor: string, list: PriceList) {
  return {
    domain: priceListDomain(chainId, distributor),
    types: PRICE_LIST_TYPES,
    primaryType: 'PriceList' as const,
    message: {
      epoch: list.epoch,
      tokens: list.tokens.map((t) => ({ token: getAddress(t.token), decimals: t.decimals, usdPrice: t.usdPrice })),
      factoryUsdPrice: list.factoryUsdPrice,
    },
  }
}

/** The signed file, as `sign-prices.ts` writes it and `mining:epoch --prices` reads it: integers as decimal strings. */
export function priceListFile(chainId: number, distributor: string, list: PriceList, signer: string, signature: Hex) {
  return {
    domain: priceListDomain(chainId, distributor),
    message: {
      epoch: list.epoch.toString(),
      tokens: list.tokens.map((t) => ({
        token: getAddress(t.token),
        decimals: t.decimals,
        usdPrice: t.usdPrice.toString(),
      })),
      factoryUsdPrice: list.factoryUsdPrice.toString(),
    },
    signer: signer.toLowerCase(),
    signature,
  }
}
