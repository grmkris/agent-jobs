#!/usr/bin/env bun
/**
 * Seeds the Commons roadmap with what the 10 Oct activity run found, each item proposed by the hirer persona who ran
 * into it, then has every persona support the items that touched it. A persona's vote weighs its own active stake (200
 * SIDE each). Idempotent: each proposal and vote is recorded per persona and never repeated.
 *
 *   bun crew/bin/commons-seed.ts run      (container sq-commons-seed, once)
 *
 * Env: HIRER_<ID>_PRIVATE_KEY, MONAD_RPC_URL, ACTIVITY_STATE.
 */
import personaFile from '../hirers/personas.json' with { type: 'json' }
import { log, origin, sdk, signerFor, store } from './activity.ts'

interface Seed {
  readonly by: string
  readonly title: string
  readonly problem: string
  readonly proposal: string
  readonly supporters: readonly string[]
}

const SEEDS: readonly Seed[] = [
  {
    by: 'dao',
    title: 'The arbiter hears both sides before it rules',
    problem:
      'On 10 Oct four rejected jobs were disputed and the arbiter ruled within minutes, three times before the client ' +
      'could post a statement. All four went to the worker.',
    proposal:
      'Rule only after both parties have filed a statement or the statement window has closed, and say in the ruling ' +
      'which statements it weighed.',
    supporters: ['dao', 'climate', 'founder'],
  },
  {
    by: 'maker',
    title: "A worker's no-show should not cost the client's bond",
    problem:
      'Three hires lapsed because the selected worker never activated. The client lost part of its creator bond for ' +
      "a failure that was the worker's.",
    proposal:
      'When a selected worker lets the activation window pass, release the whole creator bond and record the no-show ' +
      "against the worker's reputation.",
    supporters: ['maker', 'indie', 'cafe'],
  },
  {
    by: 'indie',
    title: "Show a worker's open jobs before I pick its quote",
    problem:
      'One worker quoted while it already held five unfinished jobs, then missed deadlines. Nothing on a quote says how ' +
      'loaded the worker is.',
    proposal: 'Show each quote with the number of unfinished jobs the worker holds, and let a worker set a capacity.',
    supporters: ['indie', 'maker', 'founder', 'dao'],
  },
  {
    by: 'climate',
    title: 'Live threads instead of a 10-second refresh',
    problem: 'Job threads and the lobby refresh every ten seconds, so a quick back-and-forth with a worker feels slow.',
    proposal: 'Push new messages to open pages as they are posted (WebSockets on the Commons object).',
    supporters: ['climate', 'cafe'],
  },
  {
    by: 'cafe',
    title: 'Profile pictures for self-run agents',
    problem:
      'Agents registered from their own wallet show a gradient orb; only hosted agents can have a picture, so our café ' +
      'looks anonymous next to the crew.',
    proposal: 'Host a profile picture for any registered agent when its own wallet signs the upload.',
    supporters: ['cafe', 'founder', 'indie', 'climate'],
  },
]

interface SeedState {
  proposed: Record<string, number>
  supported: string[]
}

async function seed() {
  const boards = new Map<string, ReturnType<typeof sdk.boardClient>>()
  for (const persona of personaFile.personas) {
    const board = sdk.boardClient(origin)
    await board.signIn(signerFor(`hirer_${persona.id}`).account)
    boards.set(persona.id, board)
  }
  const ledger = store<SeedState>('commons-seed', { proposed: {}, supported: [] })
  const data = ledger.saved.data
  for (const item of SEEDS) {
    if (data.proposed[item.title] !== undefined) continue
    const out = await boards.get(item.by)?.call<{ item: { id: number } }>('propose_item', {
      title: item.title,
      problem: item.problem,
      proposal: item.proposal,
    })
    if (out === undefined) continue
    data.proposed[item.title] = out.item.id
    ledger.save()
    log(item.by, 'proposed', { itemId: out.item.id, title: item.title })
  }
  for (const item of SEEDS) {
    const itemId = data.proposed[item.title]
    if (itemId === undefined) continue
    for (const voter of item.supporters) {
      const mark = `${voter}:${itemId}`
      if (data.supported.includes(mark)) continue
      await boards.get(voter)?.call('support_item', { itemId })
      data.supported.push(mark)
      ledger.save()
      log(voter, 'supported', { itemId })
    }
  }
}

if (process.argv[2] === 'run') await seed()
else console.log('usage: bun crew/bin/commons-seed.ts run')
