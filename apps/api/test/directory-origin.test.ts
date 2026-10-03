import { expect, it } from 'vitest'
import { DirectoryError } from '@agent-jobs/board'
import { directoryAudience, directoryObjectName } from '../src/directory-object.ts'

it('canonicalizes origin host case and default ports before deriving object identity', () => {
  const registry = '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCDEF'
  const name = directoryObjectName(143, registry, 'https://HIRELING.xyz:443', '7')
  expect(directoryAudience('https://HIRELING.xyz:443')).toBe('https://hireling.xyz')
  expect(name).toBe(directoryObjectName(143, registry.toLowerCase(), 'https://hireling.xyz', '7'))
  expect(directoryAudience('http://HIRELING.xyz:80')).toBe('http://hireling.xyz')
  expect(directoryAudience('https://hireling.xyz:8443')).toBe('https://hireling.xyz:8443')
  expect(directoryObjectName(143, registry, 'http://hireling.xyz', '7')).not.toBe(name)
  expect(directoryObjectName(143, registry, 'https://hireling.xyz:8443', '7')).not.toBe(name)
})

it('refuses malformed and non-HTTP(S) audiences instead of creating opaque scopes', () => {
  for (const audience of ['', 'hireling.xyz', 'ftp://hireling.xyz', 'file:///tmp/directory', 'data:text/plain,test', 'mailto:worker@hireling.xyz', 'javascript:void(0)', 'blob:https://hireling.xyz/id']) {
    expect(() => directoryAudience(audience)).toThrow(DirectoryError)
    expect(() => directoryObjectName(143, '0xregistry', audience, '7')).toThrow('directory audience must be an HTTP(S) origin')
  }
})
