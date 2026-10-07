import type { Address, Hex } from 'viem'
import { isAddress } from 'viem'
import type { AsyncSql } from '@sidequest/indexer'
import type { Network } from '@sidequest/sdk'
import { TelegramError, telegramLinkConfirm, telegramLinkPrepare, telegramStatus, telegramUnlink } from './telegram.ts'

interface TelegramToolDeps {
  sql: AsyncSql
  network: Network
  configured: boolean
  now: () => number
  verify: (input: { address: Address; message: string; signature: Hex }) => Promise<boolean>
}

interface TelegramTool {
  description: string
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] }
  run: (deps: TelegramToolDeps, caller: Address | undefined, args: Record<string, unknown>) => Promise<unknown>
}

const walletSchema = { type: 'object' as const, properties: { wallet: { type: 'string', description: 'Your signed-in wallet.' } }, required: ['wallet'] }
function explicitWallet(caller: Address | undefined, input: unknown): Address {
  if (input === undefined) throw new TelegramError('invalid', 'wallet is required')
  return wallet(caller, input)
}
function wallet(caller: Address | undefined, input?: unknown): Address {
  if (caller === undefined) throw new TelegramError('forbidden', 'Sign in before managing a Telegram link')
  if (input !== undefined && (typeof input !== 'string' || !isAddress(input) || input.toLowerCase() !== caller.toLowerCase())) throw new TelegramError('forbidden', 'Manage only your signed-in wallet’s Telegram link')
  return caller
}

export const telegramTools: Record<string, TelegramTool> = {
  telegram_status: {
    description: 'Your wallet’s Telegram link status. Sign-in required; no money moves.', inputSchema: walletSchema,
    run: async (deps, caller, args) => telegramStatus(deps.sql, deps.network, explicitWallet(caller, args.wallet)),
  },
  telegram_link_prepare: {
    description: 'Prepare a wallet-link message. Sign it, confirm it, then open the bot’s deep link.', inputSchema: walletSchema,
    run: async (deps, caller, args) => {
      const me = explicitWallet(caller, args.wallet)
      if (!deps.configured) throw new TelegramError('unavailable', 'Telegram is not configured yet')
      return telegramLinkPrepare(deps.sql, deps.network, me, deps.now())
    },
  },
  telegram_link_confirm: {
    description: 'Verify your wallet signature and store a pending link; /start <nonce> in the bot completes it.',
    inputSchema: { type: 'object', properties: { nonce: { type: 'string' }, signature: { type: 'string' } }, required: ['nonce', 'signature'] },
    run: async (deps, caller, args) => {
      const me = wallet(caller)
      if (!deps.configured) throw new TelegramError('unavailable', 'Telegram is not configured yet')
      return telegramLinkConfirm(deps.sql, deps.network, me, String(args.nonce ?? ''), String(args.signature ?? ''), deps.now(), deps.verify)
    },
  },
  telegram_unlink: {
    description: 'Remove your wallet’s Telegram link and cancel queued job notifications.', inputSchema: walletSchema,
    run: async (deps, caller, args) => telegramUnlink(deps.sql, deps.network, explicitWallet(caller, args.wallet)),
  },
}
