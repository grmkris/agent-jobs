/** A chain duration in exact whole units, including minute-scale testnet clocks. */
export function duration(seconds: number): string {
  for (const [unit, size] of [
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ] as const) {
    if (seconds % size === 0) {
      const value = seconds / size
      return `${value} ${unit}${value === 1 ? '' : 's'}`
    }
  }
  return `${seconds} seconds`
}
