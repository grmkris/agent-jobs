import { describe, expect, it } from 'vitest'
import { previewUrl } from './delivery-preview.ts'

describe('previewUrl', () => {
  it('reads the public board unprefixed and a tenant board under its own prefix', () => {
    const hash = `0x${'AB'.repeat(32)}`
    expect(previewUrl('', '5fbcae7f56aa8e79', hash)).toBe(
      `/data/deliverables/5fbcae7f56aa8e79/0x${'ab'.repeat(32)}/preview`,
    )
    expect(previewUrl('/b/my-team', 'task 1', hash)).toBe(
      `/b/my-team/data/deliverables/task%201/0x${'ab'.repeat(32)}/preview`,
    )
  })
})
