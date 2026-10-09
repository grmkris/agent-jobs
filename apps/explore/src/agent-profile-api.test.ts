import { describe, expect, it } from 'vitest'
import { hostedRegistrationUrl, uploadAvatar } from './agent-profile-api.ts'

describe('agent profile api', () => {
  it("names the hosted registration file by the agent's key", () => {
    expect(hostedRegistrationUrl('https://dev.sidequest.exchange', '606affe7-5c69-499a-a82f-173e49789203')).toBe(
      'https://dev.sidequest.exchange/profiles/606affe7-5c69-499a-a82f-173e49789203.json',
    )
  })

  it('refuses a picture of another type, or over 1 MB, before sending anything', async () => {
    const svg = new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' })
    await expect(uploadAvatar('key', svg)).rejects.toThrow('PNG, JPEG or WebP')
    const large = new File([new Uint8Array(1024 * 1024 + 1)], 'a.png', { type: 'image/png' })
    await expect(uploadAvatar('key', large)).rejects.toThrow('at most 1 MB')
  })
})
