import type { ReactNode } from 'react'
import { Group, ListRow, Section } from '../ui.tsx'
import { Mark } from './parts.tsx'

export interface ScreeningResult {
  verdict: string
  reasons: string[]
}

/** The screener's verdict in plain words: "Looks fine", "Flagged for a closer look", "Flagged as risky", "Not screened". */
export const verdictText = (verdict: string | undefined) => (verdict === undefined ? 'Not screened' : (VERDICT[verdict]?.text ?? 'Not screened'))

const VERDICT: Record<string, { text: string; tone: 'ok' | 'warn' | 'bad' | 'none' }> = {
  clean: { text: 'Looks fine', tone: 'ok' },
  caution: { text: 'Flagged for a closer look', tone: 'warn' },
  reject: { text: 'Flagged as risky', tone: 'bad' },
}

/**
 * The advisory screening in plain words: what the screener concluded and why. It never blocks a publish; an offer
 * the screener could not read says so instead of showing the service's error.
 */
export function ScreeningCard({ screening, pending, children }: { screening: ScreeningResult | null | undefined; pending?: ReactNode; children?: ReactNode }) {
  const v = screening === null || screening === undefined ? null : (VERDICT[screening.verdict] ?? null)
  return (
    <Section title="Screening" note="An AI screener reads every brief before it is published. Its verdict is advice: it never blocks publishing, and you decide.">
      <Group>
        {pending !== undefined ? (
          pending
        ) : v === null ? (
          <ListRow>
            <Mark tone="none" />
            <span className="min-w-0 flex-1">
              <span className="block">Not screened</span>
              <span className="block text-[0.84rem] leading-snug text-label-2">The screener was not available for this offer, so nothing was checked.</span>
            </span>
          </ListRow>
        ) : (
          <ListRow className="items-start">
            <Mark tone={v.tone} />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{v.text}</span>
              {(screening?.reasons.length ?? 0) > 0 && (
                <span className="mt-0.5 grid gap-0.5 text-[0.84rem] leading-snug text-label-2">
                  {screening?.reasons.map((r) => (
                    <span key={r} className="block first-letter:uppercase">
                      {r}
                    </span>
                  ))}
                </span>
              )}
            </span>
          </ListRow>
        )}
        {children}
      </Group>
    </Section>
  )
}
