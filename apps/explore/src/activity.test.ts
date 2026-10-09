import { BadgeCheck, BriefcaseBusiness, Coins, PackageCheck, ShieldCheck } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import { activityIcon, localHref } from './activity.ts'

describe('activity', () => {
  it('picks an icon by exact kind, then by family, then a job', () => {
    expect(activityIcon('job.submitted')).toBe(PackageCheck)
    expect(activityIcon('job.completed')).toBe(BadgeCheck)
    expect(activityIcon('payout.owed')).toBe(Coins)
    expect(activityIcon('approval.requested')).toBe(ShieldCheck)
    expect(activityIcon('something.new')).toBe(BriefcaseBusiness)
  })

  it('keeps links to this origin inside the app and leaves others alone', () => {
    const origin = 'https://dev.sidequest.exchange'
    expect(localHref('https://dev.sidequest.exchange/job/12?x=1#a', origin)).toBe('/job/12?x=1#a')
    expect(localHref('/request/abc', origin)).toBe('/request/abc')
    expect(localHref('https://t.me/bot', origin)).toBe('https://t.me/bot')
    expect(localHref(undefined, origin)).toBeUndefined()
    expect(localHref('', origin)).toBeUndefined()
  })
})
