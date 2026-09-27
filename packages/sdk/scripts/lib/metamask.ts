/**
 * The MetaMask Agent Wallet (`mm` CLI, server-wallet mode) as a signer for scripts. On Monad testnet MetaMask's
 * infrastructure signs (EIP-191 and EIP-712) but does not send: its RPC and fee service answer "Invalid chainId" for
 * 10143 (reality-check.md). So on testnet this wallet takes the sign-only routes: an ERC-8004 agent wallet set by
 * signature, board sign-in, and a contest entry whose award pays it with no transaction of its own.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { type Address, type Hex, getAddress } from 'viem'

const run = promisify(execFile)

async function mm(args: string[], signing = true): Promise<Record<string, string>> {
  const flags = signing ? ['--json', '--wait', '--wallet-timeout', '120'] : ['--json']
  const { stdout } = await run('mm', [...args, ...flags], { maxBuffer: 1 << 20 })
  const body = JSON.parse(stdout) as { ok: boolean; data?: Record<string, string>; error?: { code: string; message: string } }
  if (!body.ok || body.data === undefined) throw new Error(`mm ${args[1]}: ${body.error?.code} ${body.error?.message}`)
  return body.data
}

export async function metamaskAddress(): Promise<Address> {
  return getAddress((await mm(['wallet', 'address'], false)).address as string)
}

export async function metamaskSignMessage(message: string, chainId: number): Promise<Hex> {
  return (await mm(['wallet', 'sign-message', '--message', message, '--chain-id', String(chainId)])).signature as Hex
}

/** `typedData` is the `eth_signTypedData_v4` JSON (with EIP712Domain), exactly what the board returns. */
export async function metamaskSignTypedData(typedData: string, chainId: number): Promise<Hex> {
  return (await mm(['wallet', 'sign-typed-data', '--payload', typedData, '--chain-id', String(chainId)])).signature as Hex
}
