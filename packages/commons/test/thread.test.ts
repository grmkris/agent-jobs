import { expect, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import { makeHarness, alice, bob, moderator, maintainer, arbiter } from './layers.ts'
import { runTool } from '../src/tools.ts'
import { POST_MINIMUM } from '../src/stake.ts'
import { getDisputeThread } from '../src/thread/dispute.ts'
import { PostMessageOutput, ListMessagesOutput } from '../src/schema/messages.ts'

const post = (caller: string, subject = 'lobby', body = 'Hello', replyTo?: number) =>
  runTool('post_message', caller, { subject, body, replyTo }).pipe(
    Effect.map(Schema.decodeUnknownSync(PostMessageOutput)),
  )
const list = (caller: string | undefined, args: unknown) =>
  runTool('list_messages', caller, args).pipe(Effect.map(Schema.decodeUnknownSync(ListMessagesOutput)))

it.effect.each([POST_MINIMUM - 1n, POST_MINIMUM])('post gate at %s', (stake) =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    h.state.stakes.set(alice, stake)
    yield* Effect.gen(function* () {
      const result = yield* post(alice).pipe(Effect.result)
      expect(result._tag).toBe(stake === POST_MINIMUM ? 'Success' : 'Failure')
      expect(h.sql.all('SELECT * FROM commons_messages')).toHaveLength(stake === POST_MINIMUM ? 1 : 0)
    }).pipe(Effect.provide(h.layer))
  }),
)
it.effect('backing passes, mentions resolve and snapshot badges persist', () =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    h.state.backing.set(alice, [{ account: bob, value: POST_MINIMUM }])
    h.state.directory.set('name', bob)
    yield* Effect.gen(function* () {
      const { message } = yield* post(alice, 'lobby', `@Name @name @${bob}`)
      expect(message.badges).toContainEqual({ kind: 'backer', of: bob, amount: POST_MINIMUM.toString() })
      expect(message.mentions).toHaveLength(2)
      expect(h.events.filter((e) => e.address === bob)).toHaveLength(1)
      expect(h.events.some((e) => e.address === '*')).toBe(false)
    }).pipe(Effect.provide(h.layer))
  }),
)
it.effect.each([moderator, maintainer, arbiter])('role bypass %s', (caller) =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    h.state.failStake = true
    yield* Effect.gen(function* () {
      yield* post(caller)
      expect((yield* list(caller, { subject: 'lobby' })).viewer?.canPost).toBe(true)
      expect(h.sql.all('SELECT * FROM commons_messages')).toHaveLength(1)
    }).pipe(Effect.provide(h.layer))
  }),
)
it.effect.each(['creator', 'approver', 'worker', 'bidder'])('participant bypass %s', (role) =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    h.state.failStake = true
    const people = { creator: bob, approver: bob, worker: bob, bidders: [bob], arbitrator: arbiter, jobId: '42' }
    if (role === 'bidder') people.bidders = [alice]
    else if (role === 'creator') people.creator = alice
    else if (role === 'approver') people.approver = alice
    else people.worker = alice
    h.state.people.set('job:board:task', people)
    yield* Effect.gen(function* () {
      yield* post(alice, 'job:board:task')
      expect((yield* list(alice, { subject: 'job:board:task' })).viewer?.canPost).toBe(true)
      expect(h.sql.all('SELECT * FROM commons_messages')).toHaveLength(1)
    }).pipe(Effect.provide(h.layer))
  }),
)
it.effect('replies flatten, preserve immediate recipient and reject hidden or cross-subject targets', () =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    h.state.stakes.set(alice, POST_MINIMUM)
    h.state.stakes.set(bob, POST_MINIMUM)
    yield* Effect.gen(function* () {
      const root = (yield* post(alice)).message
      const child = (yield* post(bob, 'lobby', 'Reply', root.id)).message
      const reply = (yield* post(alice, 'lobby', `@${bob}`, child.id)).message
      expect(reply.replyTo).toBe(root.id)
      expect(h.events.find((e) => e.id === `commons:m${reply.id}:${bob}`)?.kind).toBe('message.reply')
      const cross = yield* post(alice, 'roadmap:1', 'Wrong', root.id).pipe(Effect.result)
      expect(cross._tag).toBe('Failure')
      h.sql.run(
        'UPDATE commons_messages SET hidden_at=1,hidden_role=?,hidden_reason=?,hidden_log_seq=1 WHERE seq=?',
        'moderator',
        'Spam',
        root.id,
      )
      expect((yield* post(alice, 'lobby', 'Wrong', child.id).pipe(Effect.result))._tag).toBe('Failure')
      expect((yield* list(undefined, { subject: 'lobby' })).messages[0]?.body).toBeNull()
    }).pipe(Effect.provide(h.layer))
  }),
)
it.effect('tail and both paging directions return ascending messages', () =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    yield* Effect.gen(function* () {
      for (let n = 0; n < 6; n++) yield* post(moderator, 'lobby', `Message ${n}`)
      const tail = yield* list(undefined, { subject: 'lobby', limit: 2 })
      expect(tail.messages.map((m) => m.id)).toEqual([5, 6])
      expect(tail.hasMore).toBe(true)
      const older = yield* list(undefined, { subject: 'lobby', before: 'c:5', limit: 2 })
      expect(older.messages.map((m) => m.id)).toEqual([3, 4])
      expect(older.cursor).toBe('c:3')
      const newer = yield* list(undefined, { subject: 'lobby', after: 'c:2', limit: 2 })
      expect(newer.messages.map((m) => m.id)).toEqual([3, 4])
      expect(newer.cursor).toBe('c:4')
    }).pipe(Effect.provide(h.layer))
  }),
)
it.effect('rate failures roll back, and stake cache expires at 60 seconds', () =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    h.state.stakes.set(alice, POST_MINIMUM)
    yield* Effect.gen(function* () {
      for (let n = 0; n < 6; n++) yield* post(alice)
      expect((yield* post(alice).pipe(Effect.result))._tag).toBe('Failure')
      expect(h.state.stakeCalls).toHaveLength(1)
      yield* TestClock.adjust(60_000)
      yield* post(alice)
      expect(h.state.stakeCalls).toHaveLength(2)
      expect(h.sql.all('SELECT * FROM commons_messages')).toHaveLength(7)
    }).pipe(Effect.provide(h.layer))
  }),
)
it.effect('dispute context includes newest 100 messages with hidden bodies null', () =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    for (let n = 0; n < 105; n++)
      h.sql.run(
        `INSERT INTO commons_messages(subject,subject_kind,author,badges_json,body,mentions_json,created_at) VALUES('job:board:task','job',?,'[]',?,'[]',?)`,
        alice,
        `Body ${n}`,
        n,
      )
    h.sql.run(
      "UPDATE commons_messages SET hidden_at=1,hidden_role='moderator',hidden_reason='Spam',hidden_log_seq=1 WHERE seq=105",
    )
    const thread = yield* getDisputeThread('board', 'task').pipe(Effect.provide(h.layer))
    expect(thread).toHaveLength(100)
    expect(thread[0]?.id).toBe(6)
    expect(thread.at(-1)?.body).toBeNull()
  }),
)
it.effect('rejects more than five mentions and missing authority without writing', () =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    yield* Effect.gen(function* () {
      expect((yield* post(moderator, 'lobby', '@a @b @c @d @e @f').pipe(Effect.result))._tag).toBe('Failure')
      expect((yield* Effect.result(runTool('post_message', undefined, { subject: 'lobby', body: 'Hello' })))._tag).toBe(
        'Failure',
      )
      expect(h.sql.all('SELECT * FROM commons_messages')).toHaveLength(0)
    }).pipe(Effect.provide(h.layer))
  }),
)
