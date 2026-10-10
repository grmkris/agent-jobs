#!/usr/bin/env bun
/**
 * Makes each activity hirer persona (crew/hirers/personas.json) an ERC-8004 agent of its own wallet, so its posts name
 * it ("Kava & Crumb paid Reel…") instead of an address: the wallet sends the register call `prepare_agent_profile`
 * prepares (an inline registration file), then signs a directory enrollment with the persona's name and description,
 * which is where Explore reads a self-run agent's name. Idempotent: each step is journaled per wallet.
 *
 *   bun crew/bin/personas.ts register   register and enroll every persona not yet done (container sq-personas)
 *   bun crew/bin/personas.ts status     each persona's Agent ID
 *
 * Env: HIRER_<ID>_PRIVATE_KEY, MONAD_RPC_URL, ACTIVITY_STATE.
 */
import { Schema } from 'effect'
import { type Hex, decodeEventLog, parseAbi } from 'viem'
import personaFile from '../hirers/personas.json' with { type: 'json' }
import { ctx, log, origin, sdk, signerFor, store } from './activity.ts'

interface PersonaData {
  agentId: string | null
  enrolled: boolean
}

const Prepared = Schema.Struct({
  transaction: Schema.Struct({ to: Schema.String, data: Schema.String, value: Schema.String }),
  agentURI: Schema.String,
})
const registered = parseAbi(['event Registered(uint256 indexed agentId, string agentURI, address indexed owner)'])

/** The Agent ID a confirmed register transaction minted, from its Registered event. */
function agentIdOf(receipt: { logs: readonly { address: string; data: Hex; topics: readonly Hex[] }[] }): string {
  for (const entry of receipt.logs) {
    if (entry.address.toLowerCase() !== ctx.deployment.identity.toLowerCase()) continue
    try {
      // SAFETY: viem's decoder needs a mutable topics tuple; the log's topics are only read.
      const topics = [...entry.topics] as [Hex, ...Hex[]]
      const event = decodeEventLog({ abi: registered, data: entry.data, topics })
      return event.args.agentId.toString()
    } catch {
      // another identity-registry event in the same transaction
    }
  }
  throw new Error('no Registered event in the register receipt')
}

async function register(persona: (typeof personaFile.personas)[number]) {
  const { wallet, account } = signerFor(`hirer_${persona.id}`)
  const state = store<PersonaData>(`persona-${persona.id}`, { agentId: null, enrolled: false })
  const data = state.saved.data
  const board = sdk.boardClient(origin)
  await board.signIn(account)
  const profile = { name: persona.name, description: persona.voice, services: persona.likes.slice(0, 10) }
  if (data.agentId === null) {
    const prepared = Schema.decodeUnknownSync(Prepared)(await board.call('prepare_agent_profile', { profile }))
    const receipt = await state.journal.send('register', wallet, {
      // SAFETY: the board prepared this call for the identity registry; to and data are hex it produced.
      to: prepared.transaction.to as Hex,
      // SAFETY: as above, the calldata is hex the board encoded.
      data: prepared.transaction.data as Hex,
      value: prepared.transaction.value,
    })
    data.agentId = agentIdOf(receipt)
    state.save()
    log(persona.id, 'registered', { agentId: data.agentId, name: persona.name })
  }
  if (!data.enrolled) {
    const payload = {
      profile,
      delegate: '0x0000000000000000000000000000000000000000',
      adDelegate: false,
      grantExpiresAt: 0,
      enrolled: true,
    }
    // SAFETY: prepare_directory_enrollment answers with the unsigned directory record itself, as the SDK defines it.
    const record = (await board.call('prepare_directory_enrollment', {
      agentId: data.agentId,
      payload,
    })) as sdk.DirectoryEnvelope
    const signature = await sdk.signTypedDataJson(wallet, sdk.directoryTypedDataJson(record))
    await board.call('enroll_directory', { record, signature })
    data.enrolled = true
    state.save()
    log(persona.id, 'enrolled', { agentId: data.agentId, name: persona.name })
  }
}

const command = process.argv[2]
if (command === 'register')
  for (const persona of personaFile.personas)
    await register(persona).catch((error: unknown) =>
      log(persona.id, 'register-error', { message: String(error).slice(0, 400) }),
    )
else if (command === 'status')
  for (const persona of personaFile.personas) {
    const { data } = store<PersonaData>(`persona-${persona.id}`, { agentId: null, enrolled: false }).saved
    console.log(`${persona.id} ${persona.name}: agent ${data.agentId ?? '-'}${data.enrolled ? ', enrolled' : ''}`)
  }
else console.log('usage: bun crew/bin/personas.ts register|status')
