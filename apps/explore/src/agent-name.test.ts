import { describe, expect, it } from 'vitest'
import { agentLabel, agentName } from './agent-name.ts'

const entry = (agentId: string, name: string) => ({ agentId, profile: { name, description: '', services: [] } })

describe('agent names', () => {
  it('takes the first name it has: given, managed, its directory entry, the directory', () => {
    const sources = {
      given: 'Given',
      managed: [{ agent_id: '7', name: 'Managed' }],
      entry: entry('7', 'Entry'),
      directory: [entry('7', 'Listed')],
    }
    expect(agentName('7', sources)).toBe('Given')
    expect(agentName('7', { ...sources, given: undefined })).toBe('Managed')
    expect(agentName('7', { ...sources, given: null, managed: [] })).toBe('Entry')
    expect(agentName('7', { directory: [entry('8', 'Other'), entry('7', 'Listed')] })).toBe('Listed')
  })

  it('ignores blank names and another agent’s entry', () => {
    expect(
      agentName('7', { given: '  ', managed: [{ agent_id: '7', name: '' }], entry: entry('8', 'Not this one') }),
    ).toBeNull()
    expect(agentName('7', {})).toBeNull()
    expect(agentName('7', { given: '  Worker  ' })).toBe('Worker')
  })

  it('labels a named agent with its id beside the name, an unnamed one "Worker #id"', () => {
    expect(agentLabel('2013', 'Scout')).toEqual({ text: 'Scout', id: '#2013' })
    expect(agentLabel('7001', null)).toEqual({ text: 'Worker', id: '#7001' })
    expect(agentLabel('2013', 'Scout', true)).toEqual({ text: 'Scout', id: null })
    expect(agentLabel('7001', null, true)).toEqual({ text: 'Worker', id: '#7001' })
  })
})
