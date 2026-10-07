import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
const source = readFileSync(new URL('../apps/api/src/directory.ts', import.meta.url), 'utf8')
const sql = source.match(/`(CREATE TABLE IF NOT EXISTS directory_agents \([\s\S]*?\))`/)?.[1]
if (!sql) throw new Error('Directory schema unavailable')
const directory = new URL('../apps/api/migrations/', import.meta.url)
mkdirSync(directory, { recursive: true })
const output = new URL('0001_directory_agents.sql', directory)
const generated = `${sql.replace(/^    /gm, '')};\n`
if (process.argv.includes('--check')) {
  if (readFileSync(output, 'utf8') !== generated) throw new Error('Run bun run db:generate and review the migration')
} else writeFileSync(output, generated)
