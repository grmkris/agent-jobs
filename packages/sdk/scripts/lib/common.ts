/**
 * Helpers every live script shares: required env vars, logging with a clock, pass/fail checks, and sending a board's
 * transactions from a wallet while reporting each hash back to the board.
 */
import * as sdk from '../../src/index.ts'

/** A required env var (or its fallback); throws naming the variable when neither is set. */
export function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback
  if (v === undefined || v === '') throw new Error(`${name} is not set`)
  return v
}

export const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000))

/** `[hh:mm:ss who] message` */
export const log = (who: string, m: string) => console.log(`[${new Date().toISOString().slice(11, 19)} ${who}] ${m}`)

/** Pass/fail lines; `checks.done()` prints the tally and exits non-zero on any failure. */
export const checks = {
  failures: 0,
  check(what: string, ok: boolean, detail = '') {
    if (!ok) this.failures++
    log('check', `${ok ? '✓' : '✗'} ${what}${detail === '' ? '' : `: ${detail}`}`)
  },
  done(): never {
    console.log(this.failures === 0 ? 'all checks passed' : `${this.failures} check(s) failed`)
    process.exit(this.failures === 0 ? 0 : 1)
  },
}
export const check = (what: string, ok: boolean, detail = '') => checks.check(what, ok, detail)

export const txUrl = (h: string) => `https://testnet.monadscan.com/tx/${h}`

/**
 * Sends a board's transactions from `w`, logs each with its explorer link and reports it to the board. Several go
 * out as one EIP-7702 batch through `batchDelegate` (the deployment's `Simple7702Account`) unless BATCH=0.
 */
export async function sendReported(
  board: ReturnType<typeof sdk.boardClient>,
  w: sdk.Wallet,
  publicClient: Parameters<typeof sdk.sendBatch>[1],
  taskId: string,
  txs: sdk.TxRequest[],
  who: string,
  batchDelegate?: `0x${string}`,
): Promise<string[]> {
  const batch = batchDelegate !== undefined && txs.length > 1 && process.env.BATCH !== '0'
  const hashes = batch ? [await sdk.sendBatch(w, publicClient, txs, batchDelegate)] : await sdk.sendAll(w, publicClient, txs)
  const what = txs.map((t) => t.description)
  for (const [i, h] of hashes.entries()) {
    log(who, `${batch ? `batch of ${txs.length} (${what.join(' + ')})` : what[i]} → ${txUrl(h)}`)
    await board.call('report_transaction', { taskId, txHash: h })
  }
  return hashes
}
