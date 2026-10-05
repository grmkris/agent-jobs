/** A JWT proves the Privy user; the user API binds that user to the embedded operator account. */
import { privyUser } from './privy-identity.ts'

export async function privyOperator(input: { token: string; appId: string; appSecret: string; operator: string; now: number }): Promise<string | undefined> {
  const user = await privyUser(input)
  if (user === undefined || input.appSecret === '' || input.appSecret === 'unset') return undefined
  const response = await fetch(`https://api.privy.io/v1/users/${encodeURIComponent(user.sub)}`, {
    headers: { authorization: `Basic ${btoa(`${input.appId}:${input.appSecret}`)}`, 'privy-app-id': input.appId },
    redirect: 'manual', signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) return undefined
  const data = await response.json() as { id?: string; linked_accounts?: Array<{ type?: string; address?: string; wallet_client_type?: string; wallet_index?: number | null }> }
  if (data.id !== user.sub || !Array.isArray(data.linked_accounts)) return undefined
  const operator = data.linked_accounts.some(account => account.type === 'wallet' && account.wallet_client_type === 'privy'
    && (account.wallet_index === 0 || account.wallet_index === null || account.wallet_index === undefined) && account.address?.toLowerCase() === input.operator.toLowerCase())
  return operator ? user.sub : undefined
}
