import { cn as stock } from 'cn'
import { describe, expect, it } from 'vitest'
import { cn } from './cn.ts'

describe('cn', () => {
  it('keeps a custom text size next to a text colour', () => {
    expect(cn('text-ui text-muted-foreground')).toBe('text-ui text-muted-foreground')
    expect(cn('text-micro', 'text-destructive-text')).toBe('text-micro text-destructive-text')
  })
  it('lets a later size win over an earlier one, custom or not', () => {
    expect(cn('text-sm', 'text-ui')).toBe('text-ui')
    expect(cn('text-ui', 'text-xs')).toBe('text-xs')
  })
  it('still merges conflicting utilities and drops falsy values', () => {
    expect(cn('px-2 py-1', false, undefined, 'px-4')).toBe('py-1 px-4')
  })
  it('needs the extension: the stock cn treats text-ui as a colour', () => {
    expect(stock('text-ui text-muted-foreground')).toBe('text-muted-foreground')
  })
})
