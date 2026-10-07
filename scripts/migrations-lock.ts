// Migration tooling, run by Bun or Node, never in a Worker.
// The lock holds the sha256 of every migration file. Applied names are immutable: record adds new files only.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Schema } from 'effect'

export const MIGRATIONS_DIR = 'apps/api/migrations'
export const LOCK_FILE = 'apps/api/migrations.lock.json'
const Lock = Schema.Struct({ files: Schema.Record(Schema.String, Schema.String) })
export type MigrationLock = typeof Lock.Type

/** Every file, recursively, as a sorted relative path. Non-SQL metadata is immutable too. */
export const listMigrationFiles = (root: string): string[] => {
  const dir = path.join(root, MIGRATIONS_DIR)
  const files: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (entry.isFile()) files.push(path.relative(dir, file).split(path.sep).join('/'))
      else throw new Error(`${file}: migrations must be regular files or directories`)
    }
  }
  if (existsSync(dir)) walk(dir)
  return files.toSorted()
}

export const readLock = (root: string): MigrationLock =>
  Schema.decodeUnknownSync(Lock)(JSON.parse(readFileSync(path.join(root, LOCK_FILE), 'utf8')))

const hashesOf = (root: string): Record<string, string> =>
  Object.fromEntries(
    listMigrationFiles(root).map((file) => [
      file,
      createHash('sha256')
        .update(readFileSync(path.join(root, MIGRATIONS_DIR, file)))
        .digest('hex'),
    ]),
  )

const immutabilityProblems = (lock: MigrationLock, actual: Readonly<Record<string, string>>): string[] => {
  const problems: string[] = []
  for (const [file, hash] of Object.entries(lock.files)) {
    if (actual[file] === undefined) problems.push(`${MIGRATIONS_DIR}/${file}: locked migration deleted or renamed`)
    else if (actual[file] !== hash)
      problems.push(`${MIGRATIONS_DIR}/${file}: locked migration edited; add a new migration`)
  }
  return problems
}

export const checkMigrations = (root: string): string[] => {
  if (!existsSync(path.join(root, LOCK_FILE))) return [`${LOCK_FILE} is missing; run bun run migrations:record`]
  const lock = readLock(root)
  const actual = hashesOf(root)
  return [
    ...immutabilityProblems(lock, actual),
    ...Object.keys(actual)
      .filter((file) => lock.files[file] === undefined)
      .map((file) => `${MIGRATIONS_DIR}/${file}: unrecorded migration; review then run bun run migrations:record`),
  ]
}

/** Refuses to write while any existing entry differs; sorted output preserves a reviewable append-only history. */
export const recordMigrations = (root: string): { problems: string[]; recorded: string[] } => {
  const lock = existsSync(path.join(root, LOCK_FILE)) ? readLock(root) : { files: {} }
  const actual = hashesOf(root)
  const problems = immutabilityProblems(lock, actual)
  if (problems.length > 0) return { problems, recorded: [] }
  const recorded = Object.keys(actual).filter((file) => lock.files[file] === undefined)
  const files = Object.fromEntries(
    Object.entries({ ...lock.files, ...actual }).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  )
  writeFileSync(path.join(root, LOCK_FILE), `${JSON.stringify({ files }, null, 2)}\n`)
  return { problems: [], recorded }
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dirname, '..')
  const command = process.argv[2]
  if (command !== 'check' && command !== 'record') {
    console.error('usage: bun scripts/migrations-lock.ts check|record')
    process.exitCode = 2
  } else {
    const result = command === 'check' ? { problems: checkMigrations(root), recorded: [] } : recordMigrations(root)
    for (const problem of result.problems) console.error(problem)
    if (result.problems.length > 0) process.exitCode = 1
    else console.info(`migrations:${command} passed (${result.recorded.length} new files; ${LOCK_FILE})`)
  }
}
