import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Cloudflare's SQLite (Durable Objects and D1) refuses a LIKE or GLOB pattern over 50 bytes; node:sqlite in the tests
// does not, so a long pattern passes here and fails live. A bound pattern's length is unknown here: match prefixes
// with substr(column,1,?)=? instead, and keep literal patterns short.
const sources = readdirSync(new URL('.', import.meta.url)).filter(
  (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
)

describe('SQL within Cloudflare limits', () => {
  it.each(sources)('%s binds no LIKE pattern and keeps literal ones within 50 bytes', (name) => {
    const source = readFileSync(new URL(name, import.meta.url), 'utf8')
    expect(source).not.toMatch(/\b(LIKE|GLOB)\s+\?/i)
    for (const [, pattern] of source.matchAll(/\b(?:LIKE|GLOB)\s+'([^']*)'/gi))
      expect(Buffer.byteLength(pattern!)).toBeLessThanOrEqual(50)
  })
})
