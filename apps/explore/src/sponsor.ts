import * as sdk from '@agent-jobs/sdk'
import { useQuery } from '@tanstack/react-query'
import { type Abi, type Address, type Hex, getAddress, hexToBigInt, isHex, size, slice, toFunctionSelector } from 'viem'
import { type TxRequest, tool } from './api.ts'
import { hireling } from './hireling.ts'
import { chain, deployment } from './wallet.ts'

/** A delegation's root authority (it derives from no other delegation). */
const ROOT_AUTHORITY = `0x${'f'.repeat(64)}`

/** What the relay may do, read from the delegation's caveats (never from a separate claim by the board). */
export interface SponsorPolicy {
  targets: Array<{ address: Address; name: string }>
  methods: Array<{ selector: Hex; name: string }>
  calls: bigint
  /** Unix seconds; the delegation stops working at it. */
  validUntil: number
}

export interface SponsorStatus {
  status: 'none' | 'live' | 'expired' | 'used' | 'revoked'
  /** The signed delegation's `eth_signTypedData_v4` JSON, or null when there is none. */
  typedData: string | null
  callsUsed: number
}

export interface SponsorPrep {
  /** `eth_signTypedData_v4` JSON of the ERC-7710 delegation from this wallet's DeleGator to the relay. */
  sign: { typedData: string }
  /** Set when the wallet still has to point its EIP-7702 code at the DeleGator; the relay sends that for it. */
  upgrade: { delegator: string } | null
}

/** What a sponsorship delegation is held to: this chain's manager, the relay, the framework's enforcers, Hireling's contracts. */
export interface SponsorRules {
  chainId: number
  manager: string
  relay: string
  enforcers: sdk.DelegationEnforcers
  targets: Record<string, { name: string; abi: Abi }>
}

export function sponsorRules(): SponsorRules | null {
  if (hireling === null) return null
  const targets: SponsorRules['targets'] = {
    [hireling.holding.toLowerCase()]: { name: 'Holding', abi: sdk.hirelingHoldingAbi as Abi },
    [hireling.evaluator.toLowerCase()]: { name: 'Evaluator', abi: sdk.hirelingEvaluatorAbi as Abi },
    [hireling.vault.toLowerCase()]: { name: 'Stake vault', abi: sdk.stakeVaultAbi as Abi },
    [deployment.core.toLowerCase()]: { name: 'Core', abi: sdk.coreAbi as Abi },
  }
  return { chainId: chain.id, manager: deployment.delegation.manager, relay: deployment.relay, enforcers: deployment.delegation.enforcers, targets }
}

type Json = Record<string, unknown>
const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase()
const refused = (problem: string) => ({ ok: false as const, problem })

/**
 * Reads a sponsorship delegation, and refuses it unless it is a root delegation from this wallet to Hireling's relay,
 * under this chain's DelegationManager, built only from the framework's enforcers, and limited in all four ways B6
 * names: only Hireling's contracts, only listed functions, a number of calls, an end time. Without the targets limit
 * the relay could act as the wallet anywhere (a token transfer, say), so that is refused whatever the board says.
 */
export function readDelegation(typedData: string, wallet: string, rules: SponsorRules): { ok: true; policy: SponsorPolicy } | { ok: false; problem: string } {
  let parsed: { primaryType?: unknown; domain?: Json; message?: Json }
  try {
    parsed = JSON.parse(typedData) as typeof parsed
  } catch {
    return refused('The permission could not be read.')
  }
  const { domain = {}, message = {} } = parsed
  if (parsed.primaryType !== 'Delegation') return refused('This is not a delegation.')
  if (Number(domain.chainId) !== rules.chainId || !same(domain.verifyingContract, rules.manager)) return refused('The permission is for another network or contract.')
  if (!same(message.delegator, wallet)) return refused('The permission is not from your wallet.')
  if (!same(message.delegate, rules.relay)) return refused('The permission is not to Hireling’s relay.')
  if (!same(message.authority, ROOT_AUTHORITY)) return refused('The permission derives from another one.')
  const caveats = Array.isArray(message.caveats) ? (message.caveats as Json[]) : []
  if (caveats.length === 0) return refused('The permission has no limits.')
  const known = Object.values(rules.enforcers) as string[]
  if (!caveats.every((c) => known.some((e) => same(c?.enforcer, e)) && typeof c?.terms === 'string' && isHex(c.terms))) return refused('The permission uses a limit Hireling does not know.')
  const terms = (enforcer: string): Hex | null => {
    const found = caveats.filter((c) => same(c.enforcer, enforcer)).map((c) => c.terms as Hex)
    return found.length === 1 ? (found[0] ?? null) : null
  }
  const t = terms(rules.enforcers.allowedTargets)
  const m = terms(rules.enforcers.allowedMethods)
  const n = terms(rules.enforcers.limitedCalls)
  const w = terms(rules.enforcers.timestamp)
  if (t === null || m === null || n === null || w === null) return refused('The permission is missing a limit on contracts, functions, calls or time.')
  if (size(t) === 0 || size(t) % 20 !== 0 || size(m) === 0 || size(m) % 4 !== 0 || size(n) !== 32 || size(w) !== 32) return refused('A limit in the permission is malformed.')

  const targets = Array.from({ length: size(t) / 20 }, (_, i) => getAddress(slice(t, i * 20, (i + 1) * 20)))
  const unknown = targets.find((a) => rules.targets[a.toLowerCase()] === undefined)
  if (unknown !== undefined) return refused(`The permission lets the relay call ${unknown}, which is not a Hireling contract.`)
  const names = new Map<string, string>()
  for (const a of targets) {
    for (const item of rules.targets[a.toLowerCase()]?.abi ?? []) if (item.type === 'function') names.set(toFunctionSelector(item), item.name)
  }
  const methods = Array.from({ length: size(m) / 4 }, (_, i) => {
    const selector = slice(m, i * 4, (i + 1) * 4)
    return { selector, name: names.get(selector) ?? selector }
  })
  const calls = hexToBigInt(n)
  // The board's timestamp terms: 16 bytes "valid after", then 16 bytes "valid before" (0 = no bound).
  const validUntil = Number(hexToBigInt(slice(w, 16, 32)))
  if (calls === 0n || validUntil === 0) return refused('The permission has no call count or no end time.')
  return { ok: true, policy: { targets: targets.map((address) => ({ address, name: rules.targets[address.toLowerCase()]?.name ?? address })), methods, calls, validUntil } }
}

export function useSponsorStatus(wallet: string | undefined, signedIn: boolean) {
  return useQuery({
    queryKey: ['sponsor_status', wallet?.toLowerCase()],
    queryFn: () => tool<SponsorStatus>('sponsor_status', { wallet }),
    enabled: wallet !== undefined && signedIn && hireling !== null,
    staleTime: 30_000,
    retry: false,
  })
}

export const sponsorApi = {
  prepare: (wallet: string) => tool<SponsorPrep>('sponsor_prepare', { wallet }),
  confirm: (wallet: string, signature: string) => tool<SponsorStatus>('sponsor_confirm', { wallet, signature }),
  /** The board stops using the delegation at once; any transactions are the on-chain `disableDelegation` from the wallet. */
  revoke: (wallet: string) => tool<{ transactions: TxRequest[] }>('sponsor_revoke', { wallet }),
}
