import { expect, it } from 'vitest'
import { decodeFunctionData } from 'viem'
import * as sdk from '@sidequest/sdk'
import { hostedAgentURI } from './agent-onboarding.ts'

it('prepares hosted HTTPS registrations independent of profile edits', () => {
  const uri = hostedAgentURI('https://dev.sidequest.exchange/b/example/mcp', 'my-agent')
  expect(uri).toBe('https://dev.sidequest.exchange/profiles/my-agent.json')
  expect(decodeFunctionData({ abi: sdk.identityAbi, data: sdk.registerCalldata(uri) }).args).toEqual([uri])
  expect(hostedAgentURI('http://localhost:5173', 'my-agent')).toBe('http://localhost:5173/profiles/my-agent.json')
})

it('refuses registration without a safe configured origin', () => {
  for (const origin of [undefined, '', 'data:application/json,{}', 'http://public.example', 'https://u:p@example.com'])
    expect(() => hostedAgentURI(origin, 'my-agent')).toThrow()
  expect(() => hostedAgentURI('https://dev.sidequest.exchange', '../one')).toThrow()
})
