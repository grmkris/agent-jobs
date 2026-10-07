import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { checkMigrations, LOCK_FILE, MIGRATIONS_DIR, recordMigrations } from '../../scripts/migrations-lock.ts'

const roots: string[] = []
const fixture = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'sidequest-migrations-'))
  roots.push(root)
  mkdirSync(path.join(root, MIGRATIONS_DIR), { recursive: true })
  writeFileSync(path.join(root, MIGRATIONS_DIR, '0001.sql'), 'CREATE TABLE jobs (id TEXT);\n')
  expect(recordMigrations(root)).toEqual({ problems: [], recorded: ['0001.sql'] })
  return root
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('migration history', () => {
  test('unrecorded nested files fail check and recording adds their hashes', () => {
    const root = fixture()
    mkdirSync(path.join(root, MIGRATIONS_DIR, 'meta'))
    writeFileSync(path.join(root, MIGRATIONS_DIR, 'meta/journal.json'), '{}\n')
    expect(checkMigrations(root)).toHaveLength(1)
    expect(recordMigrations(root)).toEqual({ problems: [], recorded: ['meta/journal.json'] })
    expect(checkMigrations(root)).toEqual([])
    expect(recordMigrations(root).recorded).toEqual([])
  })

  test.each(['edited', 'deleted', 'renamed'])('%s migration fails and record leaves the lock unchanged', (action) => {
    const root = fixture()
    const lock = readFileSync(path.join(root, LOCK_FILE), 'utf8')
    const original = path.join(root, MIGRATIONS_DIR, '0001.sql')
    if (action === 'edited') writeFileSync(original, 'DROP TABLE jobs;\n')
    else if (action === 'deleted') unlinkSync(original)
    else renameSync(original, path.join(root, MIGRATIONS_DIR, '0002.sql'))
    expect(checkMigrations(root).length).toBeGreaterThan(0)
    expect(recordMigrations(root).problems).toHaveLength(1)
    expect(readFileSync(path.join(root, LOCK_FILE), 'utf8')).toBe(lock)
  })
})
