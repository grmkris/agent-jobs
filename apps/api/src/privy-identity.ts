/** Verify Privy JWT ownership without forwarding a wallet signing credential. */
const decode = (value: string) =>
  Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
type PrivyJwk = {
  kty?: string
  crv?: string
  kid?: string
  x?: string
  y?: string
  alg?: string
  use?: string
  ext?: boolean
}
const jwksCache = new Map<string, { expires: number; keys: PrivyJwk[] }>()
export async function privyUser(input: {
  token: string
  appId: string
  now: number
}): Promise<{ sub: string; token: string } | undefined> {
  try {
    if (!input.appId) return undefined
    const parts = input.token.split('.')
    if (parts.length !== 3) return undefined
    const header = JSON.parse(new TextDecoder().decode(decode(parts[0]!))) as { alg?: string; kid?: string }
    const claims = JSON.parse(new TextDecoder().decode(decode(parts[1]!))) as {
      iss?: string
      aud?: string | string[]
      sub?: string
      exp?: number
      nbf?: number
    }
    if (
      header.alg !== 'ES256' ||
      claims.iss !== 'privy.io' ||
      !(claims.aud === input.appId || (Array.isArray(claims.aud) && claims.aud.includes(input.appId))) ||
      typeof claims.sub !== 'string' ||
      !claims.sub.startsWith('did:privy:') ||
      typeof claims.exp !== 'number' ||
      claims.exp <= input.now ||
      (claims.nbf !== undefined && claims.nbf > input.now + 30)
    )
      return undefined
    let cached = jwksCache.get(input.appId)
    if (!cached || cached.expires < input.now) {
      const response = await fetch(`https://auth.privy.io/api/v1/apps/${encodeURIComponent(input.appId)}/jwks.json`, {
        redirect: 'manual',
      })
      if (!response.ok) return undefined
      const data = (await response.json()) as { keys?: PrivyJwk[] }
      if (!Array.isArray(data.keys)) return undefined
      cached = { keys: data.keys, expires: input.now + 300 }
      jwksCache.set(input.appId, cached)
    }
    const jwk = cached.keys.find(
      (k) =>
        k.kty === 'EC' && k.crv === 'P-256' && (!header.kid || (k as PrivyJwk & { kid?: string }).kid === header.kid),
    )
    if (!jwk) return undefined
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    if (
      !(await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        decode(parts[2]!),
        new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
      ))
    )
      return undefined
    return { sub: claims.sub, token: input.token }
  } catch {
    return undefined
  }
}
export async function verifyPrivyWallet(input: {
  token: string
  appId: string
  appSecret: string
  operator: string
  walletAddress: string
  walletId: string
  now: number
}): Promise<boolean> {
  const user = await privyUser(input)
  if (!user || !input.appSecret) return false
  const headers = { authorization: `Basic ${btoa(`${input.appId}:${input.appSecret}`)}`, 'privy-app-id': input.appId }
  const response = await fetch(`https://api.privy.io/v1/users/${encodeURIComponent(user.sub)}`, {
    headers,
    redirect: 'manual',
  })
  if (!response.ok) return false
  const data = (await response.json()) as {
    id?: string
    linked_accounts?: {
      type?: string
      address?: string
      wallet_client_type?: string
      wallet_id?: string
      id?: string
    }[]
  }
  if (data.id !== user.sub || !Array.isArray(data.linked_accounts)) return false
  const wallets = data.linked_accounts.filter((a) => a.type === 'wallet')
  if (!wallets.some((w) => w.address?.toLowerCase() === input.operator.toLowerCase())) return false
  if (
    !wallets.some(
      (w) => w.address?.toLowerCase() === input.walletAddress.toLowerCase() && w.wallet_client_type === 'privy',
    )
  )
    return false
  const walletResponse = await fetch(`https://api.privy.io/v1/wallets/${encodeURIComponent(input.walletId)}`, {
    headers,
    redirect: 'manual',
  })
  if (!walletResponse.ok) return false
  const wallet = (await walletResponse.json()) as { id?: string; address?: string }
  return wallet.id === input.walletId && wallet.address?.toLowerCase() === input.walletAddress.toLowerCase()
}
