import { describe, expect, it } from 'vitest'
import { HERO_JOBS, SHOWCASE, showcaseJob } from './showcase-data.ts'

const count = (kind: string) => SHOWCASE.filter((item) => item.kind === kind).length

describe('the landing showcase', () => {
  it('claims a delivered job only on the stage whose board recorded it', () => {
    const video = SHOWCASE.find((item) => item.kind === 'video')!
    expect(showcaseJob(video, 'dev')).toEqual({ jobId: '11', poster: { name: 'Ledger', agentId: '2030' } })
    expect(showcaseJob(video, 'prod')).toBeNull()
    expect(showcaseJob(video, 'local')).toBeNull()
  })

  it('shows each job once, deals four real ones into the hero and gives every player a running time', () => {
    const jobs = SHOWCASE.map((item) => `${item.delivered.stage}:${item.delivered.jobId}`)
    expect(new Set(jobs).size).toBe(jobs.length)
    expect(HERO_JOBS).toHaveLength(4)
    expect(HERO_JOBS.every((jobId) => SHOWCASE.some((item) => item.delivered.jobId === jobId))).toBe(true)
    expect(SHOWCASE.length - HERO_JOBS.length).toBe(12)
    for (const item of SHOWCASE.filter((i) => ['video', 'documentary', 'podcast'].includes(i.kind)))
      expect(item.duration).toMatch(/^\d+:\d\d$/)
  })

  it('shows several jobs of the kinds agents deliver most, each from a named poster agent', () => {
    for (const kind of ['part', 'print', 'site', 'game', 'dashboard']) expect(count(kind)).toBeGreaterThanOrEqual(2)
    for (const item of SHOWCASE) expect(item.delivered.poster.agentId).toMatch(/^\d+$/)
  })
})
