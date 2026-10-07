/** Private durable intent journal. Never discard this directory to retry a fixture. */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import * as sdk from '../../../src/index.ts'

export class RunState {
  readonly state: sdk.FlowState
  readonly budget: sdk.FlowState
  readonly directory: string
  readonly #budgetPath: string
  readonly #lock: string

  constructor(
    readonly runId: string,
    binding: string,
    base = new URL('../.local/deployed/', import.meta.url).pathname,
  ) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(runId)) throw new Error('Use a short alphanumeric P8_RUN_ID')
    this.directory = join(base, runId)
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    this.#lock = join(base, 'runner.lock')
    this.#budgetPath = join(base, 'budget.json')
    this.#acquire()
    try {
      const path = join(this.directory, 'journal.json')
      this.state = existsSync(path) ? sdk.parseFlowJson(readFileSync(path, 'utf8')) : { binding, values: {}, sends: {} }
      this.budget = existsSync(this.#budgetPath)
        ? sdk.parseFlowJson(readFileSync(this.#budgetPath, 'utf8'))
        : { binding: 'P8:monad-testnet:2MON', values: {}, sends: {} }
      if (this.budget.binding !== 'P8:monad-testnet:2MON') throw new Error('P8_BUDGET_LEDGER_BINDING_CHANGED')
      if (this.state.binding !== binding)
        throw new Error('Run belongs to another deployment or release; retain it for reconciliation')
      this.save()
      this.#save(this.budget, this.#budgetPath)
    } catch (error) {
      this.close()
      throw error
    }
  }

  #acquire(): void {
    if (existsSync(this.#lock)) {
      const pid = Number(readFileSync(this.#lock, 'utf8'))
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid journal lock; inspect it manually')
      try {
        process.kill(pid, 0)
        throw new Error('Another process owns this acceptance run')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
      unlinkSync(this.#lock)
    }
    const fd = openSync(this.#lock, 'wx', 0o600)
    try {
      writeFileSync(fd, String(process.pid))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }

  save(): void {
    this.#save(this.state, join(this.directory, 'journal.json'))
  }

  #save(state: sdk.FlowState, path: string): void {
    const temporary = `${path}.tmp`
    const fd = openSync(temporary, 'w', 0o600)
    try {
      writeFileSync(fd, `${sdk.flowJson(state)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, path)
    const directory = openSync(join(path, '..'), 'r')
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
  }

  budgetSet<T>(key: string, value: T): void {
    this.budget.values[key] = value
    this.#save(this.budget, this.#budgetPath)
  }

  get<T>(key: string): T | undefined {
    return this.state.values[key] as T | undefined
  }

  set<T>(key: string, value: T): T {
    this.state.values[key] = value
    this.save()
    return value
  }

  freeze<T>(key: string, value: T): T {
    const previous = this.get<T>(key)
    if (previous !== undefined) {
      if (sdk.flowJson(previous) !== sdk.flowJson(value))
        throw new Error(`Frozen ${key} changed; reconcile the original intent`)
      return previous
    }
    return this.set(key, value)
  }

  close(): void {
    if (existsSync(this.#lock) && readFileSync(this.#lock, 'utf8') === String(process.pid)) unlinkSync(this.#lock)
  }
}
