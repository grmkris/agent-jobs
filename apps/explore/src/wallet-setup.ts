/**
 * A new account's first steps, in order: upgrade the wallet (EIP-7702, so the app can batch its calls), fund it, and
 * turn on gas sponsorship where the board offers it. Each is done from chain or board state, or skipped by the person;
 * none is required to browse, and creating an agent needs only the first.
 */
export type SetupStep = 'upgrade' | 'fund' | 'sponsor'

export interface SetupFacts {
  /** null while unknown; undefined when this wallet cannot be upgraded here (it is not the embedded wallet). */
  upgraded: boolean | null | undefined
  /** Whether the wallet holds anything (gas, test or payment tokens), or null while unknown. */
  funded: boolean | null
  /** null while unknown; undefined when the board offers no sponsorship (mainnet without a relay). */
  sponsored: boolean | null | undefined
}

export type StepState = 'done' | 'todo' | 'skipped' | 'unknown'

export function setupSteps(
  facts: SetupFacts,
  skipped: ReadonlySet<SetupStep>,
): Array<{ step: SetupStep; state: StepState }> {
  const state = (step: SetupStep, done: boolean | null): StepState =>
    done === true ? 'done' : skipped.has(step) ? 'skipped' : done === null ? 'unknown' : 'todo'
  const steps: Array<{ step: SetupStep; state: StepState }> = []
  if (facts.upgraded !== undefined) steps.push({ step: 'upgrade', state: state('upgrade', facts.upgraded) })
  steps.push({ step: 'fund', state: state('fund', facts.funded) })
  if (facts.sponsored !== undefined) steps.push({ step: 'sponsor', state: state('sponsor', facts.sponsored) })
  return steps
}

/** The card shows while any step is still to do; done and skipped steps alone mean the account is set up. */
export const setupOpen = (steps: ReadonlyArray<{ state: StepState }>) => steps.some((s) => s.state === 'todo')

const key = (address: string) => `sq:setup-skipped:${address.toLowerCase()}`

export function readSkipped(address: string): Set<SetupStep> {
  try {
    const raw = window.localStorage.getItem(key(address))
    const parsed: unknown = raw === null ? [] : JSON.parse(raw)
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((s): s is SetupStep => s === 'upgrade' || s === 'fund' || s === 'sponsor')
        : [],
    )
  } catch {
    return new Set()
  }
}

export function writeSkipped(address: string, skipped: ReadonlySet<SetupStep>) {
  try {
    window.localStorage.setItem(key(address), JSON.stringify([...skipped]))
  } catch {
    // Private windows refuse storage; the card simply asks again next time.
  }
}
