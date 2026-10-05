import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { V1_CORE_FLOWS } from './v1-flows.ts'
import { V1_ADMIN_FLOWS } from './v1-admin-flows.ts'

it('registers every board-free matrix case exactly once in the 24-case fork rehearsal', () => {
  const script = readFileSync(new URL('../../../contracts/script/rehearse-flows-testnet.sh', import.meta.url), 'utf8')
  const list = /^DEFAULT_CASES="([^"]+)"$/m.exec(script)![1]!.split(',')
  const expected = [...V1_CORE_FLOWS.filter(name => name !== 'legacy-dispute'), ...V1_ADMIN_FLOWS, 'owed-blocklist', 'owed-gas']
  expect(list).toHaveLength(24)
  expect(new Set(list).size).toBe(24)
  expect(list.toSorted()).toEqual(expected.toSorted())
  for (const name of ['delegate', 'slash-pro-rata', 'undelegate-pending-slash'])
    expect(list.indexOf(name)).toBeLessThan(list.indexOf('fees'))
  expect(list.slice(0, 3)).toEqual(['admin-ownership', 'admin-vault-refusal', 'admin-fees'])
})
