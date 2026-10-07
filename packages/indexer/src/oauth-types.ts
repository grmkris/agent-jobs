export interface OAuthGrant {
  readonly owner: string
  readonly scopes: readonly string[]
  readonly agentIds: readonly string[]
  readonly resource: string
  readonly clientId: string
  readonly address: string
  readonly registryAgentId: string | null
  readonly chainId: number
  readonly grantId?: string
}
