import { expect, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { makeHarness, alice, bob, moderator, maintainer } from './layers.ts'
import { invoke } from './calls.ts'
import { postEvents } from '../src/feed.ts'
import type { Message } from '../src/schema/messages.ts'
import { PostMessageOutput } from '../src/schema/messages.ts'
import { ReportGapOutput } from '../src/schema/gaps.ts'
import { ProposeItemOutput, SetItemStatusOutput } from '../src/schema/roadmap.ts'
import { HideContentOutput } from '../src/schema/roles.ts'
import { PROPOSE_MINIMUM } from '../src/stake.ts'

it('feed recipient precedence is reply > mention > participant, with moderator row separate', () => {
  const message: Message = {
    id: 9,
    subject: 'job:board:task',
    author: alice,
    badges: [],
    body: 'Private body',
    replyTo: 1,
    mentions: [
      { token: 'Name', address: bob },
      { token: 'Self', address: alice },
      { token: 'Mod', address: moderator },
    ],
    hidden: null,
    createdAt: 9,
  }
  const people = { creator: bob, approver: bob, worker: moderator, bidders: [], arbitrator: null, jobId: '42' }
  const events = postEvents(message, people, [moderator, moderator], bob)
  expect(events.map((event) => [event.id, event.kind, event.role])).toEqual([
    [`commons:m9:mod:${moderator}`, 'message.posted', 'moderator'],
    [`commons:m9:${bob}`, 'message.reply', 'author'],
    [`commons:m9:${moderator}`, 'message.mention', 'mentioned'],
  ])
  expect(events.every((event) => event.address !== alice && event.address !== '*')).toBe(true)
})
it.effect.prop(
  'all feed triggers omit random body, title, gap fields and reasons',
  [Schema.String.check(Schema.isMaxCodePoints(20))],
  ([random]) =>
    Effect.gen(function* () {
      const h = yield* makeHarness()
      h.state.stakes.set(alice, PROPOSE_MINIMUM)
      const marker = `user-marker-${random}`
      yield* Effect.gen(function* () {
        const post = yield* invoke('post_message', PostMessageOutput, alice, { subject: 'lobby', body: marker })
        const gap = yield* invoke('report_gap', ReportGapOutput, alice, {
          gap_type: 'error',
          what_i_needed: marker,
          what_i_tried: marker,
          suggestion: marker,
          user_goal: marker,
        })
        const item = yield* invoke('propose_item', ProposeItemOutput, alice, {
          title: marker,
          problem: marker,
          proposal: marker,
          gapIds: [gap.gapId],
        })
        yield* invoke('hide_content', HideContentOutput, moderator, {
          kind: 'message',
          id: post.message.id,
          reason: marker,
        })
        yield* invoke('set_item_status', SetItemStatusOutput, maintainer, {
          itemId: item.item.id,
          status: 'planned',
          reason: marker,
        })
        expect(h.events.some((e) => e.kind === 'message.posted')).toBe(true)
        expect(h.events.some((e) => e.kind === 'gap.reported')).toBe(true)
        expect(h.events.some((e) => e.kind === 'roadmap.proposed')).toBe(true)
        expect(h.events.some((e) => e.kind === 'message.hidden')).toBe(true)
        expect(h.events.some((e) => e.kind === 'roadmap.status')).toBe(true)
        expect(JSON.stringify(h.events)).not.toContain(marker)
        expect(h.events.every((event) => event.next !== undefined)).toBe(true)
      }).pipe(Effect.provide(h.layer))
    }),
)
