/**
 * Creates the board's execution-budget signer (ADR-0005): a fresh P-256 key registered with Privy as a key quorum.
 * Appends BUDGET_SIGNER_QUORUM_ID and BUDGET_SIGNER_PRIVATE_KEY to .env.local and prints only the quorum id; the
 * private half is never logged. Run once per Privy app; a re-run makes a new quorum (every grant must be re-added).
 *
 *   node --env-file=.env.local packages/board/scripts/budget-signer-key.ts
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { generateAuthorizationKey, privyFetch } from '../src/privy.ts'

const appId = process.env.PRIVY_APP_ID
const appSecret = process.env.PRIVY_APP_SECRET
if (!appId || !appSecret) throw new Error('PRIVY_APP_ID and PRIVY_APP_SECRET are required')
if (readFileSync('.env.local', 'utf8').includes('BUDGET_SIGNER_QUORUM_ID=')) throw new Error('.env.local already has a budget signer')

const key = await generateAuthorizationKey()
const quorum = await privyFetch<{ id: string }>(
  { appId, appSecret },
  { method: 'POST', path: '/key_quorums', body: { authorization_threshold: 1, display_name: 'agent-jobs-budget', public_keys: [key.publicKey] } },
)
appendFileSync('.env.local', `\n# Execution-budget signer (ADR-0005), a Privy key quorum\nBUDGET_SIGNER_QUORUM_ID=${quorum.id}\nBUDGET_SIGNER_PRIVATE_KEY=${key.privateKey}\n`)
console.log(`BUDGET_SIGNER_QUORUM_ID=${quorum.id} (private key written to .env.local)`)
