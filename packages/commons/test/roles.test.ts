import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { makeHarness, alice, moderator, maintainer, arbiter } from './layers.ts'
import { invoke } from './calls.ts'
import { toolSpecs, runTool } from '../src/tools.ts'
import { HideContentOutput, UnhideContentOutput, ListRolesOutput } from '../src/schema/roles.ts'
import { PostMessageOutput, ListMessagesOutput } from '../src/schema/messages.ts'
import { SetItemStatusOutput } from '../src/schema/roadmap.ts'
import { migrate } from '../src/sql/schema.ts'
import { errorCode } from '../src/errors.ts'

it.effect('migration runs twice without replacing seed or adding another seed', () =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    h.sql.run("UPDATE commons_items SET status='planned' WHERE id=1")
    migrate(h.sql, maintainer, 99)
    expect(
      h.sql.all<{ title: string; status: string; proposer: string }>('SELECT title,status,proposer FROM commons_items'),
    ).toEqual([{ title: 'Roles voted in by stakers', status: 'planned', proposer: maintainer }])
  }),
)
it.effect('message hide and unhide persist full audit log and cursor pages', () =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    yield* Effect.gen(function* () {
      const post = yield* invoke('post_message', PostMessageOutput, moderator, {
        subject: 'lobby',
        body: 'Visible message',
      })
      const hidden = yield* invoke('hide_content', HideContentOutput, moderator, {
        kind: 'message',
        id: post.message.id,
        reason: 'Spam content',
      })
      const listing = yield* invoke('list_messages', ListMessagesOutput, undefined, { subject: 'lobby' })
      expect(listing.messages[0]?.body).toBeNull()
      expect(listing.messages[0]?.hidden).toEqual(hidden.hidden)
      expect(h.events.at(-1)?.id).toBe('commons:h1')
      yield* invoke('unhide_content', UnhideContentOutput, maintainer, {
        kind: 'message',
        id: post.message.id,
        reason: 'Content reviewed',
      })
      expect(
        (yield* invoke('list_messages', ListMessagesOutput, undefined, { subject: 'lobby' })).messages[0]?.body,
      ).toBe('Visible message')
      const first = yield* invoke('list_roles', ListRolesOutput, alice, { limit: 1 })
      expect(first.log[0]).toMatchObject({
        seq: 1,
        actor: moderator,
        role: 'moderator',
        action: 'hide',
        reason: 'Spam content',
      })
      expect(first.cursor).toBe('c:1')
      expect(first.hasMore).toBe(true)
      const second = yield* invoke('list_roles', ListRolesOutput, maintainer, { cursor: first.cursor, limit: 1 })
      expect(second.log[0]?.action).toBe('unhide')
      expect(second.viewer?.roles).toEqual(['maintainer'])
    }).pipe(Effect.provide(h.layer))
  }),
)
it.effect.each([alice, arbiter])('role writes forbid unauthorized holder %s', (caller) =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    yield* Effect.gen(function* () {
      expect(
        (yield* invoke('hide_content', HideContentOutput, caller, { kind: 'item', id: 1, reason: 'Do not allow' }).pipe(
          Effect.flip,
        ))._tag,
      ).toBe('Forbidden')
      expect(
        (yield* invoke('set_item_status', SetItemStatusOutput, caller, {
          itemId: 1,
          status: 'planned',
          reason: 'Do not allow',
        }).pipe(Effect.flip))._tag,
      ).toBe('Forbidden')
      expect(h.sql.all('SELECT * FROM commons_role_log')).toHaveLength(0)
    }).pipe(Effect.provide(h.layer))
  }),
)
it.effect('moderator cannot perform maintainer-only actions and missing content rolls back log', () =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    yield* Effect.gen(function* () {
      expect(
        (yield* invoke('set_item_status', SetItemStatusOutput, moderator, {
          itemId: 1,
          status: 'planned',
          reason: 'Not allowed',
        }).pipe(Effect.flip))._tag,
      ).toBe('Forbidden')
      expect(
        (yield* invoke('hide_content', HideContentOutput, moderator, {
          kind: 'message',
          id: 999,
          reason: 'Missing target',
        }).pipe(Effect.flip))._tag,
      ).toBe('NotFound')
      expect(h.sql.all('SELECT * FROM commons_role_log')).toHaveLength(0)
    }).pipe(Effect.provide(h.layer))
  }),
)
it.effect('status notifications dedupe proposer and supporters and cap supporter recipients at 100', () =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    for (let n = 0; n < 102; n++)
      h.sql.run('INSERT INTO commons_supports VALUES(1,?,?,NULL)', `0x${n.toString(16).padStart(40, '0')}`, n)
    h.sql.run('INSERT INTO commons_supports VALUES(1,?,0,NULL)', maintainer)
    yield* invoke('set_item_status', SetItemStatusOutput, maintainer, {
      itemId: 1,
      status: 'planned',
      reason: 'Build next',
    }).pipe(Effect.provide(h.layer))
    const events = h.events.filter((e) => e.kind === 'roadmap.status')
    expect(events).toHaveLength(100)
    expect(new Set(events.map((e) => e.address)).size).toBe(100)
    expect(events.every((e) => e.id.startsWith('commons:i1:s1:'))).toBe(true)
  }),
)
it.effect.each(Object.keys(toolSpecs).filter((name) => name !== 'list_roles'))(
  'Disabled applies to %s before input decoding',
  (name) =>
    Effect.gen(function* () {
      const h = yield* makeHarness()
      h.state.enabled = false
      const error = yield* runTool(name, alice, {}).pipe(Effect.flip, Effect.provide(h.layer))
      expect(error._tag).toBe('Disabled')
      expect(errorCode(error)).toBe('unavailable')
    }),
)
it.effect('disabled list_roles exposes only its disabled shape', () =>
  Effect.gen(function* () {
    const h = yield* makeHarness()
    h.state.enabled = false
    expect(yield* invoke('list_roles', ListRolesOutput, undefined, {}).pipe(Effect.provide(h.layer))).toEqual({
      enabled: false,
      roles: [],
      log: [],
      cursor: null,
      hasMore: false,
      viewer: null,
    })
  }),
)
