import { expect, it } from 'vitest'
import { BOARD_SLUG, SPONSOR_OBJECT_NAME } from '@sidequest/board'
import { COMMONS_OBJECT_NAME, commonsToolNames } from '@sidequest/commons'
import { objectFor } from '../src/commons/route.ts'

it('routes every Commons tool to the reserved object and keeps ordinary boards separate', () => {
  for (const name of commonsToolNames) expect(objectFor(name, 'public')).toBe(COMMONS_OBJECT_NAME)
  expect(objectFor('sponsor_prepare', 'tenant')).toBe(SPONSOR_OBJECT_NAME)
  expect(objectFor('get_task', 'tenant')).toBe('tenant')
  expect(BOARD_SLUG.test(COMMONS_OBJECT_NAME)).toBe(false)
})
