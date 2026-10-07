export type SetupCompletion = { connected: boolean | null; budget: boolean | null; backed: boolean | null }

/** Missing and failed facts never count as completed setup. */
export function setupCompletion({
  status,
  backing,
  now,
}: {
  status: { connected: boolean; allowances: ReadonlyArray<{ limit: string; expiresAt: number }> } | undefined
  backing: { activeShares: bigint } | null | undefined
  now: number
}): SetupCompletion {
  return {
    connected: status?.connected ?? null,
    budget:
      status === undefined
        ? null
        : status.allowances.some((allowance) => BigInt(allowance.limit) > 0n && allowance.expiresAt > now),
    backed: backing === undefined ? null : backing !== null && backing.activeShares > 0n,
  }
}
