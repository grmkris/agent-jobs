import { describe, expect, it } from 'vitest'
import { backableAgents } from './backing-agents.ts'

const OWNER = '0x00000000000000000000000000000000000000aa'
const MINE = '0x00000000000000000000000000000000000000bb'
const LISTED = '0x00000000000000000000000000000000000000cc'

describe('backable agents', () => {
  it('lists your agents first, then the directory, each wallet once and never your own wallet', () => {
    const got = backableAgents(
      OWNER,
      [
        { address: MINE, agent_id: '7', name: "kris' agent" },
        { address: null, agent_id: null, name: 'not set up' },
      ],
      [
        { wallet: MINE.toUpperCase().replace('0X', '0x'), agentId: '7', profile: { name: 'Listed copy' } },
        { wallet: LISTED, agentId: '9', profile: { name: '' } },
        { wallet: OWNER, agentId: '1', profile: { name: 'Me' } },
      ],
    )
    expect(got.map((a) => [a.name, a.agentId, a.yours])).toEqual([
      ["kris' agent", '7', true],
      ['Agent ID 9', '9', false],
    ])
  })
})
