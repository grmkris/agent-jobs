/** Inclusive provider log windows. Failed windows are retried at the same starting block. */
export function logWindowEnd(from: bigint, through: bigint, span: bigint): bigint {
  return from + span - 1n < through ? from + span - 1n : through
}

export function smallerLogSpan(error: unknown, span: bigint): bigint | undefined {
  const message = error instanceof Error ? error.message : String(error)
  if (span === 1n || !/range|limit|too many|result|block span|query size/i.test(message)) return undefined
  return span / 2n || 1n
}
