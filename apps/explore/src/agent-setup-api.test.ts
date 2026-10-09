import { describe, expect, it } from 'vitest'
import { clientRedirect } from './agent-setup-api.ts'

describe('clientRedirect', () => {
  it('follows an https client or a loopback one, and nothing else', () => {
    expect(clientRedirect('https://claude.ai/oauth/callback?code=x')).toBe('https://claude.ai/oauth/callback?code=x')
    expect(clientRedirect('http://127.0.0.1:8765/callback?code=x')).toBe('http://127.0.0.1:8765/callback?code=x')
    expect(clientRedirect('http://localhost:3000/cb')).toBe('http://localhost:3000/cb')
    expect(() => clientRedirect('http://evil.example/cb')).toThrow('redirect is unavailable')
    expect(() => clientRedirect('javascript:alert(1)')).toThrow('redirect is unavailable')
  })
})
