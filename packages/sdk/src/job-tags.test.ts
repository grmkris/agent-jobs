import { expect, it } from 'vitest'
import { jobTags } from './job-tags.ts'

it('freezes up to three known tags in a stable order', () => {
  expect(jobTags(['research', 'coding', 'coding'])).toEqual(['coding', 'research'])
  expect(jobTags([])).toEqual([])
})

it('refuses unknown tags, non-arrays and more than three choices', () => {
  for (const input of ['coding', ['unknown'], ['coding', 'design', 'writing', 'research']])
    expect(() => jobTags(input)).toThrow()
})
