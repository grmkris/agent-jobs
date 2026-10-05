/** UTC reservations are saved before external effects and retained across restarts. */
export type DailyAction = 'quotes' | 'deliveries'
export interface DailyReservations {
  [day: string]: { quotes: string[]; deliveries: string[] }
}

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

export function reserveDaily(
  saved: DailyReservations,
  action: DailyAction,
  operation: string,
  maximum: number,
  now: number,
): DailyReservations | undefined {
  const day = utcDay(now)
  const current = saved[day] ?? { quotes: [], deliveries: [] }
  if (current[action].includes(operation)) return saved
  if (current[action].length >= maximum) return undefined
  return {
    ...saved,
    [day]: { ...current, [action]: [...current[action], operation] },
  }
}

export function dailyRemaining(saved: DailyReservations, action: DailyAction, maximum: number, now: number): number {
  return Math.max(0, maximum - (saved[utcDay(now)]?.[action].length ?? 0))
}

export function occupiesWorker(phase: string): boolean {
  return ['activating', 'active', 'waiting-checks', 'submitted', 'attention'].includes(phase)
}
