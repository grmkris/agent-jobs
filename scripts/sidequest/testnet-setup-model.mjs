import { getAddress, keccak256, stringToHex } from 'viem'

export function parseSetupArgs(args) {
  const [command, flag, generation] = args
  if (
    args.length !== 3 ||
    !['fund', 'rewards', 'faucet', 'safe'].includes(command) ||
    flag !== '--generation' ||
    !/^[a-z0-9][a-z0-9-]{0,31}$/u.test(generation ?? '')
  ) {
    throw new Error('usage: testnet-setup.mjs <fund|rewards|faucet|safe> --generation <label>')
  }
  return { command, generation }
}

export const setupOperationId = (name, generation) => `${name}-${generation}`
export const safeNonce = (generation) => BigInt(keccak256(stringToHex(`sidequest-safe:${generation}`)))

/** The Safe survives a config reset: the recipe's top-level sidequest.safe stays present. */
export async function existingSafe(config, client) {
  const safe = config.sidequest?.safe ?? config.deployment?.sidequest?.safe
  if (!safe) return null
  const code = await client.getCode({ address: getAddress(safe) })
  if (!code || code === '0x') throw new Error('configured-safe-has-no-code')
  return getAddress(safe)
}
