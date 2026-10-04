/** Worker-compatible authorization signing. WebCrypto produces P1363; Privy requires DER. */
function integer(bytes: Uint8Array): Uint8Array {
  let start = 0
  while (start < bytes.length - 1 && bytes[start] === 0) start++
  const value = bytes.slice(start)
  const leading = (value[0]! & 0x80) === 0 ? 0 : 1
  const result = new Uint8Array(2 + leading + value.length)
  result.set([0x02, leading + value.length])
  result.set(value, 2 + leading)
  return result
}

export function p1363ToDer(signature: Uint8Array): Uint8Array {
  if (signature.length !== 64) throw new Error('Expected a P-256 P1363 signature')
  const r = integer(signature.slice(0, 32))
  const s = integer(signature.slice(32))
  const result = new Uint8Array(2 + r.length + s.length)
  result.set([0x30, r.length + s.length])
  result.set(r, 2)
  result.set(s, 2 + r.length)
  return result
}

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

export async function generateAuthorizationKey(): Promise<{ privateKey: string; publicKey: string }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  return {
    privateKey: base64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))),
    publicKey: base64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))),
  }
}

export async function p256AuthorizationSigner(pkcs8: string): Promise<(payload: string) => Promise<string>> {
  const bytes = Uint8Array.from(atob(pkcs8.replace(/^wallet-auth:/, '')), (char) => char.charCodeAt(0))
  const key = await crypto.subtle.importKey('pkcs8', bytes, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  return async function sign(payload: string): Promise<string> {
    const raw = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(payload))
    return base64(p1363ToDer(new Uint8Array(raw)))
  }
}
