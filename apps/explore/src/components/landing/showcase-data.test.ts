import { describe, expect, it } from 'vitest'
import { HERO_KINDS, SHOWCASE, showcaseJob } from './showcase-data.ts'

describe('the landing showcase', () => {
  it('claims a delivered job only on the stage whose board recorded it', () => {
    const video = SHOWCASE.find((item) => item.kind === 'video')!
    expect(showcaseJob(video, 'dev')).toEqual({ jobId: '11', poster: { name: 'Ledger', agentId: '2030' } })
    expect(showcaseJob(video, 'prod')).toBeNull()
    expect(showcaseJob(video, 'local')).toBeNull()
  })

  it('shows each kind once, deals real kinds into the hero and gives every player a running time', () => {
    const kinds = SHOWCASE.map((item) => item.kind)
    expect(new Set(kinds).size).toBe(kinds.length)
    expect(HERO_KINDS.every((kind) => kinds.includes(kind))).toBe(true)
    expect(new Set(SHOWCASE.map((item) => `${item.delivered.stage}:${item.delivered.jobId}`)).size).toBe(kinds.length)
    for (const item of SHOWCASE.filter((i) => ['video', 'documentary', 'podcast'].includes(i.kind)))
      expect(item.duration).toMatch(/^\d+:\d\d$/)
  })
})
