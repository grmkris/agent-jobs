/**
 * `bun run lint:gate`: the lint gates (oxlint, knip) against the findings recorded in
 * tools/lint-baseline.json, per file and rule.
 *
 *   bun run lint:gate            fails on any count above its baseline (a new file or rule included), on a stale entry
 *                                (fewer findings than recorded) and on a tool that did not run or left files unchecked
 *   bun run lint:gate --update   lowers every entry to the current count and drops the fixed ones; writes nothing and
 *                                fails if any count went up. Run it after fixing findings; commit the file with the fix
 *   bun run lint:gate --update <path>...
 *                                the same for the entries of these files and directories only: in a shared checkout,
 *                                name the files you changed, so other agents' uncommitted fixes stay out of your commit
 *   bun run lint:gate --init     rewrites the baseline from the current findings. Only the orchestrator runs it, after
 *                                a deliberate rule or config change, and the commit says why
 *
 * Each tool runs once over the whole repository, through `heavy` when it is installed (tools/findings.ts).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  compare,
  countFindings,
  parseBaseline,
  renderIncreases,
  renderStale,
  renderTotals,
  serializeBaseline,
  totals,
  updateBaseline,
} from './baseline.ts'
import type { Baseline, Increase } from './baseline.ts'
import { collect, SOURCES } from './findings.ts'
import type { Collected } from './findings.ts'
import { repoRoot } from './run.ts'

const BASELINE = path.join(import.meta.dirname, 'lint-baseline.json')
const NAME = 'tools/lint-baseline.json'
const usage = 'usage: bun run lint:gate [--update [<path>...] | --init]'

type Mode = 'check' | 'update' | 'init'

interface Options {
  readonly mode: Mode
  /** `--update <path>...`: the files and directories whose entries may change, repository-relative. */
  readonly paths: readonly string[]
}

const parseArgs = (argv: readonly string[]): Options => {
  const [flag, ...rest] = argv
  if (flag === undefined) return { mode: 'check', paths: [] }
  if (flag === '--init' && rest.length === 0) return { mode: 'init', paths: [] }
  if (flag === '--update' && rest.every((arg) => !arg.startsWith('--'))) {
    const paths = rest.map((arg) => path.relative(repoRoot, path.resolve(arg)).split(path.sep).join('/'))
    return { mode: 'update', paths }
  }
  throw new Error(`unknown arguments ${argv.join(' ')}\n${usage}`)
}

const readBaseline = (): Baseline => {
  if (!existsSync(BASELINE)) throw new Error(`${NAME} is missing; the orchestrator creates it with --init (${usage})`)
  return parseBaseline(readFileSync(BASELINE, 'utf8'))
}

const writeBaseline = (baseline: Baseline): void => {
  writeFileSync(BASELINE, serializeBaseline(baseline))
}

const reportFailures = (failures: readonly string[]): false => {
  console.error(
    `lint:gate: ${failures.length} collection failures; the findings are incomplete, so nothing is compared`,
  )
  for (const failure of failures) console.error(`  ${failure.split('\n').join('\n    ')}`)
  return false
}

const reportIncreases = (increases: readonly Increase[]): void => {
  console.error(`lint:gate: ${increases.length} counts above ${NAME} (file, rule, baseline → actual, lines):`)
  for (const line of renderIncreases(increases)) console.error(line)
  console.error('Fix these findings: the baseline only shrinks.')
}

/** The default mode. Each mode returns whether it passed. */
const check = (baseline: Baseline, collected: Collected): boolean => {
  const { increases, stale } = compare(baseline, collected.findings)
  if (increases.length > 0) reportIncreases(increases)
  if (stale.length > 0) {
    console.error(
      `lint:gate: ${stale.length} stale entries in ${NAME}, fixed since it was written (baseline → actual):`,
    )
    for (const line of renderStale(stale)) console.error(line)
    console.error(`Run \`bun run lint:gate --update\` and commit the smaller baseline.`)
  }
  if (increases.length > 0 || stale.length > 0) return false
  console.log(`lint:gate: passed; the baseline holds ${renderTotals(totals(baseline))}.`)
  return true
}

const update = (before: Baseline, paths: readonly string[], collected: Collected): boolean => {
  const result = updateBaseline(before, collected.findings, paths)
  if (!result.written) {
    reportIncreases(result.increases)
    console.error(`lint:gate --update: ${NAME} is unchanged.`)
    return false
  }
  if (serializeBaseline(result.baseline) === serializeBaseline(before)) {
    console.log(`lint:gate --update: ${NAME} already matches; it holds ${renderTotals(totals(before))}.`)
    return true
  }
  writeBaseline(result.baseline)
  console.log(
    `lint:gate --update: ${NAME} went from ${renderTotals(totals(before))} to ${renderTotals(totals(result.baseline))}. ` +
      'Commit it with the fix.',
  )
  return true
}

const init = (collected: Collected): boolean => {
  const baseline = countFindings(collected.findings)
  writeBaseline(baseline)
  console.log(`lint:gate --init: ${NAME} now holds ${renderTotals(totals(baseline))}. Say why in the commit.`)
  return true
}

/** Each mode reads what it needs before the slow collection, then judges the findings. */
const modes: Readonly<Record<Mode, (paths: readonly string[]) => (collected: Collected) => boolean>> = {
  check: () => {
    const baseline = readBaseline()
    return (collected) => check(baseline, collected)
  },
  update: (paths) => {
    const baseline = readBaseline()
    return (collected) => update(baseline, paths, collected)
  },
  init: () => init,
}

const options = parseArgs(Bun.argv.slice(2))
const judge = modes[options.mode](options.paths)
const started = performance.now()
const collected = await collect(SOURCES)
const passed = collected.failures.length === 0 ? judge(collected) : reportFailures(collected.failures)
console.log(`lint:gate: ${Math.round((performance.now() - started) / 1000)} s`)
process.exitCode = passed ? 0 : 1
