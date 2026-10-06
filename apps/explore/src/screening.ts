export const verdictText = (verdict: string | undefined) =>
  verdict === undefined ? 'Not screened' : (VERDICT[verdict]?.text ?? 'Not screened')

export const VERDICT: Record<string, { text: string; tone: 'ok' | 'warn' | 'bad' | 'none' }> = {
  clean: { text: 'Looks fine', tone: 'ok' },
  caution: { text: 'Flagged for a closer look', tone: 'warn' },
  reject: { text: 'Flagged as risky', tone: 'bad' },
}
