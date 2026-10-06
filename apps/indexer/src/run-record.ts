import { errorDiagnostics } from '@sidequest/board'
import type { AsyncSql, RunResult } from '@sidequest/indexer'
import * as Cause from 'effect/Cause'

export type IndexerRunOutcome =
  | { readonly ok: true; readonly result: RunResult | { readonly skipped: string } }
  | { readonly ok: false; readonly cause: Cause.Cause<unknown> }

type RunFailureDetail = {
  readonly failures: number
  readonly defects: number
  readonly interruptions: number
  readonly errors: readonly ReturnType<typeof errorDiagnostics>[]
}

/** Count every failure but bound the diagnostic sample; never serialize message, stack or annotations. */
function failureDetail(cause: Cause.Cause<unknown>): RunFailureDetail {
  let failures = 0
  let defects = 0
  let interruptions = 0
  const errors: ReturnType<typeof errorDiagnostics>[] = []
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason)) {
      failures++
      if (errors.length < 8) errors.push(errorDiagnostics(reason.error))
    } else if (Cause.isDieReason(reason)) {
      defects++
      if (errors.length < 8) errors.push(errorDiagnostics(reason.defect))
    } else {
      interruptions++
    }
  }
  return { failures, defects, interruptions, errors }
}

/** Persist the last cron outcome for the public status read. */
export async function recordIndexerRun(sql: AsyncSql, outcome: IndexerRunOutcome, at: number): Promise<void> {
  const detail = JSON.stringify(outcome.ok ? outcome.result : failureDetail(outcome.cause))
  await sql.batch([
    { query: 'CREATE TABLE IF NOT EXISTS indexer_runs (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, ok INTEGER NOT NULL, detail TEXT NOT NULL)', params: [] },
    { query: 'INSERT OR REPLACE INTO indexer_runs (id, at, ok, detail) VALUES (1, ?, ?, ?)', params: [at, outcome.ok ? 1 : 0, detail] },
  ])
}
