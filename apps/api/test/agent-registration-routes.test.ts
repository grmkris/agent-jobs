import { expect, it } from 'vitest'
import { agentRoute } from '../src/routes/agents.ts'

it('exposes batch and receipt owner actions without changing sponsored registration routes', () => {
  for (const action of ['registration-batch', 'registration-record', 'registration-prepare', 'registration-confirm']) {
    const path = `/api/agents/quill/${action}`
    expect(agentRoute('POST', path, { operationKey: 'batch' })).toEqual({
      action,
      id: 'quill',
      body: { operationKey: 'batch' },
    })
    expect(agentRoute('GET', path, {})).toBeUndefined()
  }
})
