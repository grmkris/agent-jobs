/** The EIP-712 JSON wallets sign: `eth_signTypedData_v4` shape, bigints as decimal strings. */
export function typedDataJson(
  domain: Record<string, unknown>,
  types: Record<string, unknown>,
  primaryType: string,
  message: unknown,
): string {
  const domainFields = [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ]
  return JSON.stringify({ types: { EIP712Domain: domainFields, ...types }, primaryType, domain, message }, (_, v) =>
    typeof v === 'bigint' ? v.toString() : v,
  )
}
