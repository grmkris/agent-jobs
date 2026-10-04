/**
 * The board's `eth_signTypedData_v4` JSON as wagmi's `signTypedData` takes it: the domain type dropped (wagmi derives
 * it) and the primary type's integer fields as bigints.
 */
export function typedDataArgs(json: string) {
  const parsed = JSON.parse(json) as {
    types: Record<string, Array<{ name: string; type: string }>>
    primaryType: string
    domain: Record<string, unknown>
    message: Record<string, unknown>
  }
  const { EIP712Domain: _domain, ...types } = parsed.types
  const message = { ...parsed.message }
  for (const f of types[parsed.primaryType] ?? []) {
    if (/^u?int\d*$/.test(f.type) && typeof message[f.name] === 'string') message[f.name] = BigInt(message[f.name] as string)
  }
  return { domain: parsed.domain, types, primaryType: parsed.primaryType, message } as never
}
