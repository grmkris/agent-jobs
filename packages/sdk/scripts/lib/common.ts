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

/** Sends a board's transactions in order from `w`, logs each with its explorer link and reports it to the board. */
export async function sendReported(
  board: ReturnType<typeof sdk.boardClient>,
  w: sdk.Wallet,
  publicClient: Parameters<typeof sdk.sendAll>[1],
  taskId: string,
  txs: sdk.TxRequest[],
  who: string,
): Promise<string[]> {
  const hashes = await sdk.sendAll(w, publicClient, txs)
  for (const [i, h] of hashes.entries()) {
    log(who, `${txs[i]?.description} → ${txUrl(h)}`)
    await board.call('report_transaction', { taskId, txHash: h })
  }
  return hashes
}
