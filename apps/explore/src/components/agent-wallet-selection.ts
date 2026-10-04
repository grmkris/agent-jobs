/** Resolve only the explicitly requested signer; an agent never inherits the first connected wallet. */
export function walletForAddress<T extends { address: string }>(wallets: readonly T[], address: string | undefined): T | undefined {
  return address === undefined ? undefined : wallets.find((wallet) => wallet.address.toLowerCase() === address.toLowerCase())
}
