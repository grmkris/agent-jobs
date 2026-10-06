import { expect, it } from 'vitest'
import { DirectoryError } from '@sidequest/board'
import { directoryAudience, directoryObjectName } from '../src/directory-object.ts'

it('canonicalizes origin host case and default ports before deriving object identity', () => {
  const registry = '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCDEF'
  const name = directoryObjectName(143, registry, 'https://SIDEQUEST.exchange:443', '7')
  expect(directoryAudience('https://SIDEQUEST.exchange:443')).toBe('https://sidequest.exchange')
  expect(name).toBe(directoryObjectName(143, registry.toLowerCase(), 'https://sidequest.exchange', '7'))
  expect(directoryAudience('http://SIDEQUEST.exchange:80')).toBe('http://sidequest.exchange')
  expect(directoryAudience('https://sidequest.exchange:8443')).toBe('https://sidequest.exchange:8443')
  expect(directoryObjectName(143, registry, 'http://sidequest.exchange', '7')).not.toBe(name)
  expect(directoryObjectName(143, registry, 'https://sidequest.exchange:8443', '7')).not.toBe(name)
})

it('refuses malformed and non-HTTP(S) audiences instead of creating opaque scopes', () => {
  for (const audience of ['', 'sidequest.exchange', 'ftp://sidequest.exchange', 'file:///tmp/directory', 'data:text/plain,test', 'mailto:worker@sidequest.exchange', 'javascript:void(0)', 'blob:https://sidequest.exchange/id']) {
    expect(() => directoryAudience(audience)).toThrow(DirectoryError)
    expect(() => directoryObjectName(143, '0xregistry', audience, '7')).toThrow('directory audience must be an HTTP(S) origin')
  }
})
